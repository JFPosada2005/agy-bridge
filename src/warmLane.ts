// T18 (Phase 3): warm lane — persistent agy stream-json process per hot
// session (design Option B), with transparent fallback to the proven
// Option A spawn-per-turn path on ANY anomaly.
//
// Schema (E3-verified): one NDJSON line per turn on the process stdin:
//   {"event":"user","message":{"content":"<prompt>"}}
// Events on stdout: init (conversation id), step_update (text deltas +
// PER-TURN usage — the E11 semantics; the terminal result event carries
// session-cumulative usage and is only a fallback), result (turn done).
//
// Safety invariants:
// - never --continue, never --dangerously-skip-permissions, OAuth untouched.
// - eviction ONLY when no turn is in flight (idle LRU ~10 min default);
//   a thinking/executing turn can never be evicted mid-flight.
// - per-turn absolute cap AGY_TURN_MAX_MS (default 15 min; flash-class
//   models think in seconds) — a stuck turn destroys the lane.
// - any anomaly (crash, malformed events, init mismatch, timeout, abort)
//   destroys the lane and the CALLER falls back to the base adapter:
//   correctness never depends on the warm lane.
// - usage reported to opencode is per-turn (step_update preferred).
//
// Resume rule (E5-verified, scripts/experiments/e5-resume-lane.mjs,
// verdict RESUME_LANE_OK): a lane is SEEDED at construction with the
// branch's live conversation id via `--conversation <id>` on the
// persistent stream-json process. Every live conversation therefore runs
// hot; only a brand-new bootstrap, a post-eviction re-hydration, or a
// crash/timeout pays exactly ONE spawn.

import { spawn, type ChildProcess } from 'node:child_process';
import {
  AgyAbortedError,
  AgyConversationMismatchError,
  AgyTimeoutError,
  agyChildEnv,
  type AgyUsage,
} from './agy';

