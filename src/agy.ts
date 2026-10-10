// Adapter that spawns the official `agy` binary for one stateless turn per
// request and parses its `--output-format stream-json` NDJSON protocol.
//
// The parser is intentionally tolerant: agy may print human-readable lead
// lines (e.g. "Fetching available models..." style progress) that are not
// JSON. Those lines are skipped and reported as warnings instead of failing
// the turn.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import type { Effort } from './catalog';

export type { Effort };

export const DEFAULT_TIMEOUT_MS = 120_000;
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const MAX_VERBATIM_CHARS = 4000;

export function timeoutMsFromEnv(): number {
  const raw = process.env.AGY_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

/**
 * Environment for agy child processes (security audit 2026-10-09). agy is
 * a full agent; it has no business seeing the credentials of every other
 * tool the user runs (opencode passes its whole environment down). Variables
 * whose NAME looks like a credential are dropped; AGY_ENV_PASSTHROUGH
 * (comma-separated names) keeps specific ones when a setup really needs them.
 */
const SECRET_ENV_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)(?:$|_)/i;

export function agyChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set(
    (source.AGY_ENV_PASSTHROUGH ?? '')
      .split(',')
      .map((name) => name.trim().toUpperCase())
      .filter(Boolean),
  );
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (SECRET_ENV_NAME.test(name) && !keep.has(name.toUpperCase())) {
      continue;
    }
    env[name] = value;
  }
  return env;
}

/** Resolve the agy binary: AGY_BIN wins, else the official install location. */
export function resolveAgyBinary(): string {
  const override = process.env.AGY_BIN?.trim();
  if (override) {
    return override;
  }
  const localAppData = process.env.LOCALAPPDATA ?? process.env.LocalAppData;
  if (localAppData) {
    return path.join(localAppData, 'agy', 'bin', 'agy.exe');
  }
  // Non-Windows fallback: rely on PATH.
  return 'agy';
}

export class AgyBinaryMissingError extends Error {
  readonly binaryPath: string;
  constructor(binaryPath: string) {
    super(
      `agy binary not found at "${binaryPath}". ` +
        'Install the official agy CLI (v1.3.1) or set AGY_BIN to its full path.',
    );
    this.name = 'AgyBinaryMissingError';
    this.binaryPath = binaryPath;
  }
}

export class AgyExitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = 'AgyExitError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class AgyTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`agy turn timed out after ${timeoutMs} ms; the agy process was killed.`);
    this.name = 'AgyTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The turn ended with an empty response because the model tried to use a tool
 * and headless mode auto-denied it (the bridge is chat-only until the
 * tool-calling relay lands). Surfaced as an error instead of silent empty text.
 */
export class AgyToolDeniedError extends Error {
  readonly deniedActions: string[];
  constructor(deniedActions: string[]) {
    super(
      'agy produced no output: the model attempted a tool action that headless mode ' +
        'auto-denied (the bridge is chat-only for now). Denied actions: ' +
        (deniedActions.length > 0 ? deniedActions.join(', ') : '(unknown)') +
        '. Answer without tool usage or wait for the tool-calling relay slice.',
    );
    this.name = 'AgyToolDeniedError';
    this.deniedActions = deniedActions;
  }
}

/**
 * The client disconnected or interrupted the request; the agy process is
 * killed so it stops consuming plan quota and bridge slots.
 */
export class AgyAbortedError extends Error {
  constructor() {
    super('agy turn aborted by the client (disconnect or interrupt).');
    this.name = 'AgyAbortedError';
  }
}

/**
 * The `init` event's conversation id did not match the resumed id (E8:
 * agy silently starts a fresh conversation for unknown ids). The process
 * tree was killed BEFORE any model output; the caller must bootstrap a
 * fresh branch instead of trusting the mismatched conversation.
 */
export class AgyConversationMismatchError extends Error {
  readonly expectedId: string;
  readonly actualId: string;
  constructor(expectedId: string, actualId: string) {
    super(
      `agy conversation mismatch: requested resume of "${expectedId}" but agy ` +
        `initialized conversation "${actualId}". The agy process was killed before ` +
        `any model output; bootstrap a fresh conversation instead.`,
    );
    this.name = 'AgyConversationMismatchError';
    this.expectedId = expectedId;
    this.actualId = actualId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse one NDJSON line. Returns the event object, or null when the line is
 * blank or not JSON (a skipped lead/log line, never a failure).
 */
export function parseNdjsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export type StreamEventKind = 'init' | 'step_update' | 'result' | 'other';

export function eventKind(event: Record<string, unknown>): StreamEventKind {
  for (const key of ['type', 'event', 'kind'] as const) {
    const value = event[key];
    if (value === 'init' || value === 'step_update' || value === 'result') {
      return value;
    }
  }
  return 'other';
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value) && typeof value['text'] === 'string') {
    return value['text'];
  }
  return null;
}

