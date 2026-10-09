import { describe, expect, it } from 'vitest';
import { messageDigests, sha1Hex } from '../src/digests';
import {
  buildDeltaPrompt,
  chunkBootstrapEnabled,
  chunkBootstrapPrompts,
  confirmProvisionalTail,
  confirmTurn,
  createBranch,
  markBranchDirty,
  REPAIR_NOTE,
  selectBranch,
  touchBranch,
} from '../src/sessionManager';
import { freshSessionRecord, MAX_BRANCHES } from '../src/sessionStore';

const M1 = [{ role: 'user', content: 'first' }];
const M2 = [...M1, { role: 'assistant', content: 'answer one' }, { role: 'user', content: 'second' }];

describe('selectBranch bootstrap', () => {
  it('bootstraps origin initial when no branches exist', () => {
    const selection = selectBranch(freshSessionRecord('s'), messageDigests(M1));
    expect(selection.kind).toBe('bootstrap');
    expect(selection.origin).toBe('initial');
    expect(selection.deltaStart).toBe(0);
  });

  it('bootstraps origin divergence when no ledger is a prefix', () => {
    const record = freshSessionRecord('s');
    const branch = createBranch(record, 'initial', { branchID: 'br-a' });
    branch.ledger = messageDigests([{ role: 'user', content: 'totally different' }]);
    const selection = selectBranch(record, messageDigests(M1));
    expect(selection.kind).toBe('bootstrap');
    expect(selection.origin).toBe('divergence');
  });
});

describe('selectBranch prefix + replay', () => {
  it('selects the longest prefix ledger and reports the delta start', () => {
    const record = freshSessionRecord('s');
    const short = createBranch(record, 'initial', { branchID: 'br-short' });
    short.ledger = messageDigests(M1);
    const long = createBranch(record, 'initial', { branchID: 'br-long' });
    long.ledger = messageDigests(M2);
    const incoming = messageDigests([...M2, { role: 'user', content: 'third' }]);
    const selection = selectBranch(record, incoming);
    expect(selection.kind).toBe('delta');
    expect(selection.branch?.branchID).toBe('br-long');
    expect(selection.deltaStart).toBe(3);
  });

  it('replays on exact-equal history when a response is stored (no spawn)', () => {
    const record = freshSessionRecord('s');
    const branch = createBranch(record, 'initial', { branchID: 'br-r' });
    branch.ledger = messageDigests(M1);
    branch.lastResponse = 'stored answer';
    const selection = selectBranch(record, messageDigests(M1));
    expect(selection.kind).toBe('replay');
    expect(selection.branch?.branchID).toBe('br-r');
  });

  it('repairs on exact-equal history with no stored response (re-push)', () => {
    const record = freshSessionRecord('s');
    const branch = createBranch(record, 'initial', { branchID: 'br-e' });
    branch.ledger = messageDigests(M1);
    const selection = selectBranch(record, messageDigests(M1));
    expect(selection.kind).toBe('delta');
    expect(selection.deltaStart).toBe(1);
    expect(selection.needsRepair).toBe(true);
  });
});

describe('provisional tail', () => {
  it('confirms the provisional digest when the echo follows the ledger head', () => {
    const record = freshSessionRecord('s');
    const branch = createBranch(record, 'initial', { branchID: 'br-p' });
    const d1 = messageDigests(M1);
    branch.ledger = [...d1];
    const assistantDigest = messageDigests([{ role: 'assistant', content: 'answer one' }])[0] as string;
    branch.provisional = { deltaDigest: assistantDigest, responseSketch: 'answer one' };
    const incoming = messageDigests(M2);
    expect(confirmProvisionalTail(branch, incoming)).toBe(true);
    expect(branch.ledger).toEqual([d1[0], assistantDigest]);
    expect(branch.provisional).toBeUndefined();
  });

  it('selectBranch confirms via the echo and starts the delta after it', () => {
    const record = freshSessionRecord('s');
    const branch = createBranch(record, 'initial', { branchID: 'br-p2' });
    branch.ledger = messageDigests(M1);
    const assistantDigest = messageDigests([{ role: 'assistant', content: 'answer one' }])[0] as string;
    branch.provisional = { deltaDigest: assistantDigest, responseSketch: 'answer one' };
    const selection = selectBranch(record, messageDigests(M2));
    expect(selection.kind).toBe('delta');
    expect(selection.deltaStart).toBe(2);
    expect(selection.confirmedProvisional).toBe(true);
  });
});

describe('LRU eviction', () => {
  it('tombstones extras beyond MAX_BRANCHES and keeps the newest live', () => {
    const record = freshSessionRecord('s');
    const ids: string[] = [];
    for (let index = 0; index < MAX_BRANCHES + 2; index += 1) {
      const branch = createBranch(record, 'divergence', { branchID: `br-${index}` });
      // Distinct non-matching ledgers: no branch may prefix-match M1.
      branch.ledger = messageDigests([{ role: 'user', content: `other-${index}` }]);
      ids.push(branch.branchID);
    }
    const live = record.branches.filter((branch) => !branch.tombstoned);
    expect(live).toHaveLength(MAX_BRANCHES);
    expect(live.map((branch) => branch.branchID)).toContain(ids[ids.length - 1]);
    // Oldest tombstoned first.
    expect(record.branches.find((branch) => branch.branchID === 'br-0')?.tombstoned).toBe(true);
    expect(record.branches.find((branch) => branch.branchID === 'br-1')?.tombstoned).toBe(true);
    // Tombstoned branches never match selection.
    const selection = selectBranch(record, messageDigests(M1));
    expect(selection.kind).toBe('bootstrap');
  });

  it('touchBranch moves the branch to most-recently-used', () => {
    const record = freshSessionRecord('s');
    const first = createBranch(record, 'initial', { branchID: 'br-first' });
    createBranch(record, 'initial', { branchID: 'br-second' });
    touchBranch(record, first);
    expect(record.branches[record.branches.length - 1]?.branchID).toBe('br-first');
    expect(record.activeBranchID).toBe('br-first');
  });
});

