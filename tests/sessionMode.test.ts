import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgyConversationMismatchError, AgyTimeoutError, AgyToolDeniedError, type AgyUsage } from '../src/agy';
import {
  buildApp,
  flattenMessages,
  isSessionEligible,
  type TurnAdapter,
} from '../src/server';
import { loadSessionRecord } from '../src/sessionStore';

const MODEL = 'gemini-3.6-flash-low';
// Warm-lane pin: these tests exercise the Option A session flow with fake
// adapters; default-ON lanes would attempt nested real spawns. Lane behavior
// has its own dedicated file (tests/warmLane.test.ts).
process.env.AGY_WARM_LANE = '0';
const ENV_KEYS = [
  'AGY_SESSION_MODE',
  'AGY_BRIDGE_HOME',
  'AGY_MAX_PROMPT_CHARS',
  'AGY_CHUNK_BOOTSTRAP',
  'AGY_BRIDGE_LOG',
] as const;

let dir = '';
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  dir = mkdtempSync(join(tmpdir(), 'agy-bridge-session-'));
  process.env.AGY_BRIDGE_HOME = dir;
  process.env.AGY_SESSION_MODE = '1';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
});

interface SeenTurn {
  prompt: string;
  conversationId?: string;
  workspaceDir?: string;
}

/** Fake adapter: queued answers, records every turn, stable conv ids. */
function fakeSessionAdapter(answers: string[], seen: SeenTurn[]): TurnAdapter {
  let calls = 0;
  return {
    runTurn: (request) => {
      calls += 1;
      seen.push({
        prompt: request.prompt,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.workspaceDir ? { workspaceDir: request.workspaceDir } : {}),
      });
      const text = answers[Math.min(calls - 1, answers.length - 1)] as string;
      const usage: AgyUsage | null = null;
      return Promise.resolve({ text, usage, conversationId: 'conv-fake-1' });
    },
  };
}

/** Fake adapter that denies its first turn, then recovers/answers from queue. */
function deniedThenFakeAdapter(
  deniedActions: string[],
  answers: string[],
  seen: SeenTurn[],
): TurnAdapter {
  let calls = 0;
  return {
    runTurn: (request) => {
      calls += 1;
      seen.push({
        prompt: request.prompt,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.workspaceDir ? { workspaceDir: request.workspaceDir } : {}),
      });
      if (calls === 1) {
        // Real agy order: init (adopts the conversation id) precedes the
        // terminal result that carries the denial.
        request.onInit?.('conv-fake-1');
        return Promise.reject(new AgyToolDeniedError(deniedActions));
      }
      const text = answers[Math.min(calls - 2, answers.length - 1)] as string;
      return Promise.resolve({ text, usage: null, conversationId: 'conv-fake-1' });
    },
  };
}

function headers(sessionId: string, agent = 'build'): Record<string, string> {
  return {
    'x-agy-session-id': sessionId,
    'x-agy-agent': agent,
    'x-agy-message-id': 'm1',
  };
}

function recordFile(sessionId: string): string {
  return join(dir, 'sessions', `${sessionId}.json`);
}

describe('isSessionEligible', () => {
  it('defaults ON with headers and a conversational agent; opt-out disables it', () => {
    expect(isSessionEligible('ses-1', 'build')).toBe(true);
    expect(isSessionEligible('-', 'build')).toBe(false);
    expect(isSessionEligible('', 'build')).toBe(false);
    for (const agent of ['title', 'summary', 'compaction', 'Title']) {
      expect(isSessionEligible('ses-1', agent)).toBe(false);
    }
    // Default is ON; explicit opt-out values take it back to legacy.
    delete process.env.AGY_SESSION_MODE;
    expect(isSessionEligible('ses-1', 'build')).toBe(true);
    for (const off of ['0', 'false', 'no', 'off']) {
      process.env.AGY_SESSION_MODE = off;
      expect(isSessionEligible('ses-1', 'build')).toBe(false);
    }
    delete process.env.AGY_SESSION_MODE;
  });
});