/** Nested agy payload: events wrap data under their kind key. */
function nestedPayload(event: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ['step_update', 'result', 'init', 'data', 'payload']) {
    const value = event[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return null;
}

const DELTA_KEYS = ['text_delta', 'textDelta', 'content_delta', 'contentDelta', 'delta'];

/** Incremental text carried by a streaming event (empty when none). */
export function extractTextDelta(event: Record<string, unknown>): string {
  const nested = nestedPayload(event);
  const sources = nested ? [nested, event] : [event];
  for (const source of sources) {
    for (const key of DELTA_KEYS) {
      if (!(key in source)) {
        continue;
      }
      const text = asText(source[key]);
      if (text) {
        return text;
      }
    }
  }
  return '';
}

/** Full answer text carried by a terminal `result` event (empty when none). */
export function extractResultText(event: Record<string, unknown>): string {
  const nested = nestedPayload(event);
  const sources = nested ? [nested, event] : [event];
  for (const source of sources) {
    for (const key of ['response', 'result', 'text', 'output', 'content']) {
      if (!(key in source)) {
        continue;
      }
      const text = asText(source[key]);
      if (text) {
        return text;
      }
    }
  }
  const message = (nested ?? event)['message'];
  if (isRecord(message)) {
    const text = asText(message['content']);
    if (text) {
      return text;
    }
  }
  return '';
}

export interface AgyUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thinkingTokens?: number;
  cacheReadTokens?: number;
}

function asNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

/** Pull token usage (including thinking_tokens) out of an event, if present. */
export function extractUsage(event: Record<string, unknown>): AgyUsage | null {
  const nested = nestedPayload(event);
  const candidates: Array<Record<string, unknown>> = [event];
  if (nested) {
    candidates.unshift(nested);
  }
  for (const holder of candidates) {
    const sources: Array<Record<string, unknown>> = [holder];
    for (const key of ['usage', 'tokenUsage', 'tokens']) {
      const value = holder[key];
      if (isRecord(value)) {
        sources.unshift(value);
      }
    }
    for (const source of sources) {
      const usage: AgyUsage = {
        inputTokens:
          asNonNegativeInt(source['input_tokens']) ??
          asNonNegativeInt(source['prompt_tokens']),
        outputTokens:
          asNonNegativeInt(source['output_tokens']) ??
          asNonNegativeInt(source['completion_tokens']),
        totalTokens:
          asNonNegativeInt(source['total_tokens']) ??
          asNonNegativeInt(source['totalTokens']),
        thinkingTokens:
          asNonNegativeInt(source['thinking_tokens']) ??
          asNonNegativeInt(source['thinkingTokens']),
        cacheReadTokens:
          asNonNegativeInt(source['cache_read_tokens']) ??
          asNonNegativeInt(source['cacheReadTokens']) ??
          asNonNegativeInt(source['cached_tokens']),
      };
      if (
        usage.inputTokens !== undefined ||
        usage.outputTokens !== undefined ||
        usage.totalTokens !== undefined ||
        usage.thinkingTokens !== undefined ||
        usage.cacheReadTokens !== undefined
      ) {
        return usage;
      }
    }
  }
  return null;
}

/** Map agy usage to the OpenAI usage shape (thinking tokens pass through). */
export function toOpenAIUsage(usage: AgyUsage | null): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  thinking_tokens?: number;
  cached_tokens?: number;
} {
  const input = usage?.inputTokens ?? 0;
  const cacheRead = usage?.cacheReadTokens ?? 0;
  // Design slice3 §3: opencode's overflow math must see the true context
  // size, so cached prefix tokens count toward prompt_tokens.
  const prompt = input + cacheRead;
  const completion = usage?.outputTokens ?? 0;
  // Keep total consistent with the inflated prompt. With no cache_read the
  // historical passthrough (agy total when present) is preserved so existing
  // turns are byte-identical.
  const total =
    usage?.totalTokens !== undefined && cacheRead === 0
      ? usage.totalTokens
      : prompt + completion;
  const out: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    thinking_tokens?: number;
    cached_tokens?: number;
  } = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
  if (usage?.thinkingTokens !== undefined) {
    out.thinking_tokens = usage.thinkingTokens;
  }
  if (cacheRead > 0) {
    out.cached_tokens = cacheRead;
  }
  return out;
}

