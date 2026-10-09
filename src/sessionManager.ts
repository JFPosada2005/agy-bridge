// Branch selection + delta prompts + chunked bootstrap (Phase 1).
//
// Pure selection logic (exported + unit-tested) over SessionRecord ledgers of
// canonical digests. Side effects (record mutation + persistence) stay in the
// small `confirm`/`create` helpers; the server owns locking and spawning.

import { sha1Hex } from './digests';
import {
  MAX_BRANCHES,
  freshSessionRecord,
  newBranchID,
  type BranchOrigin,
  type BranchRecord,
  type SessionRecord,
} from './sessionStore';

export type SelectionKind = 'replay' | 'delta' | 'bootstrap';

export interface BranchSelection {
  kind: SelectionKind;
  /** Live branch for replay/delta; undefined for bootstrap. */
  branch?: BranchRecord;
  /** Index into incomingDigests where the unsent delta starts. */
  deltaStart: number;
  /** Bootstrap origin when kind is bootstrap. */
  origin?: BranchOrigin;
  /** A provisional tail was confirmed by the incoming echo. */
  confirmedProvisional: boolean;
  /** Branch is dirty: the delta prompt must carry the repair note. */
  needsRepair: boolean;
}

function isStrictOrExactPrefix(ledger: string[], incoming: string[]): boolean {
  if (ledger.length > incoming.length) {
    return false;
  }
  for (let index = 0; index < ledger.length; index += 1) {
    if (ledger[index] !== incoming[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Confirm a provisional tail: when the incoming history echoes OUR last
 * assistant response right after the ledger head, the provisional digest
 * becomes confirmed ledger. Returns true when confirmed (mutates branch).
 */
export function confirmProvisionalTail(branch: BranchRecord, incoming: string[]): boolean {
  const provisional = branch.provisional;
  if (!provisional) {
    return false;
  }
  if (incoming[branch.ledger.length] === provisional.deltaDigest) {
    branch.ledger.push(provisional.deltaDigest);
    delete branch.provisional;
    return true;
  }
  return false;
}

/**
 * Longest ledger that is a prefix of the incoming digests wins.
 * Exact-equal + stored lastResponse -> replay (idempotent retry, NO spawn).
 * Exact-equal without lastResponse -> empty delta with repair (re-push).
 * No prefix -> bootstrap (origin initial when no branches, else divergence).
 */
export function selectBranch(record: SessionRecord, incoming: string[]): BranchSelection {
  let confirmedAny = false;
  for (const branch of liveBranches(record)) {
    if (confirmProvisionalTail(branch, incoming)) {
      confirmedAny = true;
    }
  }
  let best: BranchRecord | undefined;
  for (const branch of liveBranches(record)) {
    if (!isStrictOrExactPrefix(branch.ledger, incoming)) {
      continue;
    }
    if (!best || branch.ledger.length > best.ledger.length) {
      best = branch;
    }
  }
  if (!best) {
    return {
      kind: 'bootstrap',
      deltaStart: 0,
      origin: liveBranches(record).length === 0 ? 'initial' : 'divergence',
      confirmedProvisional: confirmedAny,
      needsRepair: false,
    };
  }
  touchBranch(record, best);
  if (best.ledger.length === incoming.length) {
    if (best.lastResponse !== undefined) {
      return {
        kind: 'replay',
        branch: best,
        deltaStart: incoming.length,
        confirmedProvisional: confirmedAny,
        needsRepair: false,
      };
    }
    return {
      kind: 'delta',
      branch: best,
      deltaStart: incoming.length,
      confirmedProvisional: confirmedAny,
      needsRepair: true,
    };
  }
  return {
    kind: 'delta',
    branch: best,
    deltaStart: best.ledger.length,
    confirmedProvisional: confirmedAny,
    needsRepair: best.dirty === true,
  };
}

/** LRU touch: most-recently-used branch moves to the end. */
export function touchBranch(record: SessionRecord, branch: BranchRecord): void {
  branch.updatedAt = new Date().toISOString();
  const index = record.branches.indexOf(branch);
  if (index >= 0) {
    record.branches.splice(index, 1);
    record.branches.push(branch);
  }
  record.activeBranchID = branch.branchID;
}

/**
 * Create a branch, tombstone LRU extras beyond MAX_BRANCHES, set active.
 * Returns the new branch. Tombstoning (not deletion) keeps lineage for
 * unververt flows; tombstoned branches never match selection.
 */
export function createBranch(
  record: SessionRecord,
  origin: BranchOrigin,
  init: Partial<BranchRecord> = {},
): BranchRecord {
  const now = new Date().toISOString();
  const branch: BranchRecord = {
    branchID: init.branchID ?? newBranchID(),
    agyConversationID: init.agyConversationID ?? '',
    agyVersion: init.agyVersion ?? null,
    modelFamily: init.modelFamily ?? 'unknown',
    effort: init.effort ?? null,
    epoch: init.epoch ?? record.epoch,
    origin,
    ledger: init.ledger ? [...init.ledger] : [],
    ...(init.provisional ? { provisional: init.provisional } : {}),
    ...(init.lastResponse !== undefined ? { lastResponse: init.lastResponse } : {}),
    ...(init.dirty !== undefined ? { dirty: init.dirty } : {}),
    ...(init.workspaceDir ? { workspaceDir: init.workspaceDir } : {}),
    ...(init.systemDigest ? { systemDigest: init.systemDigest } : {}),
    updatedAt: now,
  };
  record.branches.push(branch);
  record.activeBranchID = branch.branchID;
  const live = liveBranches(record);
  if (live.length > MAX_BRANCHES) {
    const excess = live.length - MAX_BRANCHES;
    for (let count = 0; count < excess; count += 1) {
      const oldest = live[count];
      if (oldest && oldest.branchID !== branch.branchID) {
        oldest.tombstoned = true;
      }
    }
  }
  return branch;
}

/** Advance the ledger after a SUCCESSFUL agy turn only. */
export function confirmTurn(
  branch: BranchRecord,
  incoming: string[],
  responseText: string,
  responseDigest: string,
  responseSketchLength = 200,
): void {
  branch.ledger = [...incoming];
  branch.provisional = {
    deltaDigest: responseDigest,
    responseSketch: responseText.slice(0, responseSketchLength),
  };
  branch.lastResponse = responseText;
  branch.dirty = false;
}

/** Mark a branch dirty after abort/kill/timeout/exit (repair on next turn). */
export function markBranchDirty(branch: BranchRecord): void {
  branch.dirty = true;
  delete branch.provisional;
}

export const REPAIR_NOTE = [
  'Note: disregard any partial prior attempt at the last delta on this branch —',
  'the previous turn was aborted or failed before completing. Treat the delta below as authoritative.',
].join(' ');

export const DIVERGENCE_NOTE = [
  'Note: this agy conversation continues after an external compaction or divergence —',
  'the context parts below restate the AUTHORITATIVE current state. Prior conversation',
  'content is retained for reference but is superseded wherever it conflicts with it.',
  'Confirm each part with ACK; treat the final part as the live state.',
].join(' ');

/** Live (non-tombstoned) branches, registry order (LRU: last = most recent). */
export function liveBranches(record: SessionRecord): BranchRecord[] {
  return record.branches.filter((branch) => !branch.tombstoned);
}

export const CONTEXT_REFRESH_PREFIX = '[context refresh]';

export interface DeltaPromptArgs {
  sessionID: string;
  branchID: string;
  epoch: number;
  /** Only when the system digest changed since branch birth. */
  systemRefresh?: string;
  repair?: boolean;
  /** Already-rendered `TOOL_RESULT ...` lines for tool messages in the delta. */
  toolResults: string[];
  /** Already-rendered `role: content` lines for new user/assistant messages. */
  newMessages: string[];
  toolsMode: boolean;
}

/**
 * Structured delta prompt: session header + optional refresh/repair blocks +
 * tool results + new messages + trailing protocol reminder (marker protocol
 * when tools present, plain text otherwise — same contract as legacy).
 */
export function buildDeltaPrompt(args: DeltaPromptArgs): string {
  const lines: string[] = [];
  lines.push(`[agy-bridge session: ${args.sessionID} branch: ${args.branchID} epoch: ${args.epoch}]`);
  lines.push('');
  if (args.systemRefresh) {
    lines.push(`${CONTEXT_REFRESH_PREFIX} ${args.systemRefresh}`);
    lines.push('');
  }
  if (args.repair) {
    lines.push(REPAIR_NOTE);
    lines.push('');
  }
  for (const result of args.toolResults) {
    lines.push(result);
  }
  for (const message of args.newMessages) {
    lines.push(message);
  }
  lines.push('');
  lines.push(
    args.toolsMode
      ? 'Reminder: to use a tool, emit the TOOL_CALL: marker line first; otherwise answer in plain text.'
      : 'Reminder: reply with plain text directly; do NOT use any tools.',
  );
  return lines.join('\n');
}

export interface FlattenedPrompt {
  preamble: string;
  turns: string[];
  reminder: string;
  full: string;
}

/** Split a flattened prompt into its parts (chunked bootstrap needs turns). */
export function splitFlattened(preamble: string, turns: string[], reminder: string): FlattenedPrompt {
  const full = `${preamble}\n\n${turns.join('\n')}\n\n${reminder}`;
  return { preamble, turns, reminder, full };
}

export function chunkBootstrapEnabled(): boolean {
  return process.env.AGY_CHUNK_BOOTSTRAP !== '0';
}

/**
 * Chunked bootstrap (default ON): group history turns so every chunk fits the
 * budget. Non-final chunks are `context part i/n — reply only ACK` priming
 * turns on the SAME conversation; the final chunk is the real turn (legacy
 * shape: preamble + tail turns + reminder). Returns [full] when it fits.
 */
export function chunkBootstrapPrompts(
  flattened: FlattenedPrompt,
  maxChars: number,
): string[] {
  if (flattened.full.length <= maxChars) {
    return [flattened.full];
  }
  // Reserve room for the preamble/reminder/ACK wrappers so every emitted
  // chunk (not just its turn group) fits the budget. A single over-budget
  // turn still gets its own chunk (middle-drop trim is the last resort).
  const overhead = flattened.preamble.length + flattened.reminder.length + 64;
  const effective = Math.max(64, maxChars - overhead);
  const groups: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const turn of flattened.turns) {
    // +1 for the joining newline; a single over-budget turn gets its own
    // chunk (middle-drop trim stays the last-resort guard in the server).
    if (current.length > 0 && currentLen + 1 + turn.length > effective) {
      groups.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(turn);
    currentLen += (current.length > 1 ? 1 : 0) + turn.length;
  }
  if (current.length > 0) {
    groups.push(current);
  }
  if (groups.length <= 1) {
    return [flattened.full];
  }
  const total = groups.length;
  return groups.map((group, index) => {
    if (index < total - 1) {
      return (
        `${flattened.preamble}\n\ncontext part ${index + 1}/${total} — reply only ACK\n\n` +
        `${group.join('\n')}`
      );
    }
    return `${flattened.preamble}\n\n${group.join('\n')}\n\n${flattened.reminder}`;
  });
}

/** Digest helper for tests: sha1 of a canonical string. */
export function digestOf(canonical: string): string {
  return sha1Hex(canonical);
}

/** Ensure a record exists for tests/callers without touching disk. */
export function ensureRecord(sessionID: string): SessionRecord {
  return freshSessionRecord(sessionID);
}
