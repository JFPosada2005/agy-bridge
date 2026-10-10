// Session registry persistence (Phase 1).
//
// Bridge-owned state under `~/.agy-bridge/sessions/<sessionID>.json`
// (env AGY_BRIDGE_HOME overrides the base dir; a dedicated workspace dir for
// agy spawns lives at `~/.agy-bridge/workspace/` — NEVER the repo dir).
// Atomic writes (temp + rename), UTF-8 no BOM, mkdir on demand. Corrupted
// files are quarantined (renamed `<file>.corrupt-<ts>`) and a fresh record is
// returned. Every fs error is swallowed-but-logged: request handling is
// infallible, every fallback loud. Strict TS, English, no BOM.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type BranchOrigin =
  | 'initial'
  | 'compaction'
  | 'revert'
  | 'fork'
  | 'divergence'
  | 'dirty-repair'
  | 'family-switch';

export interface ProvisionalTail {
  deltaDigest: string;
  responseSketch: string;
}

export interface InflightMarker {
  bootId: string;
  branchID: string;
  deltaDigest: string;
  pid?: number;
  startedAt: string;
}

export interface BranchRecord {
  branchID: string;
  /** agy conversation id; '' until the first init event persists it. */
  agyConversationID: string;
  agyVersion: string | null;
  modelFamily: string;
  effort: string | null;
  epoch: number;
  origin: BranchOrigin;
  /** Ordered canonical message digests confirmed delivered to agy. */
  ledger: string[];
  provisional?: ProvisionalTail;
  /** Raw last assistant text, for replay-on-retry idempotency. */
  lastResponse?: string;
  dirty?: boolean;
  workspaceDir?: string;
  /** Digest of system messages at branch birth/last confirm (refresh diff). */
  systemDigest?: string;
  updatedAt: string;
  tombstoned?: boolean;
}

export interface SessionRecord {
  sessionID: string;
  parentSessionID?: string;
  createdAt: string;
  updatedAt: string;
  activeBranchID: string;
  epoch: number;
  branches: BranchRecord[];
  inflightMarkers: InflightMarker[];
  /** When set: session deleted by opencode; GC-eligible after grace. */
  tombstonedAt?: string;
}

/** Max live branches per session; extras are LRU-tombstoned. */
export const MAX_BRANCHES = 4;

function loud(message: string): void {
  try {
    console.error(`agy-bridge session-store: ${message}`);
  } catch {
    // Logging must never break a request.
  }
}

/** Base dir: AGY_BRIDGE_HOME wins, else ~/.agy-bridge. */
export function agyBridgeHome(): string {
  const override = process.env.AGY_BRIDGE_HOME?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), '.agy-bridge');
}

export function sessionsDir(): string {
  return path.join(agyBridgeHome(), 'sessions');
}

export function workspaceBaseDir(): string {
  return path.join(agyBridgeHome(), 'workspace');
}

/**
 * Session ids arrive from HTTP (x-agy-session-id / x-agy-parent-session-id
 * headers and the tombstone body) and become file names under sessionsDir().
 * Only opaque ids are accepted (opencode sends `ses_...`): letters, digits,
 * `_` and `-`, 1..128 chars. Anything else (`..`, `/`, `\`, drive letters,
 * dots) is rejected BEFORE any filesystem access — otherwise a crafted id
 * could rename (quarantine) or overwrite `.json` files outside the store.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

/** Log-safe rendering of an untrusted id (no newlines, bounded length). */
function describeId(id: unknown): string {
  return JSON.stringify(String(id).slice(0, 80));
}

/**
 * Record file for a session, or null when the id is invalid. Defense in
 * depth: even a valid-looking id must resolve to a file directly inside
 * sessionsDir().
 */
function recordPath(sessionID: string): string | null {
  if (!isValidSessionId(sessionID)) {
    return null;
  }
  const base = path.resolve(sessionsDir());
  const file = path.resolve(base, `${sessionID}.json`);
  if (path.dirname(file) !== base) {
    return null;
  }
  return file;
}

export function newBranchID(): string {
  return `br_${randomBytes(6).toString('hex')}`;
}