describe('session bootstrap + replay (fake adapter, zero live agy)', () => {
  it('bootstraps once, persists the registry, and replays identical retries', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['answer one'], seen) });
    const messages = [{ role: 'user', content: 'first question' }];

    const first = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-boot'),
      payload: { model: MODEL, messages },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()?.choices?.[0]?.message?.content).toBe('answer one');
    expect(seen).toHaveLength(1);

    const record = loadSessionRecord('ses-boot');
    expect(record.branches).toHaveLength(1);
    expect(record.branches[0]?.agyConversationID).toBe('conv-fake-1');
    expect(record.branches[0]?.ledger).toHaveLength(1);
    expect(record.branches[0]?.lastResponse).toBe('answer one');
    expect(record.branches[0]?.provisional?.deltaDigest).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(recordFile('ses-boot'))).toBe(true);

    // Identical retry: NO second adapter call, same text, zero usage.
    const retry = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-boot'),
      payload: { model: MODEL, messages },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()?.choices?.[0]?.message?.content).toBe('answer one');
    expect(seen).toHaveLength(1);
    expect(retry.json()?.usage?.prompt_tokens).toBe(0);
    await app.close();
  });

  it('sends only the delta on follow-up turns', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['answer one', 'answer two'], seen) });
    const firstMessages = [{ role: 'user', content: 'alpha question' }];
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-delta'),
      payload: { model: MODEL, messages: firstMessages },
    });
    const secondMessages = [
      { role: 'user', content: 'alpha question' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'beta question' },
    ];
    const second = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-delta'),
      payload: { model: MODEL, messages: secondMessages },
    });
    expect(second.statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    const deltaPrompt = seen[1]?.prompt as string;
    expect(deltaPrompt).toContain('[agy-bridge session: ses-delta');
    expect(deltaPrompt).toContain('beta question');
    expect(deltaPrompt).not.toContain('alpha question');
    // Ledger advanced to the full incoming history.
    expect(loadSessionRecord('ses-delta').branches[0]?.ledger).toHaveLength(3);
    await app.close();
  });

  it('emits a [context refresh] block when system instructions change', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['answer one', 'answer two'], seen) });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-refresh'),
      payload: {
        model: MODEL,
        messages: [
          { role: 'system', content: 'System v1.' },
          { role: 'user', content: 'q1' },
        ],
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-refresh'),
      payload: {
        model: MODEL,
        messages: [
          { role: 'system', content: 'System v2.' },
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'answer one' },
          { role: 'user', content: 'q2' },
        ],
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.prompt).toContain('[context refresh]');
    await app.close();
  });
});

describe('session routing guards', () => {
  it('ephemeral agents stay stateless (no registry file)', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['a title'], seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-eph', 'title'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(existsSync(recordFile('ses-eph'))).toBe(false);
    await app.close();
  });

  it('flag off keeps legacy parity: identical prompt, no registry', async () => {
    // Default is ON since acceptance; the explicit opt-out value disables it.
    process.env.AGY_SESSION_MODE = '0';
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['legacy'], seen) });
    const messages = [{ role: 'user', content: 'legacy check' }];
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-legacy'),
      payload: { model: MODEL, messages },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe(flattenMessages(messages));
    expect(existsSync(recordFile('ses-legacy'))).toBe(false);
    await app.close();
  });

  it('missing headers stay legacy even with the flag on', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['legacy'], seen) });
    const messages = [{ role: 'user', content: 'no headers' }];
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: MODEL, messages },
    });
    expect(response.statusCode).toBe(200);
    expect(seen[0]?.prompt).toBe(flattenMessages(messages));
    await app.close();
  });
});

describe('chunked bootstrap', () => {
  const manyMessages = (count: number): Array<{ role: string; content: string }> =>
    Array.from({ length: count }, (_, index) => ({
      role: 'user',
      content: `numbered message ${index} with enough padding text to fill the budget quickly xxxx`,
    }));

  it('splits an oversized bootstrap into sequential turns on one conversation', async () => {
    process.env.AGY_MAX_PROMPT_CHARS = '600';
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['ACK', 'ACK', 'final'], seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-chunk'),
      payload: { model: MODEL, messages: manyMessages(12) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()?.choices?.[0]?.message?.content).toBe('final');
    expect(seen.length).toBeGreaterThan(1);
    // Every chunk after the first resumes the same conversation.
    for (const turn of seen.slice(1)) {
      expect(turn.conversationId).toBe('conv-fake-1');
    }
    expect(seen[0]?.prompt).toContain('reply only ACK');
    await app.close();
  });

  it('AGY_CHUNK_BOOTSTRAP=0 falls back to a single trimmed turn', async () => {
    process.env.AGY_MAX_PROMPT_CHARS = '600';
    process.env.AGY_CHUNK_BOOTSTRAP = '0';
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['single'], seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-nochunk'),
      payload: { model: MODEL, messages: manyMessages(12) },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toContain('agy-bridge dropped');
    await app.close();
  });
});

