import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgyConversationMismatchError } from '../src/agy';
import {
  WarmLaneManager,
  WARM_LANE_DEFAULTS,
  type SpawnImpl,
} from '../src/warmLane';

/** Fake agy persistent process emitting the E3-verified event stream. */
class FakeChild extends EventEmitter {
  stdin = {
    writable: true,
    lines: [] as string[],
    write: (chunk: string): boolean => {
      this.stdin.lines.push(chunk.trim());
      setTimeout(() => this.runScriptedTurn(), 5);
      return true;
    },
  };
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} }) as EventEmitter;
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} }) as EventEmitter;
  pid = 4242;
  killed = false;
  /** Conversation id this fake reports in init/result events. */
  initId = 'conv-warm-1';
  /** Per-turn scripted usage (step_update per-turn) plus result cumulative. */
  turn = 0;
  crashOnTurn = -1; // turn index that dies mid-generation
  emitInit = true;

  constructor(private readonly emitScript: (turn: number) => {
    stepDeltas: string[];
    perTurnUsage: { input_tokens: number; cache_read_tokens: number; output_tokens: number };
    cumulativeUsage: { input_tokens: number; output_tokens: number };
    response: string;
  } | 'crash') {
    super();
  }

  private runScriptedTurn(): void {
    this.turn += 1;
    const scripted = this.emitScript(this.turn);
    if (scripted === 'crash') {
      // Die mid-generation after init: unexpected-close rejection.
      this.emit('close', 1, null);
      this.killed = true;
      return;
    }
    this.stdout.emit(
      'data',
      `${JSON.stringify({ event: 'init', conversation_id: this.initId })}\n`,
    );
    for (const delta of scripted.stepDeltas) {
      this.stdout.emit(
        'data',
        `${JSON.stringify({ event: 'step_update', text_delta: delta, usage: scripted.perTurnUsage })}\n`,
      );
    }
    this.stdout.emit(
      'data',
      `${JSON.stringify({ event: 'result', result: { conversation_id: this.initId, status: 'SUCCESS', response: scripted.response, usage: scripted.cumulativeUsage } })}\n`,
    );
  }

  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit('close', null, null));
    return true;
  }
}

interface Probe {
  spawnCalls: number;
  lastArgs: string[] | null;
  child: FakeChild | null;
}

type ScriptFn = (turn: number) => {
  stepDeltas: string[];
  perTurnUsage: { input_tokens: number; cache_read_tokens: number; output_tokens: number };
  cumulativeUsage: { input_tokens: number; output_tokens: number };
  response: string;
} | 'crash';

function fakeSpawn(emitScript: ScriptFn, initIds?: string | string[]): { impl: SpawnImpl; probe: Probe } {
  const probe: Probe = { spawnCalls: 0, lastArgs: null, child: null };
  const list = initIds === undefined ? [] : Array.isArray(initIds) ? initIds : [initIds];
  const impl: SpawnImpl = (_bin, args, _opts) => {
    probe.spawnCalls += 1;
    probe.lastArgs = [...args];
    const child = new FakeChild(emitScript) as unknown as FakeChild;
    // Per-spawn init id (extra spawns reuse the last entry).
    child.initId = list[Math.min(probe.spawnCalls - 1, list.length - 1)] ?? 'conv-warm-1';
    probe.child = child as unknown as Probe['child'] & FakeChild;
    return probe.child as unknown as Record<string, unknown>;
  };
  return { impl, probe };
}

const RESPOND = (word: string) => (turn: number) => ({
  stepDeltas: [word.slice(0, 2), word.slice(2)],
  perTurnUsage: { input_tokens: 1000 + turn, cache_read_tokens: 500 + turn, output_tokens: 5 },
  cumulativeUsage: { input_tokens: 99000 + turn, output_tokens: 8 },
  response: word,
});

function request(overrides: Partial<Parameters<typeof Object>[0]> = {}): {
  prompt: string;
  model: string;
  effort: string | null;
  signal: AbortSignal;
} {
  return {
    prompt: 'say something',
    model: 'gemini-3.6-flash',
    effort: 'low',
    signal: new AbortController().signal,
    ...overrides,
  } as { prompt: string; model: string; effort: string | null; signal: AbortSignal };
}