export function freshSessionRecord(sessionID: string, parentSessionID?: string): SessionRecord {
  const now = new Date().toISOString();
  return {
    sessionID,
    ...(parentSessionID ? { parentSessionID } : {}),
    createdAt: now,
    updatedAt: now,
    activeBranchID: '',
    epoch: 0,
    branches: [],
    inflightMarkers: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['sessionID'] === 'string' &&
    Array.isArray(value['branches']) &&
    Array.isArray(value['inflightMarkers'])
  );
}

/**
 * Load a record; missing file -> fresh record. Corrupted/unparsable file ->
 * quarantine (rename to `<file>.corrupt-<ts>`) + fresh record + LOUD log.
 * Never throws.
 */
export function loadSessionRecord(sessionID: string): SessionRecord {
  const file = recordPath(sessionID);
  if (!file) {
    loud(`refusing invalid session id ${describeId(sessionID)}; using fresh in-memory record (nothing read)`);
    return freshSessionRecord(sessionID);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      loud(`cannot read ${file}: ${(err as Error).message}; using fresh record (stateless for this turn)`);
    }
    return freshSessionRecord(sessionID);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!looksLikeSessionRecord(parsed)) {
      throw new Error('record shape mismatch (not a SessionRecord)');
    }
    if (parsed.sessionID !== sessionID) {
      throw new Error(`record sessionID mismatch: file holds ${parsed.sessionID}`);
    }
    return parsed;
  } catch (err) {
    const ts = Date.now();
    const quarantine = `${file}.corrupt-${ts}`;
    try {
      fs.renameSync(file, quarantine);
      loud(
        `CORRUPT registry file ${file} quarantined to ${quarantine} ` +
          `(${(err as Error).message}); bootstrapping a fresh branch`,
      );
    } catch (renameErr) {
      loud(
        `CORRUPT registry file ${file} could not be quarantined ` +
          `(${(renameErr as Error).message}); bootstrapping a fresh branch anyway`,
      );
    }
    return freshSessionRecord(sessionID);
  }
}

/**
 * ATOMIC save: write temp + rename, UTF-8 no BOM, mkdir on demand.
 * Never throws; failures are loud (the turn already succeeded — the next
 * turn simply bootstraps again).
 */
export function saveSessionRecord(record: SessionRecord): void {
  const file = recordPath(record.sessionID);
  if (!file) {
    loud(`refusing to persist invalid session id ${describeId(record.sessionID)} (nothing written)`);
    return;
  }
  try {
    record.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8' });
    fs.renameSync(tmp, file);
  } catch (err) {
    loud(`cannot persist ${file}: ${(err as Error).message}; continuing stateless for this turn`);
  }
}

/**
 * Dedicated neutral workspace dir for one conversation, pinned per branch.
 * Created on demand; returns undefined (loud) when creation fails, in which
 * case the caller spawns without a pinned cwd.
 */
export function ensureWorkspaceDir(key: string): string | undefined {
  const safe = key.replace(/[^A-Za-z0-9_-]/g, '_') || 'default';
  const dir = path.join(workspaceBaseDir(), safe);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (err) {
    loud(`cannot create workspace dir ${dir}: ${(err as Error).message}; spawning without pinned cwd`);
    return undefined;
  }
}

// Per-session in-process mutex: serialize turns of one session (two windows
// on the same session queue up FIFO instead of interleaving).
const sessionLocks = new Map<string, Promise<void>>();

/** Run `work` holding the per-session lock. Never deadlocks: always releases. */
export async function withSessionLock<T>(sessionID: string, work: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionID) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionLocks.set(sessionID, previous.then(() => current));
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (sessionLocks.get(sessionID) === current) {
      sessionLocks.delete(sessionID);
    }
  }
}

// Boot id: random per daemon process start; tags inflight markers so a
// restarted daemon can tell its own orphans from a stale daemon's.
const BOOT_ID = `boot_${randomBytes(6).toString('hex')}`;

/** Random id minted once per daemon process start. */
export function getBootId(): string {
  return BOOT_ID;
}