export interface CollectedTurn {
  text: string;
  usage: AgyUsage | null;
  warnings: string[];
  resultEvent: Record<string, unknown> | null;
  /** Display names of tool actions agy auto-denied in this turn, if any. */
  deniedActions: string[];
}

/**
 * Pure NDJSON collector: feeds lines, accumulates incremental deltas, merges
 * usage, skips non-JSON lines with warnings. Falls back to the terminal
 * result text when no incremental deltas were observed.
 *
 * Usage semantics (verified live, E11): agy reports usage twice per turn with
 * DIFFERENT meanings. The step_update event carries the per-turn usage (the
 * real input this turn actually consumed), while the terminal result event
 * carries SESSION-CUMULATIVE totals. Preferring the result event inflated
 * reported context (a ~100K-token live chat reported as 1,305,129 tokens,
 * which tripped opencode's auto-compaction against the declared 1M window).
 * Per-turn usage therefore wins when present; the result event is only a
 * fallback (first turn, or turns with no step_update usage).
 */
export function collectTurn(lines: Iterable<string>): CollectedTurn {
  let text = '';
  let turnUsage: AgyUsage | null = null;
  let resultUsage: AgyUsage | null = null;
  const warnings: string[] = [];
  let resultEvent: Record<string, unknown> | null = null;
  let sawDelta = false;
  let deniedActions: string[] = [];

  for (const line of lines) {
    const event = parseNdjsonLine(line);
    if (!event) {
      if (line.trim()) {
        warnings.push(`skipped non-JSON line: ${line.trim().slice(0, 200)}`);
      }
      continue;
    }
    const kind = eventKind(event);
    if (kind === 'step_update' || kind === 'other') {
      const delta = extractTextDelta(event);
      if (delta) {
        text += delta;
        sawDelta = true;
      }
    }
    const eventUsage = extractUsage(event);
    if (eventUsage) {
      if (kind === 'step_update') {
        turnUsage = { ...(turnUsage ?? {}), ...eventUsage };
      } else {
        resultUsage = { ...(resultUsage ?? {}), ...eventUsage };
      }
    }
    if (kind === 'result') {
      resultEvent = event;
      deniedActions = extractDeniedActions(event);
    }
  }

  if (!sawDelta && resultEvent) {
    text = extractResultText(resultEvent);
  }
  return { text, usage: turnUsage ?? resultUsage, warnings, resultEvent, deniedActions };
}

/** Display names of tool actions agy auto-denied, from a terminal result event. */
export function extractDeniedActions(resultEvent: Record<string, unknown>): string[] {
  const nested = nestedPayload(resultEvent);
  const sources: Array<Record<string, unknown>> = [resultEvent];
  if (nested) {
    sources.unshift(nested);
  }
  for (const holder of sources) {
    const denied = holder['denied_actions'];
    if (!Array.isArray(denied)) {
      continue;
    }
    const names: string[] = [];
    for (const entry of denied as unknown[]) {
      if (!isRecord(entry)) {
        continue;
      }
      const name =
        (typeof entry['display_name'] === 'string' ? entry['display_name'] : undefined) ??
        (typeof entry['action'] === 'string' ? entry['action'] : undefined);
      if (name) {
        names.push(name);
      }
    }
    if (names.length > 0) {
      return names;
    }
  }
  return [];
}

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    // /T kills the whole tree; failures are best-effort (process may be gone).
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => undefined);
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited; nothing to do.
  }
}

function truncateVerbatim(value: string): string {
  return value.length > MAX_VERBATIM_CHARS
    ? value.slice(0, MAX_VERBATIM_CHARS) + '…[truncated]'
    : value;
}

export interface TurnRequest {
  model: string;
  effort?: Effort | null;
  prompt: string;
  timeoutMs?: number;
  binaryPath?: string;
  /**
   * Abort signal from the client (disconnect / user interrupt). On abort the
   * agy process tree is killed so it stops consuming plan quota and a bridge
   * concurrency slot.
   */
  signal?: AbortSignal;
  /**
   * Resume-by-id (Option A): adds `--conversation <id>`. Undefined = fresh
   * conversation; the init event's id is still captured and returned.
   */
  conversationId?: string;
  /**
   * Spawn cwd for the turn. Session mode pins one dedicated neutral dir per
   * conversation (never the repo); resume reuses it.
   */
  workspaceDir?: string;
  /**
   * Called the moment the `init` NDJSON event parses, BEFORE any model output
   * handling. Return 'kill' to kill the process tree immediately and reject
   * with AgyConversationMismatchError. Never throws the turn by itself: a
   * throwing callback is treated as 'continue' (loud warning).
   */
  onInit?: (conversationId: string) => 'continue' | 'kill';
  /**
   * Test hook: replace the agy invocation with a fake long-running command.
   * Never set outside tests.
   */
  commandOverride?: { cmd: string; args: string[] };
}