describe('WarmLaneManager (fake agy, zero live agy)', () => {
  beforeEach(() => {
    process.env.AGY_WARM_LANE = '0';
  });
  afterEach(() => {
    delete process.env.AGY_WARM_LANE;
  });

  it('runs two turns through ONE persistent process with per-turn usage (E11 semantics)', async () => {
    const { impl, probe } = fakeSpawn((turn) => RESPOND(`ANS${turn}`)(turn));
    const manager = new WarmLaneManager(() => ({ model: 'gemini-3.6-flash', effort: 'low' }), WARM_LANE_DEFAULTS, impl);
    const r1 = await manager.runTurn('ses-w', request({ prompt: 'one' }));
    expect(r1?.text).toBe('ANS1');
    expect(r1?.usage).toMatchObject({ inputTokens: 1001, cacheReadTokens: 501 }); // step_update wins
    expect(r1?.conversationId).toBe('conv-warm-1');
    const r2 = await manager.runTurn('ses-w', request({ prompt: 'two' }));
    expect(r2?.text).toBe('ANS2');
    expect(probe.spawnCalls).toBe(1); // SAME process, no respawn between turns
    if (probe.child) {
      expect((probe.child as unknown as FakeChild).stdin.lines.length).toBe(2);
      // Schema: {"event":"user","message":{"content":...}}
      expect((probe.child as unknown as FakeChild).stdin.lines[0]).toContain('"event":"user"');
      expect((probe.child as unknown as FakeChild).stdin.lines[0]).toContain('"message":{"content":"one"}');
    }
  });

  it('seeds a fresh lane WITH --conversation and runs the turn hot (E5 resume)', async () => {
    const { impl, probe } = fakeSpawn(RESPOND('HOT'), 'conv-existing');
    const manager = new WarmLaneManager(() => ({ model: 'gemini-3.6-flash', effort: 'low' }), WARM_LANE_DEFAULTS, impl);
    const r = await manager.runTurn('ses-r', request({ conversationId: 'conv-existing' }));
    expect(r?.text).toBe('HOT');
    expect(r?.conversationId).toBe('conv-existing');
    expect(probe.spawnCalls).toBe(1);
    expect(probe.lastArgs).toContain('--conversation');
    expect(probe.lastArgs?.[probe.lastArgs.indexOf('--conversation') + 1]).toBe('conv-existing');
  });

  it('reuses the seeded lane on subsequent turns (no second spawn)', async () => {
    const { impl, probe } = fakeSpawn((turn) => RESPOND(`ANS${turn}`)(turn), 'conv-live');
    const manager = new WarmLaneManager(() => ({ model: 'gemini-3.6-flash', effort: 'low' }), WARM_LANE_DEFAULTS, impl);
    const r1 = await manager.runTurn('ses-hot', request({ prompt: 'one', conversationId: 'conv-live' }));
    expect(r1?.conversationId).toBe('conv-live');
    const r2 = await manager.runTurn('ses-hot', request({ prompt: 'two', conversationId: 'conv-live' }));
    expect(r2?.text).toBe('ANS2');
    expect(probe.spawnCalls).toBe(1); // hot: the resume seed spawned exactly once
    expect((probe.child as unknown as FakeChild).stdin.lines.length).toBe(2);
  });

  it('destroys the lane and throws when the seeded process reports a different id', async () => {
    const { impl } = fakeSpawn(RESPOND('WRONG'), 'conv-other');
    const manager = new WarmLaneManager(() => ({ model: 'gemini-3.6-flash', effort: 'low' }), WARM_LANE_DEFAULTS, impl);
    const err = await manager
      .runTurn('ses-m', request({ conversationId: 'conv-expected' }))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgyConversationMismatchError);
    expect((err as AgyConversationMismatchError).expectedId).toBe('conv-expected');
    expect((err as AgyConversationMismatchError).actualId).toBe('conv-other');
    expect(manager.laneCount).toBe(0); // destroyed fail-closed; server decorator falls back once
  });

  it('recycles an alive lane on incoming conversationId mismatch and re-seeds', async () => {
    const { impl, probe } = fakeSpawn((turn) => RESPOND(`ANS${turn}`)(turn), ['conv-seed-A', 'conv-seed-B']);
    const manager = new WarmLaneManager(() => ({ model: 'gemini-3.6-flash', effort: 'low' }), WARM_LANE_DEFAULTS, impl);
    const r1 = await manager.runTurn('ses-s', request({ prompt: 'one' }));
    expect(r1?.conversationId).toBe('conv-seed-A');
    const r2 = await manager.runTurn('ses-s', request({ prompt: 'two', conversationId: 'conv-seed-B' }));
    expect(r2?.conversationId).toBe('conv-seed-B');
    expect(probe.spawnCalls).toBe(2); // stale lane destroyed, replacement seeded
    expect(probe.lastArgs).toContain('--conversation');
    expect(probe.lastArgs?.[probe.lastArgs.indexOf('--conversation') + 1]).toBe('conv-seed-B');
  });

  it('destroys the lane and throws on mid-turn crash (caller falls back)', async () => {
    const script: ScriptFn = (turn) => (turn === 1 ? 'crash' : RESPOND(`ANS${turn}`)(turn));
    const { impl, probe } = fakeSpawn(script);
    const manager = new WarmLaneManager(() => ({ model: 'gemini-3.6-flash', effort: 'low' }), WARM_LANE_DEFAULTS, impl);
    await expect(manager.runTurn('ses-c', request())).rejects.toThrow(/unexpectedly|crash|exited/);
    expect(manager.laneCount).toBe(0); // destroyed fail-closed
    expect((probe.child as unknown as FakeChild).killed).toBe(true);
  });

  it('evicts idle lanes and never evicts a busy lane', async () => {
    const { impl, probe } = fakeSpawn(RESPOND('E'));
    const manager = new WarmLaneManager(() => ({ model: 'gemini-3.6-flash', effort: 'low' }), { ...WARM_LANE_DEFAULTS, idleMs: 60 }, impl);
    await manager.runTurn('ses-i', request());
    expect(manager.laneCount).toBe(1);
    await new Promise((r) => setTimeout(r, 160));
    expect(manager.laneCount).toBe(0); // idle eviction happened
    expect((probe.child as unknown as FakeChild).killed).toBe(true);
  });

  it('kills a stuck turn at the absolute cap and destroys the lane', async () => {
    // Fake that never emits a result: the per-turn deadline must fire.
    const impl: SpawnImpl = () => {
      const child = new FakeChild(() => 'crash');
      // Neutralize the crash path: never emit anything (stuck).
      (child as unknown as { runScriptedTurn: () => void }).runScriptedTurn = () => {};
      return child as unknown as Record<string, unknown>;
    };
    const manager = new WarmLaneManager(() => ({ model: 'gemini-3.6-flash', effort: 'low' }), { ...WARM_LANE_DEFAULTS, turnMaxMs: 80 }, impl);
    await expect(manager.runTurn('ses-t', request())).rejects.toThrow();
    expect(manager.laneCount).toBe(0);
    // The stuck process was killed by the cap.
    expect(manager.laneCount).toBe(0);
  });

  it('recycles the lane when the reasoning effort changes', async () => {
    const { impl, probe } = fakeSpawn((turn) => RESPOND(`ANS${turn}`)(turn));
    let effort = 'low';
    const manager = new WarmLaneManager(
      () => ({ model: 'gemini-3.8-flash', effort }),
      WARM_LANE_DEFAULTS,
      impl,
    );
    const r1 = await manager.runTurn(
      'ses-effort',
      request({ model: 'gemini-3.8-flash', effort: 'low' }),
    );
    expect(r1?.text).toBe('ANS1');
    expect(probe.spawnCalls).toBe(1);
    expect(probe.lastArgs?.[probe.lastArgs.indexOf('--effort') + 1]).toBe('low');
    const firstChild = probe.child;

    effort = 'high';
    const r2 = await manager.runTurn(
      'ses-effort',
      request({ model: 'gemini-3.8-flash', effort: 'high' }),
    );
    expect(r2?.text).toBe('ANS1'); // the replacement process starts its own turn 1
    expect(probe.spawnCalls).toBe(2); // --effort is spawn-time: recycle
    expect(probe.lastArgs?.[probe.lastArgs.indexOf('--effort') + 1]).toBe('high');
    expect((firstChild as unknown as FakeChild).killed).toBe(true);
    expect((probe.child as unknown as FakeChild).killed).toBe(false);
  });
});