const AGY_BIN =
  process.env.AGY_BIN ??
  (process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe` : 'agy');

export function warmLaneEnabled(): boolean {
  // Default ON (user decision: sessions run hot whenever a conversation is
  // live). AGY_WARM_LANE=0 is the explicit opt-out.
  return process.env.AGY_WARM_LANE !== '0';
}

function numEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const WARM_LANE_DEFAULTS = {
  turnMaxMs: numEnv('AGY_TURN_MAX_MS', 15 * 60 * 1000),
  idleMs: numEnv('AGY_WARM_IDLE_MS', 10 * 60 * 1000),
  maxLanes: numEnv('AGY_MAX_WARM_LANES', 8),
};

/** Injectable spawn shape (tests provide a fake agy process). */
export type SpawnImpl = (
  bin: string,
  args: string[],
  opts: { cwd?: string; stdio: unknown; windowsHide: boolean },
) => {
  stdin?: { writable?: boolean; write?: (chunk: string) => boolean | undefined };
  stdout?: { setEncoding?: (enc: string) => void; on?: (event: string, cb: (...a: unknown[]) => void) => unknown };
  stderr?: { setEncoding?: (enc: string) => void; on?: (event: string, cb: (...a: unknown[]) => void) => unknown };
  on?: (event: string, cb: (...a: unknown[]) => void) => unknown;
  kill?: () => boolean | undefined;
  pid?: number;
} | null;

export interface WarmLaneRequest {
  prompt: string;
  model: string;
  effort: string | null;
  signal: AbortSignal;
  conversationId?: string;
  workspaceDir?: string;
  onInit?: (conversationId: string) => 'continue' | 'kill';
  onDelta?: (delta: string) => void;
}

export interface WarmLaneResult {
  text: string;
  usage: AgyUsage | null;
  conversationId?: string;
}

type LaneState = 'starting' | 'ready' | 'busy' | 'dead';

export class WarmLane {
  readonly key: string;
  private child: ChildProcess | null = null;
  private state: LaneState = 'starting';
  private conversationId: string | undefined;
  private stdoutBuf = '';
  private stderrTail = '';
  private turnActive = false;
  private turnDeadline: NodeJS.Timeout | null = null;
  private abortHandler: (() => void) | null = null;
  private abortSignal: AbortSignal | null = null;
  private turnOnInit: ((conversationId: string) => 'continue' | 'kill') | null = null;
  private turnOnDelta: ((delta: string) => void) | null = null;
  private turnText = '';
  private turnUsage: AgyUsage | null = null;
  private sawDeltaThisTurn = false;
  private pendingResolve: ((result: WarmLaneResult) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;

  constructor(
    private readonly model: string,
    private readonly effort: string | null,
    private readonly workspaceDir?: string,
    private readonly spawnImpl: SpawnImpl | null = null,
    private readonly turnMaxMs: number = WARM_LANE_DEFAULTS.turnMaxMs,
    seededConversationId?: string,
  ) {
    this.key = '';
    // E5 resume seed (scripts/experiments/e5-resume-lane.mjs): a fresh
    // process spawned WITH --conversation <id> resumes that conversation
    // on the persistent lane. The seed doubles as the init validator —
    // the first init event MUST report the same id (see handleLine).
    this.conversationId = seededConversationId;
  }

  /** True when this process was spawned for the same model/effort/workspace. */
  matchesSpawn(model: string, effort: string | null, workspaceDir?: string): boolean {
    return (
      this.model === model &&
      this.effort === effort &&
      (this.workspaceDir ?? undefined) === (workspaceDir ?? undefined)
    );
  }

  /** Spawn once; throws when the binary cannot start at all. */
  ensureSpawned(): void {
    if (this.child) {
      return;
    }
    const args = [
      '--output-format', 'stream-json',
      '--model', this.model,
      ...(this.effort ? ['--effort', this.effort] : []),
      '--input-format', 'stream-json',
      '--disable-slash-commands',
      // E5 resume seed: same --conversation <id> semantics as Option A's
      // buildAgyArgs (src/agy.ts); only the input format differs
      // (persistent stream-json stdin vs one-shot text stdin).
      ...(this.conversationId ? ['--conversation', this.conversationId] : []),
    ];
    try {
      this.child = this.spawnImpl
        ? (this.spawnImpl(AGY_BIN, args, {
            ...(this.workspaceDir ? { cwd: this.workspaceDir } : {}),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          }) as ChildProcess)
        : spawn(AGY_BIN, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            env: agyChildEnv(),
            ...(this.workspaceDir ? { cwd: this.workspaceDir } : {}),
          });
    } catch (err) {
      this.state = 'dead';
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.stdoutBuf += chunk;
      let index = this.stdoutBuf.indexOf('\n');
      while (index >= 0) {
        this.handleLine(this.stdoutBuf.slice(0, index));
        this.stdoutBuf = this.stdoutBuf.slice(index + 1);
        index = this.stdoutBuf.indexOf('\n');
      }
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-600);
    });
    this.child.on('close', (code) => {
      this.state = 'dead';
      if (this.turnActive && this.pendingReject) {
        const reject = this.pendingReject;
        this.turnActive = false;
        this.pendingResolve = null;
        this.pendingReject = null;
        this.clearTurnTimer();
        if (this.abortSignal?.aborted) {
          reject(new AgyAbortedError());
        } else {
          reject(new Error(`warm lane exited unexpectedly (code ${String(code)}); stderr: ${this.stderrTail.trim()}`));
        }
      }
      this.child = null;
    });
    this.child.on('error', (err) => {
      this.state = 'dead';
      if (this.turnActive && this.pendingReject) {
        const reject = this.pendingReject;
        this.turnActive = false;
        this.pendingResolve = null;
        this.pendingReject = null;
        this.clearTurnTimer();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.child = null;
    });
    this.state = 'ready';
  }

  get alive(): boolean {
    return this.state !== 'dead' && this.child !== null && !!this.child.pid;
  }

  get conversationID(): string | undefined {
    return this.conversationId;
  }

  get inFlight(): boolean {
    return this.state === 'busy' || this.turnActive;
  }

  get stderrText(): string {
    return this.stderrTail;
  }

  /**
   * Run one turn through the persistent process. ANY rejection means the
   * caller destroys this lane and retries on the base adapter (fail-closed).
   */
  async runTurn(request: WarmLaneRequest): Promise<WarmLaneResult> {
    if (!this.alive) {
      throw new Error('warm lane is dead');
    }
    if (this.turnActive) {
      throw new Error('warm lane is already running a turn');
    }
    // The lane's conversation must match the branch's expectation. A
    // seeded lane carries its seed as this.conversationId, so this one
    // guard covers fresh and resumed lanes alike: a diverged branch never
    // adopts inline — the manager recycles (destroy + re-seed) instead.
    if (request.conversationId && this.conversationId && request.conversationId !== this.conversationId) {
      this.destroy();
      throw new AgyConversationMismatchError(request.conversationId, this.conversationId ?? '(none)');
    }
    if (request.conversationId && !this.conversationId) {
      // Defensive: the manager always seeds at construction (E5 path), so
      // an unseeded lane asked to resume owns a process spawned WITHOUT
      // --conversation — it cannot resume and must not adopt the id.
      this.destroy();
      throw new Error('warm lane cannot resume an existing conversation (fresh process)');
    }
    if (request.signal.aborted) {
      throw new AgyAbortedError();
    }

    this.state = 'busy';
    this.turnActive = true;
    this.turnText = '';
    this.turnUsage = null;
    this.sawDeltaThisTurn = false;
    this.turnOnInit = request.onInit ?? null;
    this.turnOnDelta = request.onDelta ?? null;
    this.abortSignal = request.signal;
    this.abortHandler = () => {
      this.destroy();
      this.failTurn(new AgyAbortedError());
    };
    request.signal.addEventListener('abort', this.abortHandler, { once: true });

    const promise = new Promise<WarmLaneResult>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });

    // Per-turn ABSOLUTE cap (wall clock), configurable AGY_TURN_MAX_MS.
    this.turnDeadline = setTimeout(() => {
      this.destroy();
      this.failTurn(new AgyTimeoutError(this.turnMaxMs));
    }, this.turnMaxMs);
    this.turnDeadline.unref?.();

    let wrote = false;
    try {
      this.child?.stdin?.write(`${JSON.stringify({ event: 'user', message: { content: request.prompt } })}\n`);
      wrote = true;
    } catch {
      wrote = false;
    }
    if (!wrote) {
      this.destroy();
      this.failTurn(new Error('warm lane stdin closed before the turn could be written'));
      return await promise;
    }
    return await promise;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // non-JSON noise: ignore
    }
    if (typeof event !== 'object' || event === null) {
      return;
    }
    const record = event as Record<string, unknown>;
    const kind = typeof record['event'] === 'string' ? record['event'] : 'other';
    const conv = this.findConversationId(record);
    if (kind === 'init' && conv) {
      if (this.conversationId === undefined) {
        this.conversationId = conv;
        if (this.turnOnInit) {
          try {
            const decision = this.turnOnInit(conv);
            if (decision === 'kill') {
              this.destroy();
              this.failTurn(new AgyConversationMismatchError('(fresh)', conv));
              return;
            }
          } catch {
            // onInit throwing must not fail the lane.
          }
        }
      } else if (conv !== this.conversationId) {
        // Seeded-lane init validation (E5, scripts/experiments/e5-resume-lane.mjs):
        // the process MUST have resumed the seed. A different id means agy
        // silently started a fresh conversation — destroy and THROW so the
        // caller falls back to Option A exactly once (aborts never fall
        // back — separate path).
        const expected = this.conversationId;
        this.destroy();
        this.failTurn(new AgyConversationMismatchError(expected, conv));
        return;
      } else if (this.turnOnInit) {
        // Seeded match: still honor an explicit 'kill' from the caller.
        try {
          const decision = this.turnOnInit(conv);
          if (decision === 'kill') {
            this.destroy();
            this.failTurn(new AgyConversationMismatchError(this.conversationId, conv));
            return;
          }
        } catch {
          // onInit throwing must not fail the lane.
        }
      }
    }
    if (kind !== 'result') {
      const delta = this.extractTextDelta(record);
      if (delta) {
        this.turnText += delta;
        this.sawDeltaThisTurn = true;
        try {
          this.turnOnDelta?.(delta);
        } catch {
          // Consumer failing must not fail the lane.
        }
      }
      if (kind === 'step_update') {
        const eventUsage = this.extractUsage(record);
        // E11: step_update usage is the real PER-TURN consumption.
        if (eventUsage) {
          this.turnUsage = { ...(this.turnUsage ?? {}), ...eventUsage } as AgyUsage;
        }
      }
      return;
    }
    // Terminal result event.
    if (!this.sawDeltaThisTurn) {
      const fallbackText = this.extractResultText(record);
      if (fallbackText) {
        this.turnText = fallbackText;
      }
    }
    if (this.turnUsage === null) {
      // Session-cumulative fallback for turns that never emitted step usage.
      const terminalUsage = this.extractUsage(record);
      if (terminalUsage) {
        this.turnUsage = terminalUsage as AgyUsage;
      }
    }
    const result: WarmLaneResult = {
      text: this.turnText,
      usage: this.turnUsage,
    };
    if (this.conversationId) {
      result.conversationId = this.conversationId;
    }
    this.succeedTurn(result);
  }

  private succeedTurn(result: WarmLaneResult): void {
    this.turnActive = false;
    if (this.alive) {
      this.state = 'ready';
    }
    this.clearTurnTimer();
    this.detachTurnListeners();
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingReject = null;
    resolve?.(result);
  }

  private failTurn(err: Error): void {
    this.turnActive = false;
    if (this.alive) {
      this.state = 'ready';
    }
    this.clearTurnTimer();
    this.detachTurnListeners();
    const reject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    reject?.(err);
  }

  private detachTurnListeners(): void {
    this.turnOnInit = null;
    this.turnOnDelta = null;
    if (this.abortSignal && this.abortHandler) {
      try {
        this.abortSignal.removeEventListener('abort', this.abortHandler);
      } catch {
        // Signal already dead.
      }
    }
    this.abortSignal = null;
    this.abortHandler = null;
  }

  private clearTurnTimer(): void {
    if (this.turnDeadline) {
      clearTimeout(this.turnDeadline);
      this.turnDeadline = null;
    }
  }

  /** Tear down the lane process (never throws). */
  destroy(): void {
    this.clearTurnTimer();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // Already gone.
      }
    }
    this.child = null;
    this.state = 'dead';
  }

  private findConversationId(obj: unknown, depth = 0): string | undefined {
    if (!obj || typeof obj !== 'object' || depth > 6) {
      return undefined;
    }
    const record = obj as Record<string, unknown>;
    for (const key of ['conversation_id', 'conversationId']) {
      if (typeof record[key] === 'string' && (record[key] as string).length >= 8) {
        return record[key] as string;
      }
    }
    for (const value of Object.values(record)) {
      const found = this.findConversationId(value, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private extractUsage(obj: unknown, depth = 0): Partial<AgyUsage> | null {
    if (!obj || typeof obj !== 'object' || depth > 6) {
      return null;
    }
    const record = obj as Record<string, unknown>;
    const asNum = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
    for (const key of ['usage', 'tokenUsage', 'tokens']) {
      const holder = record[key];
      if (typeof holder === 'object' && holder !== null) {
        const h = holder as Record<string, unknown>;
        const usage: Partial<AgyUsage> = {
          inputTokens: asNum(h['input_tokens']) ?? asNum(h['inputTokens']),
          outputTokens: asNum(h['output_tokens']) ?? asNum(h['outputTokens']),
        };
        const thinking = asNum(h['thinking_tokens']) ?? asNum(h['thinkingTokens']);
        if (thinking !== undefined) {
          usage.thinkingTokens = thinking;
        }
        const cacheRead = asNum(h['cache_read_tokens']) ?? asNum(h['cacheReadTokens']);
        if (cacheRead !== undefined) {
          usage.cacheReadTokens = cacheRead;
        }
        if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
          return usage;
        }
      }
    }
    for (const value of Object.values(record)) {
      const found = this.extractUsage(value, depth + 1);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private extractTextDelta(obj: unknown, depth = 0): string {
    if (!obj || typeof obj !== 'object' || depth > 6) {
      return '';
    }
    const record = obj as Record<string, unknown>;
    for (const key of ['text_delta', 'textDelta', 'content_delta']) {
      if (typeof record[key] === 'string' && record[key]) {
        return record[key] as string;
      }
    }
    for (const value of Object.values(record)) {
      const found = this.extractTextDelta(value, depth + 1);
      if (found) {
        return found;
      }
    }
    return '';
  }

  private extractResultText(obj: unknown, depth = 0): string {
    if (!obj || typeof obj !== 'object' || depth > 6) {
      return '';
    }
    const record = obj as Record<string, unknown>;
    for (const key of ['response', 'text', 'output']) {
      if (typeof record[key] === 'string' && record[key]) {
        return record[key] as string;
      }
    }
    for (const value of Object.values(record)) {
      const found = this.extractResultText(value, depth + 1);
      if (found) {
        return found;
      }
    }
    return '';
  }
}

export interface LaneSpawnInfo {
  model: string;
  effort: string | null;
  workspaceDir?: string;
}

export class WarmLaneManager {
  private lanes = new Map<string, { lane: WarmLane; idleTimer: NodeJS.Timeout | null }>();
  lastUsed = new Map<string, number>();

  constructor(
    private readonly resolveSpawn: (sessionID: string) => LaneSpawnInfo | null,
    private readonly bounds = WARM_LANE_DEFAULTS,
    private readonly spawnImpl: SpawnImpl | null = null,
  ) {}

  get laneCount(): number {
    return this.lanes.size;
  }

  /** Non-blocking snapshot for the stats route. */
  describe(): { lanes: number; keys: Array<{ key: string; busy: boolean; conversationId?: string }> } {
    const keys = [...this.lanes.entries()].map(([key, entry]) => ({
      key,
      busy: entry.lane.inFlight,
      ...(entry.lane.conversationID ? { conversationId: entry.lane.conversationID } : {}),
    }));
    return { lanes: this.lanes.size, keys };
  }

  /**
   * Run one turn on the session's warm lane. Returns null when the lane
   * path does not apply (caller must use the base adapter); throws after
   * destroying the lane when it failed mid-turn (caller falls back).
   */
  async runTurn(sessionID: string, request: WarmLaneRequest): Promise<WarmLaneResult | null> {
    const spawnInfo = this.resolveSpawn(sessionID);
    if (!spawnInfo) {
      return null;
    }
    const entry = this.lanes.get(sessionID);
    if (entry) {
      if (entry.lane.inFlight) {
        return null; // never queue on warm; caller falls back (mutex semantics)
      }
      if (!entry.lane.alive) {
        entry.lane.destroy();
        this.drop(sessionID);
      } else if (!entry.lane.matchesSpawn(spawnInfo.model, spawnInfo.effort, spawnInfo.workspaceDir)) {
        // A different model, reasoning effort or workspace cannot be applied
        // to a running agy process (--model/--effort are spawn-time flags):
        // recycle it and let the creation path below spawn the new one with
        // the same branch conversation id.
        entry.lane.destroy();
        this.drop(sessionID);
      } else if (
        entry.lane.conversationID &&
        request.conversationId &&
        entry.lane.conversationID !== request.conversationId
      ) {
        // Stale lane for a diverged branch: recycle here; the creation
        // path below re-seeds the replacement with the new conversation id.
        entry.lane.destroy();
        this.drop(sessionID);
      }
    }
    let lane = this.lanes.get(sessionID)?.lane;
    if (!lane) {
      // E5 resume (scripts/experiments/e5-resume-lane.mjs, RESUME_LANE_OK):
      // a fresh process spawned WITH --conversation <id> resumes that
      // conversation on the persistent stdin lane. A missing lane is
      // therefore ALWAYS created — seeded with the branch's live
      // conversation id when present (hot resume), fresh otherwise
      // (bootstrap). Exactly ONE spawn per bootstrap / post-eviction
      // re-hydration / crash, then hot again.
      lane = new WarmLane(spawnInfo.model, spawnInfo.effort, spawnInfo.workspaceDir, this.spawnImpl, this.bounds.turnMaxMs, request.conversationId);
      try {
        lane.ensureSpawned();
      } catch {
        return null; // cannot spawn: Option A owns the request.
      }
      const idleTimer = setTimeout(() => {
        const current = this.lanes.get(sessionID);
        // Eviction ONLY at idle (timer cancelled while busy).
        if (current && !current.lane.inFlight) {
          current.lane.destroy();
          this.drop(sessionID);
        }
      }, this.bounds.idleMs);
      idleTimer.unref?.();
      this.lanes.set(sessionID, { lane, idleTimer });
    }
    try {
      const result = await lane.runTurn(request);
      this.lastUsed.set(sessionID, Date.now());
      this.armIdle(sessionID);
      this.enforceMaxLanes();
      return result;
    } catch (err) {
      lane.destroy();
      this.drop(sessionID);
      throw err;
    }
  }

  private armIdle(sessionID: string): void {
    const entry = this.lanes.get(sessionID);
    if (!entry) {
      return;
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = setTimeout(() => {
      const current = this.lanes.get(sessionID);
      if (current && !current.lane.inFlight) {
        current.lane.destroy();
        this.drop(sessionID);
      }
    }, this.bounds.idleMs);
    entry.idleTimer.unref?.();
  }

  private enforceMaxLanes(): void {
    while (this.lanes.size > this.bounds.maxLanes) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [key] of this.lanes.entries()) {
        const lane = this.lanes.get(key)?.lane;
        if (!lane || lane.inFlight) {
          continue;
        }
        const used = this.lastUsed.get(key) ?? 0;
        if (used < oldestAt) {
          oldestAt = used;
          oldestKey = key;
        }
      }
      if (oldestKey === null) {
        break;
      }
      this.lanes.get(oldestKey)?.lane.destroy();
      this.drop(oldestKey);
    }
  }

  drop(sessionID: string): void {
    const entry = this.lanes.get(sessionID);
    if (entry?.idleTimer) {
      clearTimeout(entry.idleTimer);
    }
    this.lanes.delete(sessionID);
    this.lastUsed.delete(sessionID);
  }

  /** Kill every lane (daemon shutdown). */
  destroyAll(): void {
    for (const key of [...this.lanes.keys()]) {
      this.lanes.get(key)?.lane.destroy();
      this.drop(key);
    }
  }
}