describe('dirty repair', () => {
  it('marks the branch dirty on failure and re-pushes with a repair note', async () => {
    let calls = 0;
    const seen: SeenTurn[] = [];
    const app = buildApp({
      adapter: {
        runTurn: (request) => {
          calls += 1;
          seen.push({ prompt: request.prompt });
          if (calls === 1) {
            return Promise.reject(new Error('boom'));
          }
          return Promise.resolve({ text: 'recovered', usage: null });
        },
      },
    });
    const messages = [{ role: 'user', content: 'fragile turn' }];
    const failed = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-dirty'),
      payload: { model: MODEL, messages },
    });
    expect(failed.statusCode).toBe(500);
    expect(loadSessionRecord('ses-dirty').branches[0]?.dirty).toBe(true);
    const retried = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-dirty'),
      payload: { model: MODEL, messages },
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()?.choices?.[0]?.message?.content).toBe('recovered');
    expect(seen[1]?.prompt).toContain('disregard any partial prior attempt');
    expect(loadSessionRecord('ses-dirty').branches[0]?.dirty).toBe(false);
    await app.close();
  });
});

describe('init mismatch retry', () => {
  it('kills the hijacked resume and bootstraps fresh on retry', async () => {
    const seen: SeenTurn[] = [];
    let calls = 0;
    const app = buildApp({
      adapter: {
        runTurn: (request) => {
          calls += 1;
          seen.push({
            prompt: request.prompt,
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
          });
          if (request.conversationId && request.onInit) {
            // Simulate agy silently opening a different conversation (E8).
            const decision = request.onInit('conv-hijacked');
            expect(decision).toBe('kill');
            return Promise.reject(
              new AgyConversationMismatchError(request.conversationId, 'conv-hijacked'),
            );
          }
          request.onInit?.('conv-fresh-1');
          return Promise.resolve({ text: 'fresh answer', usage: null, conversationId: 'conv-fresh-1' });
        },
      },
    });
    // Bootstrap stores conv-fake... here conv-fresh-1.
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-mismatch'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'one' }] },
    });
    // Follow-up resumes conv-fresh-1 -> hijacked -> fresh bootstrap retry.
    const followUp = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-mismatch'),
      payload: {
        model: MODEL,
        messages: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'fresh answer' },
          { role: 'user', content: 'two' },
        ],
      },
    });
    expect(followUp.statusCode).toBe(200);
    expect(followUp.json()?.choices?.[0]?.message?.content).toBe('fresh answer');
    expect(calls).toBe(3);
    const record = loadSessionRecord('ses-mismatch');
    expect(record.branches).toHaveLength(2);
    expect(record.branches[0]?.dirty).toBe(true);
    expect(record.activeBranchID).not.toBe(record.branches[0]?.branchID);
    await app.close();
  });
});

describe('compaction side turn (T14 Part A)', () => {
  it('compaction agent with parent linkage runs IN-SESSION on the parent branch conversation, ledger untouched', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['build answer'], seen) });
    // 1) Build turn bootstraps the parent branch.
    const build = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-comp-parent'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'build turn one' }] },
    });
    expect(build.statusCode).toBe(200);
    const record = loadSessionRecord('ses-comp-parent');
    const convId = record.branches[0]?.agyConversationID;
    expect(convId).toBe('conv-fake-1');
    const ledgerLen = record.branches[0]?.ledger.length ?? 0;

    // 2) Compaction agent turn, parented: must resume conv-fake-1, NOT touch ledger.
    const compaction = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        ...headers('ses-comp-child', 'compaction'),
        'x-agy-parent-session-id': 'ses-comp-parent',
      },
      payload: { model: MODEL, messages: [{ role: 'user', content: 'summarize this conversation' }] },
    });
    expect(compaction.statusCode).toBe(200);
    expect(seen).toHaveLength(2);
    expect(seen[1]?.conversationId).toBe('conv-fake-1'); // SAME conversation (cache leverage)
    const after = loadSessionRecord('ses-comp-parent');
    expect(after.branches).toHaveLength(1); // no new branch
    expect(after.branches[0]?.ledger.length).toBe(ledgerLen); // ledger untouched
    expect(after.inflightMarkers).toHaveLength(0);
    await app.close();
  });

  it('failed compaction side turn dirties the parent branch (repair next turn)', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({
      adapter: fakeSessionAdapter(['build answer'], seen),
    });
    // Bootstrap the parent first.
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-comp-fail'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    // Now a side turn that fails.
    const app2 = buildApp({
      adapter: {
        runTurn: (request) => {
          if (request.conversationId) {
            return Promise.reject(new AgyTimeoutError(1000));
          }
          return Promise.resolve({ text: 'x', usage: null, conversationId: 'conv-fake-1' });
        },
      },
    });
    const failed = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        ...headers('ses-comp-fail-child', 'compaction'),
        'x-agy-parent-session-id': 'ses-comp-fail',
      },
      payload: { model: MODEL, messages: [{ role: 'user', content: 'summarize' }] },
    });
    expect(failed.statusCode).toBe(504);
    const record = loadSessionRecord('ses-comp-fail');
    expect(record.branches[0]?.dirty).toBe(true);
    await app.close();
    await app2.close();
  });
});