describe('confirmTurn + markBranchDirty', () => {
  it('advances the ledger and stores provisional + lastResponse', () => {
    const record = freshSessionRecord('s');
    const branch = createBranch(record, 'initial', { branchID: 'br-c' });
    const digests = messageDigests(M1);
    confirmTurn(branch, digests, 'the answer', sha1Hex('assistant:the answer'));
    expect(branch.ledger).toEqual(digests);
    expect(branch.lastResponse).toBe('the answer');
    expect(branch.provisional?.deltaDigest).toBe(sha1Hex('assistant:the answer'));
    expect(branch.dirty).toBe(false);
  });

  it('marks dirty and drops the unconfirmed provisional', () => {
    const record = freshSessionRecord('s');
    const branch = createBranch(record, 'initial', { branchID: 'br-d' });
    branch.provisional = { deltaDigest: 'x', responseSketch: 'y' };
    markBranchDirty(branch);
    expect(branch.dirty).toBe(true);
    expect(branch.provisional).toBeUndefined();
  });
});

describe('buildDeltaPrompt', () => {
  it('renders the session header, messages and plain-text reminder', () => {
    const prompt = buildDeltaPrompt({
      sessionID: 'ses-1',
      branchID: 'br-1',
      epoch: 0,
      toolResults: [],
      newMessages: ['user: hello'],
      toolsMode: false,
    });
    expect(prompt).toContain('[agy-bridge session: ses-1 branch: br-1 epoch: 0]');
    expect(prompt).toContain('user: hello');
    expect(prompt).toContain('reply with plain text directly');
  });

  it('adds the marker reminder in tools mode', () => {
    const prompt = buildDeltaPrompt({
      sessionID: 's',
      branchID: 'b',
      epoch: 1,
      toolResults: ['TOOL_RESULT for call call_1 (tool read_file): bytes'],
      newMessages: [],
      toolsMode: true,
    });
    expect(prompt).toContain('TOOL_RESULT for call call_1 (tool read_file): bytes');
    expect(prompt).toContain('TOOL_CALL:');
  });

  it('adds repair and context-refresh blocks when asked', () => {
    const prompt = buildDeltaPrompt({
      sessionID: 's',
      branchID: 'b',
      epoch: 0,
      systemRefresh: 'system instructions changed',
      repair: true,
      toolResults: [],
      newMessages: ['user: again'],
      toolsMode: false,
    });
    expect(prompt).toContain('[context refresh] system instructions changed');
    expect(prompt).toContain(REPAIR_NOTE.slice(0, 40));
  });

  it('omits optional blocks by default', () => {
    const prompt = buildDeltaPrompt({
      sessionID: 's',
      branchID: 'b',
      epoch: 0,
      toolResults: [],
      newMessages: ['user: hi'],
      toolsMode: false,
    });
    expect(prompt).not.toContain('[context refresh]');
    expect(prompt).not.toContain(REPAIR_NOTE.slice(0, 40));
  });
});

describe('chunkBootstrapPrompts', () => {
  const flattened = (turns: string[]) => ({
    preamble: 'PREAMBLE',
    turns,
    reminder: 'REMINDER',
    full: `PREAMBLE\n\n${turns.join('\n')}\n\nREMINDER`,
  });

  it('returns the full prompt untouched when it fits', () => {
    const full = flattened(['user: hi']);
    expect(chunkBootstrapPrompts(full, 10_000)).toEqual([full.full]);
  });

  it('splits oversized history into ACK chunks plus the real final turn', () => {
    const turns = Array.from({ length: 20 }, (_, index) => `user: message number ${index}`);
    const chunks = chunkBootstrapPrompts(flattened(turns), 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
    expect(chunks[0]).toContain('context part 1/');
    expect(chunks[0]).toContain('reply only ACK');
    const last = chunks[chunks.length - 1] as string;
    expect(last).toContain('REMINDER');
    expect(last).not.toContain('reply only ACK');
  });

  it('reads the AGY_CHUNK_BOOTSTRAP kill switch', () => {
    const previous = process.env.AGY_CHUNK_BOOTSTRAP;
    try {
      delete process.env.AGY_CHUNK_BOOTSTRAP;
      expect(chunkBootstrapEnabled()).toBe(true);
      process.env.AGY_CHUNK_BOOTSTRAP = '0';
      expect(chunkBootstrapEnabled()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.AGY_CHUNK_BOOTSTRAP;
      } else {
        process.env.AGY_CHUNK_BOOTSTRAP = previous;
      }
    }
  });
});