export interface TurnResult {
  text: string;
  usage: AgyUsage | null;
  warnings: string[];
  /** Display names of tool actions agy auto-denied in this turn, if any. */
  deniedActions: string[];
  /** Conversation id from the init event (undefined when agy sent none). */
  conversationId?: string;
}

/**
 * Pure + exported for tests: argv for one turn. `--conversation <id>` is
 * appended only when resuming; NEVER `--continue` (it would hijack the
 * user's own most-recent interactive agy session).
 */
export function buildAgyArgs(request: Pick<TurnRequest, 'model' | 'effort' | 'conversationId'>): string[] {
  return [
    '--output-format',
    'stream-json',
    '--model',
    request.model,
    ...(request.effort ? ['--effort', request.effort] : []),
    '--input-format',
    'text',
    '--disable-slash-commands',
    ...(request.conversationId ? ['--conversation', request.conversationId] : []),
  ];
}

/** Conversation id carried by an init event (top-level or nested). Loud-safe. */
export function extractConversationId(event: Record<string, unknown>): string | null {
  const holders: Array<Record<string, unknown>> = [event];
  const nested = nestedPayload(event);
  if (nested) {
    holders.unshift(nested);
  }
  for (const holder of holders) {
    for (const key of ['conversation_id', 'conversationId', 'conversationID']) {
      const value = holder[key];
      if (typeof value === 'string' && value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Run one stateless agy turn: spawn
 * `agy --output-format stream-json --model <base> [--effort <e>]`
 *      `--input-format text --disable-slash-commands`
 * and invoke onDelta live for every incremental text delta as it arrives on
 * stdout.
 *
 * NOTE: the prompt travels on STDIN (`--input-format text`), never as an
 * argv value: opencode requests carry the client's full system prompt (tens
 * of thousands of chars), which overflows the Windows ~32K argv limit and
 * crashes spawn with ENAMETOOLONG. `--disable-slash-commands` keeps the
 * prompt literal (no slash-command/skill expansion) in bridge chat.
 */
export function runAgyTurn(
  request: TurnRequest,
  onDelta?: (chunk: string) => void,
): Promise<TurnResult> {
  // An already-aborted signal never fires 'abort' for listeners attached
  // afterwards: reject now and spawn nothing (no wasted plan quota).
  if (request.signal?.aborted) {
    return Promise.reject(new AgyAbortedError());
  }
  const binary = request.binaryPath ?? resolveAgyBinary();
  const timeoutMs = request.timeoutMs ?? timeoutMsFromEnv();
  const cmd = request.commandOverride?.cmd ?? binary;
  const args = request.commandOverride
    ? request.commandOverride.args
    : buildAgyArgs(request);

  return new Promise<TurnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: agyChildEnv(),
        // Session mode pins a dedicated neutral dir per conversation; resume
        // reuses it. Undefined = inherit the daemon cwd (legacy behavior).
        ...(request.workspaceDir ? { cwd: request.workspaceDir } : {}),
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdoutBuffer = '';
    let stderr = '';
    let text = '';
    // Usage split (E11 semantics): step_update usage is per-turn; result-event
    // usage is session-cumulative. Per-turn wins when observed.
    let turnUsage: AgyUsage | null = null;
    let resultUsage: AgyUsage | null = null;
    const warnings: string[] = [];
    let resultEvent: Record<string, unknown> | null = null;
    let sawDelta = false;
    let settled = false;
    let initConversationId: string | undefined;

    const settleResolve = (result: TurnResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      resolve(result);
    };
    const settleReject = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanupAbort();
      reject(err);
    };

    const timer = setTimeout(() => {
      killProcessTree(child);
      settleReject(new AgyTimeoutError(timeoutMs));
    }, timeoutMs);
    // The timer must not keep the bridge alive on its own.
    timer.unref?.();

    const onAbort = (): void => {
      killProcessTree(child);
      settleReject(new AgyAbortedError());
    };
    const cleanupAbort = (): void => {
      request.signal?.removeEventListener('abort', onAbort);
    };
    request.signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line: string): void => {
      const event = parseNdjsonLine(line);
      if (!event) {
        if (line.trim()) {
          warnings.push(`skipped non-JSON line: ${line.trim().slice(0, 200)}`);
        }
        return;
      }
      const kind = eventKind(event);
      if (kind === 'init') {
        // Init-mismatch gate: runs BEFORE any model output handling. A
        // resumed id agy does not know comes back as a DIFFERENT id (silent
        // fresh conversation) — kill before it can answer contextless.
        const actualId = extractConversationId(event);
        if (actualId && initConversationId === undefined) {
          initConversationId = actualId;
          let decision: 'continue' | 'kill' = 'continue';
          if (request.onInit) {
            try {
              decision = request.onInit(actualId);
            } catch (err) {
              warnings.push(
                `onInit callback threw (${(err as Error).message}); continuing turn`,
              );
              decision = 'continue';
            }
          }
          if (decision === 'kill') {
            killProcessTree(child);
            settleReject(
              new AgyConversationMismatchError(request.conversationId ?? '(new)', actualId),
            );
            return;
          }
        }
      }
      if (kind === 'step_update' || kind === 'other') {
        const delta = extractTextDelta(event);
        if (delta) {
          text += delta;
          sawDelta = true;
          try {
            onDelta?.(delta);
          } catch {
            // A failing consumer callback must not fail the turn.
          }
        }
      }
      const eventUsage = extractUsage(event);
      if (eventUsage) {
        if (kind === 'step_update') {
          turnUsage = { ...(turnUsage ?? {}), ...eventUsage };
        } else {
          resultUsage = { ...(resultUsage ?? {}), ...eventUsage };
        }
      }
      if (kind === 'result') {
        resultEvent = event;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        handleLine(stdoutBuffer.slice(0, newlineIndex));
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error & { code?: string }) => {
      if (err.code === 'ENOENT') {
        settleReject(new AgyBinaryMissingError(binary));
        return;
      }
      settleReject(err);
    });
    child.on('close', (code) => {
      if (stdoutBuffer.length > 0) {
        handleLine(stdoutBuffer);
        stdoutBuffer = '';
      }
      const deniedActions = resultEvent ? extractDeniedActions(resultEvent) : [];
      if (!sawDelta && resultEvent) {
        text = extractResultText(resultEvent);
      }
      if (code !== 0) {
        const detail = stderr.trim() || `agy exited with code ${String(code)}`;
        settleReject(new AgyExitError(truncateVerbatim(detail), code, stderr));
        return;
      }
      settleResolve({
        text,
        usage: turnUsage ?? resultUsage,
        warnings,
        deniedActions,
        ...(initConversationId ? { conversationId: initConversationId } : {}),
      });
    });

    try {
      // Prompt travels on stdin (`--input-format text`), then EOF.
      child.stdin?.write(request.prompt);
      child.stdin?.end();
    } catch (err) {
      settleReject(err as Error);
    }
  });
}