describe('divergence epoch bootstrap (T14 Part B)', () => {
  it('divergence bootstrap resumes the donor conversation with the divergence note', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['answer one', 'answer two'], seen) });
    // Turn 1: bootstrap.
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-epoch'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'original question' }] },
    });
    // Turn 2: compacted history — head diverges (summary replaces the start).
    const epochTurn = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-epoch'),
      payload: {
        model: MODEL,
        messages: [
          { role: 'user', content: 'COMPACTED SUMMARY: the conversation so far' },
          { role: 'assistant', content: 'answer one' },
          { role: 'user', content: 'next question after compaction' },
        ],
      },
    });
    expect(epochTurn.statusCode).toBe(200);
    // The second spawn RESUMED the donor conversation (cache leverage) and
    // carries the divergence note; a NEW branch was created (epoch bump).
    expect(seen).toHaveLength(2);
    expect(seen[1]?.conversationId).toBe('conv-fake-1');
    expect(seen[1]?.prompt).toContain('external compaction or divergence');
    const record = loadSessionRecord('ses-epoch');
    expect(record.branches).toHaveLength(2);
    expect(record.branches[0]?.dirty).toBe(false); // old branch stays clean (not orphaned, superseded)
    await app.close();
  });

  it('first bootstrap (no donor) stays byte-identical: fresh conversation, no note', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['first'], seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-fresh-boot'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).not.toContain('external compaction or divergence');
    expect(seen[0]?.conversationId).toBeUndefined(); // fresh spawn, no resume
    await app.close();
  });
});

describe('tombstone + revival (T15)', () => {
  it('session.deleted tombstones the record; a matching request revives it', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['answer'], seen) });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-tomb'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(loadSessionRecord('ses-tomb').tombstonedAt).toBeUndefined();

    // Plugin forwards session.deleted.
    const tombstone = await app.inject({
      method: 'POST',
      url: '/v1/__session/tombstone',
      payload: { sessionId: 'ses-tomb' },
    });
    expect(tombstone.statusCode).toBe(200);
    expect(typeof loadSessionRecord('ses-tomb').tombstonedAt).toBe('string');

    // Ledger authority revives: a replaying request clears the tombstone.
    const revived = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-tomb'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(revived.statusCode).toBe(200);
    const record = loadSessionRecord('ses-tomb');
    expect(record.tombstonedAt).toBeUndefined();
    expect(record.branches).toHaveLength(1); // not re-bootstrapped
    await app.close();
  });

  it('tombstoning a never-bridged session is a 200 no-op', async () => {
    const app = buildApp({ adapter: fakeSessionAdapter([], []) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/__session/tombstone',
      payload: { sessionId: 'ses-ghost' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'noop' });
    await app.close();
  });
});