export interface AgyStatus {
  binaryPath: string;
  version: string | null;
  reachable: boolean;
  warning: string | null;
}

let cachedStatus: AgyStatus | null = null;
let probeInFlight = false;

/**
 * Best-effort startup status. Kicks off a non-blocking `agy --version` probe
 * on first call; if `--version` is not a valid flag, falls back to `--help`
 * output, and otherwise degrades to a warning. Never throws.
 */
export function getAgyStatus(): AgyStatus {
  if (!cachedStatus) {
    cachedStatus = {
      binaryPath: resolveAgyBinary(),
      version: null,
      reachable: false,
      warning: 'version probe has not completed yet',
    };
    startVersionProbe();
  }
  return cachedStatus;
}

function startVersionProbe(): void {
  if (probeInFlight) {
    return;
  }
  probeInFlight = true;
  const binary = resolveAgyBinary();
  execFile(binary, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS }, (versionErr, stdout) => {
    const version = typeof stdout === 'string' ? stdout.trim() : '';
    if (!versionErr && version) {
      cachedStatus = { binaryPath: binary, version, reachable: true, warning: null };
      return;
    }
    // Fallback: derive reachability from --help instead of failing startup.
    execFile(binary, ['--help'], { timeout: VERSION_PROBE_TIMEOUT_MS }, (helpErr) => {
      if (!helpErr) {
        cachedStatus = {
          binaryPath: binary,
          version: null,
          reachable: true,
          warning: 'agy --version is not a valid flag; reachability confirmed via --help',
        };
        return;
      }
      const code = (helpErr as NodeJS.ErrnoException)?.code;
      cachedStatus = {
        binaryPath: binary,
        version: null,
        reachable: false,
        warning:
          code === 'ENOENT'
            ? `agy binary not found at "${binary}". Install the official agy CLI (v1.3.1) or set AGY_BIN to its full path.`
            : `agy probe failed: ${(helpErr as Error).message}`,
      };
    });
  });
}