describe('agy version gate (T16, case #34)', () => {
  it('bootstrap stamps agyVersion; a version change tombstones the branch and bootstraps fresh', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({
      adapter: fakeSessionAdapter(['answer one', 'answer two'], seen),
      agyVersion: '1.3.1',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-ver'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'q1' }] },
    });
    expect(loadSessionRecord('ses-ver').branches[0]?.agyVersion).toBe('1.3.1');

    // agy auto-upgraded: follow-up runs under a different version.
    const app2 = buildApp({
      adapter: fakeSessionAdapter(['answer two'], seen),
      agyVersion: '1.4.0',
    });
    const followUp = await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-ver'),
      payload: {
        model: MODEL,
        messages: [
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'answer one' },
          { role: 'user', content: 'q2' },
        ],
      },
    });
    expect(followUp.statusCode).toBe(200);
    const record = loadSessionRecord('ses-ver');
    expect(record.branches).toHaveLength(2);
    expect(record.branches[0]?.tombstoned).toBe(true);
    expect(record.branches[0]?.dirty).toBe(false); // tombstone, not orphan
    expect(record.branches[1]?.agyVersion).toBe('1.4.0');
    // Fresh conversation: the old conversation is not resumed cross-version.
    expect(seen[1]?.conversationId).toBeUndefined();
    await app.close();
    await app2.close();
  });

  it('matching version resumes the conversation normally', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({
      adapter: fakeSessionAdapter(['a1', 'a2'], seen),
      agyVersion: '1.3.1',
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-ver-ok'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'q1' }] },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-ver-ok'),
      payload: {
        model: MODEL,
        messages: [
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: 'q2' },
        ],
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.conversationId).toBe('conv-fake-1'); // resumed
    expect(loadSessionRecord('ses-ver-ok').branches[0]?.tombstoned).toBeFalsy();
    await app.close();
  });
});

describe('registry file shape', () => {
  it('writes valid JSON with ledger digests and workspace pin', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({ adapter: fakeSessionAdapter(['ok'], seen) });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-shape'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    const raw = readFileSync(recordFile('ses-shape'), 'utf8');
    const parsed = JSON.parse(raw) as {
      branches: Array<{ ledger: string[]; workspaceDir?: string; agyConversationID: string }>;
    };
    expect(parsed.branches[0]?.ledger[0]).toMatch(/^[0-9a-f]{40}$/);
    expect(parsed.branches[0]?.agyConversationID).toBe('conv-fake-1');
    expect(typeof parsed.branches[0]?.workspaceDir).toBe('string');
    await app.close();
  });
});

describe('tool-denial corrective retry (session mode)', () => {
  it('denied bootstrap turn retries ONCE with the TURN_CALL redirect and recovers', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({
      adapter: deniedThenFakeAdapter(['CallMcpTool'], ['recovered answer'], seen),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-denied-1'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'docs: open the engram' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()?.choices?.[0]?.message?.content).toBe('recovered answer');
    expect(seen).toHaveLength(2); // bootstrap + exactly one correction turn
    expect(seen[1]?.prompt).toContain('CORRECTION');
    expect(seen[1]?.prompt).toContain('CallMcpTool');
    // Session continuity: correction follows the SAME agy conversation.
    expect(seen[1]?.conversationId).toBe('conv-fake-1');
    // No-client-tools phrasing: plain-text answer is the only channel.
    expect(seen[1]?.prompt).toContain('Answer the previous request now in plain text');
    // Ledger confirmed on the recovered text, branch not dirtied.
    expect(loadSessionRecord('ses-denied-1').branches[0]?.dirty).toBe(false);
    await app.close();
  });

  it('correction redirects to TOOL_CALL marker when client tools exist (toolsMode)', async () => {
    const seen: SeenTurn[] = [];
    const app = buildApp({
      adapter: deniedThenFakeAdapter(
        ['CallMcpTool'],
        ['TOOL_CALL: {"name":"read_file","arguments":{}}'],
        seen,
      ),
    });
    const toolPayload = {
      model: MODEL,
      messages: [{ role: 'user', content: 'read the file' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'reads a file',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-denied-2'),
      payload: toolPayload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()?.choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(seen[1]?.prompt).toContain('TOOL_CALL: {"name"');
    expect(seen[1]?.prompt).toContain('from your manifest');
    await app.close();
  });

  it('second consecutive denial fails 400 after the single retry budget', async () => {
    const seen: SeenTurn[] = [];
    let calls = 0;
    const app = buildApp({
      adapter: {
        runTurn: (request) => {
          calls += 1;
          seen.push({ prompt: request.prompt });
          return Promise.reject(new AgyToolDeniedError(['CallMcpTool']));
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers('ses-denied-3'),
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()?.error?.code).toBe('agy_tool_denied');
    expect(calls).toBe(2); // original + one correction, no more
    expect(loadSessionRecord('ses-denied-3').branches[0]?.dirty).toBe(true);
    await app.close();
  });
});
