// OpenAI-compatible HTTP bridge over the agy CLI.
//
// Binds 127.0.0.1 only. Routes:
//   GET  /healthz               liveness + agy binary status
//   GET  /v1/models             OpenAI-shaped model listing from the catalog
//   POST /v1/chat/completions   non-stream JSON or SSE stream (OpenAI shapes)

import Fastify, { type FastifyInstance } from 'fastify';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgyAbortedError,
  AgyBinaryMissingError,
  AgyConversationMismatchError,
  AgyExitError,
  AgyTimeoutError,
  AgyToolDeniedError,
  getAgyStatus,
  runAgyTurn,
  toOpenAIUsage,
  type AgyUsage,
  type Effort,
} from './agy';
import { findModel, parseEffort, toOpenAIModelList } from './catalog';
import {
  ledgerDigests,
  ledgerMessages,
  provisionalDigestForResponse,
  sha1Hex,
  systemDigest,
} from './digests';
import {
  buildDeltaPrompt,
  chunkBootstrapEnabled,
  chunkBootstrapPrompts,
  confirmTurn,
  createBranch,
  DIVERGENCE_NOTE,
  liveBranches,
  markBranchDirty,
  selectBranch,
} from './sessionManager';
import {
  ensureWorkspaceDir,
  getBootId,
  loadSessionRecord,
  saveSessionRecord,
  sessionsDir,
  withSessionLock,
  type BranchRecord,
  type SessionRecord,
} from './sessionStore';
import { WarmLaneManager, warmLaneEnabled } from './warmLane';

/** T18: latest spawn info per session for warm-lane construction. */
const sessionModelOptions = new Map<string, { model: string; effort: string | null; workspaceDir?: string }>();
let warmLaneManagerRef: WarmLaneManager | null = null;

/** T18: used by the daemon shutdown path — kill every warm lane. */
export function destroyAllWarmLanes(): void {
  warmLaneManagerRef?.destroyAll();
}

export const DEFAULT_PORT = 41667;
export const MAX_CONCURRENT_TURNS = 3;

// Phase 0 observability: single-line request logger (console + optional file).
// File target comes from AGY_BRIDGE_LOG; parent dir is created on first use.
// Append-only, UTF-8 without BOM. Never throws.
let bridgeLogDirEnsuredFor: string | null = null;

function bridgeLogFile(): string | null {
  const raw = process.env.AGY_BRIDGE_LOG?.trim();
  return raw ? raw : null;
}

function appendBridgeLog(line: string): void {
  try {
    console.error(line);
    const file = bridgeLogFile();
    if (!file) {
      return;
    }
    try {
      if (bridgeLogDirEnsuredFor !== file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        bridgeLogDirEnsuredFor = file;
      }
      fs.appendFileSync(file, line + '\n', { encoding: 'utf8' });
    } catch {
      // File logging is best-effort; console line already emitted.
    }
  } catch {
    // Logging must never break a request.
  }
}

function headerText(headers: Record<string, unknown>, name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' && first ? first : '-';
  }
  if (typeof value === 'string' && value) {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return '-';
}

function identityFromHeaders(headers: Record<string, unknown>): {
  sessionId: string;
  agent: string;
  msgId: string;
  parentSessionId: string;
} {
  return {
    sessionId: headerText(headers, 'x-agy-session-id'),
    agent: headerText(headers, 'x-agy-agent'),
    msgId: headerText(headers, 'x-agy-message-id'),
    parentSessionId: headerText(headers, 'x-agy-parent-session-id'),
  };
}

function logBridgeLine(
  method: string,
  urlPath: string,
  status: string | number,
  sessionId: string,
  agent: string,
  msgId: string,
  extra?: string,
): void {
  const ts = new Date().toISOString();
  const base =
    `${ts} | ${method} | ${urlPath} | ${String(status)} | ` +
    `sessionId=${sessionId} | agent=${agent} | msgId=${msgId}`;
  appendBridgeLog(extra ? `${base} | ${extra}` : base);
}

function usageSummary(usage: AgyUsage | null): string {
  const mapped = toOpenAIUsage(usage);
  return (
    `prompt=${mapped.prompt_tokens} completion=${mapped.completion_tokens} ` +
    `total=${mapped.total_tokens} cached=${mapped.cached_tokens ?? 0}`
  );
}

function errorCodeFromBody(body: unknown): string {
  if (typeof body === 'object' && body !== null) {
    const err = (body as Record<string, unknown>)['error'];
    if (typeof err === 'object' && err !== null) {
      const code = (err as Record<string, unknown>)['code'];
      if (typeof code === 'string' && code) {
        return code;
      }
    }
  }
  return 'unknown';
}

export interface TurnAdapter {
  runTurn(
    request: {
      model: string;
      effort: Effort | null;
      prompt: string;
      signal?: AbortSignal;
      /** Resume-by-id; undefined = fresh conversation. */
      conversationId?: string;
      /** Pinned spawn cwd for the turn. */
      workspaceDir?: string;
      /** Init-event gate (mismatch kill); fakes may ignore it. */
      onInit?: (conversationId: string) => 'continue' | 'kill';
      /** T18: opencode session id; warm lanes are keyed by it. */
      sessionID?: string;
    },
    onDelta?: (chunk: string) => void,
  ): Promise<{ text: string; usage: AgyUsage | null; conversationId?: string }>;
}

export const defaultAdapter: TurnAdapter = {
  runTurn: async (request, onDelta) => {
    const result = await runAgyTurn(
      {
        model: request.model,
        effort: request.effort,
        prompt: request.prompt,
        signal: request.signal,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.workspaceDir ? { workspaceDir: request.workspaceDir } : {}),
        ...(request.onInit ? { onInit: request.onInit } : {}),
      },
      onDelta,
    );
    // A denied tool action ends the turn with an empty response; that MUST be
    // an error the client can see, not a silent 200 with empty text.
    if (!result.text && result.deniedActions.length > 0) {
      throw new AgyToolDeniedError(result.deniedActions);
    }
    return {
      text: result.text,
      usage: result.usage,
      ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    };
  },
};

interface ChatMessagePart {
  type?: unknown;
  text?: unknown;
}

function messageContentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as ChatMessagePart[])
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text as string)
      .join('');
  }
  return '';
}

/**
 * Chat-only preamble. In tools mode this is replaced by the tools manifest
 * (slice 2: tool-calling relay). agy's own agentic tools must stay unused in
 * Mode A (approved separation of powers: single writer = opencode). Without
 * this, the model sometimes tries an MCP / browser / filesystem tool, agy
 * auto-denies it in headless mode, and the turn ends with an empty response.
 */
const CHAT_ONLY_PREAMBLE = [
  'IMPORTANT: answer in plain text only. Do NOT call any tools — not MCP tools,',
  'not browser tools, not filesystem tools, none. If normal chat answers the',
  'request, skip all tool usage and reply directly.',
].join(' ');

const CHAT_ONLY_REMINDER = 'Reminder: reply with plain text directly; do NOT use any tools.';

/**
 * Corrective retry prompt after agy attempted one of its own runtime tools
 * and headless auto-denied it (denied_actions + empty text). The OLD failure
 * mode was a hard 400 that killed the whole request; instead the model gets
 * ONE corrective turn that REDIRECTS tool usage to the client relay: an
 * AGENT tool must be requested via the TOOL_CALL: marker (opencode executes
 * it), and only when no listed tool applies may the model fall back to
 * plain text. With no client tools, plain text is the only channel.
 *
 * In session mode agy retains the conversation, so only the instruction
 * travels (`sessionHeader` prefixes it). In legacy (stateless) mode the
 * caller re-sends the full original prompt with this correction appended.
 */
export function buildDeniedCorrectionPrompt(args: {
  deniedActions: string[];
  toolsMode: boolean;
  sessionHeader?: string;
}): string {
  const denied = args.deniedActions.length ? args.deniedActions.join(', ') : 'runtime tools';
  const lines: string[] = [];
  if (args.sessionHeader) {
    lines.push(args.sessionHeader);
    lines.push('');
  }
  if (args.toolsMode) {
    lines.push(
      `CORRECTION: your previous turn attempted runtime tool action(s) (${denied}) and they were ` +
        'auto-denied — those tools are unavailable to you. ' +
        'To call a tool, emit ONE marker line first, exactly: ' +
        'TOOL_CALL: {"name": "<tool>", "arguments": {<json args>}} — naming ONE of the AGENT tools ' +
        'from your manifest; the client executes it and sends the result back. ' +
        'If none of the listed AGENT tools applies to the request, answer the request in plain text. ' +
        'Do NOT attempt runtime tools again.',
    );
  } else {
    lines.push(
      `CORRECTION: your previous turn attempted runtime tool action(s) (${denied}) and they were ` +
        'auto-denied. No client tools are available in this conversation. ' +
        'Answer the previous request now in plain text, without invoking any tool.',
    );
  }
  return lines.join('\n');
}

/** Marker prefix the model must emit (line-leading) to request a tool call. */
export const TOOL_CALL_PREFIX = 'TOOL_CALL:';

const TOOL_CALL_INSTRUCTIONS = [
  'You may call ONE of the AGENT-CIENT tools below when needed by emitting a single marker line first in your reply: TOOL_CALL: {"name": "<tool name>", "arguments": {<json args>}}.',
  'After the marker line, write nothing else for this turn — the tool will be executed by the client and its result will be sent back in a follow-up request.',
  'If no tool is needed or the request is pure conversation/knowledge, skip the marker entirely and answer in plain text.',
  'Only use tools whose names appear below.',
  'IMPORTANT: do NOT use any tools from your own runtime — no built-in filesystem/shell/browser tools, no MCP tools, none. Those are unavailable in this turn and attempting them auto-fails; the TOOL_CALL marker against the tool list below is the ONLY tool mechanism you have.',
].join(' ');

const TOOLS_MODE_REMINDER =
  'Reminder: to use a tool, emit the TOOL_CALL: marker line first; otherwise answer in plain text.';

/** One validated OpenAI function definition, as sent by the client per request. */
export interface ParsedToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

/**
 * Tool-description nudges: surgical steering for three opencode client
 * tools, applied to the manifest the model sees. Idempotent — a
 * description that already carries the nudge is returned untouched.
 * Tools with no client description get the nudge as their description.
 */
export const WRITE_EDIT_DESCRIPTION_NUDGE =
  'PREFERRED over shell heredocs/redirects for CREATING or MODIFYING files. ' +
  'Using this tool shows the user a reviewable diff; shell redirection hides the change.';

export function applyToolDescriptionNudge(name: string, description: string): string {
  const nudge =
    name === 'write' || name === 'edit'
      ? WRITE_EDIT_DESCRIPTION_NUDGE
      : null;
  if (!nudge) {
    return description;
  }
  if (description.includes(nudge)) {
    return description;
  }
  if (!description || description === '(no description)') {
    return nudge;
  }
  return `${description} ${nudge}`;
}

/**
 * Validate the request's `tools` array. Returns only well-formed
 * `{type:"function", function:{name,...}}` entries; anything else is ignored.
 * An empty result means chat-only mode.
 */
export function parseToolDefinitions(tools: unknown): ParsedToolDef[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const defs: ParsedToolDef[] = [];
  for (const item of tools) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record['type'] !== 'function') {
      continue;
    }
    const fn = record['function'];
    if (typeof fn !== 'object' || fn === null) {
      continue;
    }
    const fnRecord = fn as Record<string, unknown>;
    if (typeof fnRecord['name'] !== 'string' || fnRecord['name'].length === 0) {
      continue;
    }
    const toolName = fnRecord['name'];
    // Subagent-delegation boundary (design decision): the agy provider must
    // do ALL work itself — orchestration stays opencode-side. `task` is
    // removed from the manifest, from allowedNames, and nudges; any emitted
    // `TOOL_CALL: task` streams back as plain text (hallucinated tool rule).
    if (toolName === 'task') {
      continue;
    }
    const description =
      typeof fnRecord['description'] === 'string' && fnRecord['description'].trim()
        ? fnRecord['description'].trim().split('\n')[0]!.trim()
        : '(no description)';
    defs.push({
      name: toolName,
      description: applyToolDescriptionNudge(toolName, description),
      parameters: fnRecord['parameters'],
    });
  }
  return defs;
}

/**
 * Compact per-turn protocol reminder injected into EVERY session delta
 * prompt when toolsMode is on. Rationale: the full manifest rides only on
 * the bootstrap prompt; delta turns otherwise rely on in-conversation
 * memory, and drift showed up as fabricated tool activity. ~0.7KB cost.
 */
export function deltaProtocolReminder(): string {
  return (
    '# PROTOCOL REMINDER (authoritative, applies THIS turn)\n' +
    'You are a bridge-agent: the opencode runtime executes tools for you. ' +
    'To call any tool, emit at the END of your turn one line EXACTLY:\n' +
    'TOOL_CALL: <tool> {"arg":"value"}\n' +
    'Only an emitted marker executes; prose claiming an action ("acabo de hacer...") is NOT an action.\n' +
    'BOUNDARY (plugin runtime): while running under the agy-bridge plugin you MUST NOT ' +
    'launch subagents or delegate work — the task tool does not exist here and any ' +
    'TOOL_CALL: task is void. When the user asks you to delegate or research something, ' +
    'perform the work yourself inline and summarize the result.'
  );
}

/** Build the tools-mode preamble from ONLY the definitions the client sent. */
function buildToolsPreamble(defs: ParsedToolDef[]): string {
  const lines: string[] = [TOOL_CALL_INSTRUCTIONS];
  for (const def of defs) {
    lines.push(`### ${def.name} — ${def.description}`);
    if (def.parameters !== undefined) {
      try {
        lines.push(JSON.stringify(def.parameters));
      } catch {
        lines.push(String(def.parameters));
      }
    }
  }
  return lines.join('\n');
}

/**
 * Remainder after the marker prefix, or null when the line is not a marker.
 * The model may legitimately discuss markers in prose, so the guard is
 * strict: after leading whitespace the line must start with the exact
 * instruction prefix `TOOL_CALL:`.
 */
function markerRemainder(line: string): string | null {
  const trimmed = line.replace(/^\s+/, '');
  if (!trimmed.startsWith(TOOL_CALL_PREFIX)) {
    return null;
  }
  return trimmed.slice(TOOL_CALL_PREFIX.length);
}

/** Drop a trailing ``` fence so fenced JSON still parses. */function stripTrailingFence(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('```') ? trimmed.slice(0, -3).trim() : trimmed;
}

export interface ExtractedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Parse the first TOOL_CALL marker line in the model text.
 *
 * Returns null when there is no marker, the JSON does not parse, the shape
 * is invalid, or the name is not among `allowedNames` (a hallucinated tool
 * must stream back as plain text — never be fabricated into a call).
 *
 * NOTE: text before the marker is discarded by design — a marker anywhere
 * still wins the turn, because opencode re-sends the conversation on the
 * follow-up and nothing before the marker is actionable.
 */
export function extractToolCall(
  text: string,
  allowedNames?: readonly string[],
): ExtractedToolCall | null {
  const allow = allowedNames ? new Set(allowedNames) : null;
  for (const line of text.split('\n')) {
    const remainder = markerRemainder(line);
    if (remainder === null) {
      continue;
    }
    // The first marker line decides the turn: failure here is null, not "keep scanning".
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripTrailingFence(remainder));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record['name'] !== 'string' || record['name'].length === 0) {
      return null;
    }
    if (allow && !allow.has(record['name'])) {
      return null;
    }
    if (record['arguments'] === undefined) {
      return { name: record['name'], arguments: {} };
    }
    const args = record['arguments'];
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return null;
    }
    return { name: record['name'], arguments: args as Record<string, unknown> };
  }
  return null;
}

/**
 * Drop a dangling bare `TOOL_CALL:` trailer (marker prefix with no JSON)
 * from a text answer so marker hygiene never leaks into final content.
 * Lines carrying any other content are left untouched.
 */
export function stripDanglingMarker(text: string): string {
  const lines = text.split('\n');
  const last = lines[lines.length - 1];
  if (last === undefined) {
    return text;
  }
  const remainder = markerRemainder(last);
  if (remainder === null || stripTrailingFence(remainder) !== '') {
    return text;
  }
  lines.pop();
  return lines.join('\n').trimEnd();
}

/**
 * Marker-safe incremental stream buffer for tools mode (T10).
 *
 * The tool-calling relay used to buffer the WHOLE reply in tools mode so a
 * partial marker could never leak as content. That made opencode's TUI show
 * nothing until the turn finished. This buffer streams content as it arrives
 * under the same safety rule as `markerRemainder`:
 * - a COMPLETED line that starts with `TOOL_CALL:` (after leading whitespace)
 *   suppresses itself and everything after it — the marker is relayed as an
 *   OpenAI tool_call from the full text at turn end;
 * - an IN-PROGRESS line is withheld only while it could still become a
 *   marker (it is a strict prefix of `TOOL_CALL:`); the moment it cannot, it
 *   flushes — so normal prose streams per-line, and only ~10 bytes around a
 *   possible marker are ever withheld;
 * - a dangling (incomplete) marker tail at turn end is suppressed, matching
 *   `stripDanglingMarker` hygiene.
 */
export class MarkerSafeStreamBuffer {
  private pending = '';
  private suppressed = false;

  /** Consume one raw delta; returns the marker-safe content to emit now. */
  consume(delta: string): string {
    if (this.suppressed) {
      return '';
    }
    this.pending += delta;
    let out = '';
    let newlineIndex = this.pending.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      if (this.isMarkerLine(line)) {
        this.suppressed = true;
        this.pending = '';
        return out;
      }
      out += `${line}\n`;
      newlineIndex = this.pending.indexOf('\n');
    }
    if (this.couldBecomeMarker(this.pending)) {
      return out;
    }
    out += this.pending;
    this.pending = '';
    return out;
  }

  /**
   * Remainder to emit once the turn text is complete: '' when a marker was
   * seen or the tail is a (dangling) marker fragment; otherwise the tail.
   */
  finalRemainder(): string {
    if (this.suppressed) {
      return '';
    }
    if (this.pending === '') {
      return '';
    }
    if (this.isMarkerLine(this.pending) || this.couldBecomeMarker(this.pending)) {
      return '';
    }
    const tail = this.pending;
    this.pending = '';
    return tail;
  }

  private isMarkerLine(line: string): boolean {
    return line.replace(/^\s+/, '').startsWith(TOOL_CALL_PREFIX);
  }

  private couldBecomeMarker(fragment: string): boolean {
    const stripped = fragment.replace(/^\s+/, '');
    if (stripped.length === 0) {
      return true; // whitespace only: undecided, keep withholding.
    }
    if (stripped.length <= TOOL_CALL_PREFIX.length) {
      return TOOL_CALL_PREFIX.startsWith(stripped);
    }
    // Longer than the prefix: still a candidate while it STARTS with the
    // prefix (a marker line in progress — its JSON may still complete).
    return stripped.startsWith(TOOL_CALL_PREFIX);
  }
}

/** Flatten ONE message to its single prompt line, or null to skip it. */
export function flattenOneMessage(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const role = typeof record['role'] === 'string' ? record['role'] : 'user';
  if (role === 'assistant' && Array.isArray(record['tool_calls'])) {
    const calls = (record['tool_calls'] as unknown[])
      .map(describeAssistantToolCall)
      .filter((entry): entry is string => entry !== null);
    if (calls.length > 0) {
      return `assistant: ${calls.join('; ')}`;
    }
  } else if (role === 'tool') {
    const name =
      (typeof record['name'] === 'string' && record['name']) ||
      (typeof record['tool_call_id'] === 'string' && record['tool_call_id']) ||
      'unknown_tool';
    return `tool ${name}: ${messageContentToString(record['content'])}`;
  } else {
    const content = messageContentToString(record['content']);
    return `${role}: ${content}`;
  }
  // Assistant with an (empty/invalid) tool_calls array falls through to the
  // generic shape, exactly as before.
  const content = messageContentToString(record['content']);
  return `${role}: ${content}`;
}

/** Flattened prompt in parts: preamble + per-message turns + reminder. */
export interface FlattenedParts {
  preamble: string;
  turns: string[];
  reminder: string;
  full: string;
  toolsMode: boolean;
}

/**
 * Build the flattened prompt in parts. `full` is byte-identical to what
 * flattenMessages returns (which delegates here); session mode reuses the
 * parts for chunked bootstrap without changing the legacy shape.
 */
export function flattenParts(messages: unknown, tools?: unknown): FlattenedParts {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpError(400, 'messages must be a non-empty array');
  }
  const toolDefs = parseToolDefinitions(tools);
  const toolsMode = toolDefs.length > 0;
  const turns: string[] = [];
  for (const item of messages) {
    const line = flattenOneMessage(item);
    if (line !== null) {
      turns.push(line);
    }
  }
  const prompt = turns.join('\n').trim();
  if (!prompt) {
    throw new HttpError(400, 'messages must contain at least one non-empty message');
  }
  if (toolsMode) {
    const preamble = buildToolsPreamble(toolDefs);
    return {
      preamble,
      turns,
      reminder: TOOLS_MODE_REMINDER,
      full: `${preamble}\n\n${prompt}\n\n${TOOLS_MODE_REMINDER}`,
      toolsMode,
    };
  }
  return {
    preamble: CHAT_ONLY_PREAMBLE,
    turns,
    reminder: CHAT_ONLY_REMINDER,
    full: `${CHAT_ONLY_PREAMBLE}\n\n${prompt}\n\n${CHAT_ONLY_REMINDER}`,
    toolsMode,
  };
}
/** Describe one assistant tool_calls entry for the flattened prompt. */
function describeAssistantToolCall(call: unknown): string | null {
  if (typeof call !== 'object' || call === null) {
    return null;
  }
  const record = call as Record<string, unknown>;
  const fn = record['function'];
  if (typeof fn !== 'object' || fn === null) {
    return null;
  }
  const fnRecord = fn as Record<string, unknown>;
  if (typeof fnRecord['name'] !== 'string' || fnRecord['name'].length === 0) {
    return null;
  }
  const rawArgs = typeof fnRecord['arguments'] === 'string' ? fnRecord['arguments'] : '{}';
  let args = rawArgs;
  try {
    args = JSON.stringify(JSON.parse(rawArgs));
  } catch {
    // Keep the raw string: still informative for the next turn.
  }
  return `<calls tool ${fnRecord['name']} with arguments ${args}>`;
}

/**
 * Flatten OpenAI messages into the single user turn fed to agy via stdin.
 *
 * When `tools` carries at least one valid function definition the prompt uses
 * the tools-mode manifest instead of the chat-only preamble (the chat-only
 * path is byte-identical to before). Follow-up shapes are flattened too:
 * assistant tool_calls become `<calls tool NAME with arguments ARGS>` and
 * role "tool" messages become `tool NAME: <content>`.
 */
export function flattenMessages(messages: unknown, tools?: unknown): string {
  // Delegates to flattenParts: `full` is the exact legacy shape (byte-identical).
  return flattenParts(messages, tools).full;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, message: string, code = 'invalid_request_error') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/**
 * agy silently truncates large prompts (measured 2026-10-08: sends of
 * 160K/62K tokens came back with 51.8K/40.2K input tokens, tail content
 * permanently lost — the model then answers to nothing visible). There is no
 * public knob to raise the cap, so the bridge enforces a deterministic
 * budget instead of letting agy corrupt conversations invisibly.
 */
export const DEFAULT_MAX_PROMPT_CHARS = 100_000;
export const AGY_MAX_PROMPT_CHARS_ENV = 'AGY_MAX_PROMPT_CHARS';

export function maxPromptCharsFromEnv(): number {
  const raw = process.env[AGY_MAX_PROMPT_CHARS_ENV]?.trim();
  if (!raw) {
    return DEFAULT_MAX_PROMPT_CHARS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_PROMPT_CHARS;
}

/** Pure + exported for tests: deterministic middle-drop to fit the budget. */
export function trimPromptToBudget(prompt: string, maxChars: number): string {
  if (prompt.length <= maxChars) {
    return prompt;
  }
  // Keep the HEAD (system instructions, tool manifest) and the TAIL (the
  // current user request + reminder), drop the middle history with a loud,
  // explicit omission marker — never a silent cut.
  const omitted = prompt.length - maxChars;
  const headShare = Math.floor(maxChars * 0.5);
  const head = prompt.slice(0, headShare);
  const tail = prompt.slice(prompt.length - (maxChars - headShare));
  return `${head}\n[... agy-bridge dropped ${omitted} chars of middle context: prompt budget ${maxChars} chars, sent ${prompt.length}. agy silently truncates oversized prompts, so the bridge trims deterministically and tells you. ...]\n${tail}`;
}

// ---------------------------------------------------------------------------
// Session mode (Phase 1, env flag AGY_SESSION_MODE).
//
// When ON, headered conversational turns (non-ephemeral agents) enter the
// session path: registry load under per-session mutex -> longest-prefix
// ledger diff -> bootstrap full history once, then delta-only turns against
// a resumed agy conversation. Legacy path below is untouched (byte-identical)
// when the flag is off, headers are absent, or the agent is ephemeral.
// Default ON since user acceptance (2026-10-08: delta-only across opencode
// restarts + agy cache continuity + per-turn usage all verified live).
// Explicit opt-out: AGY_SESSION_MODE=0/false/no/off (legacy byte-identical).
// ---------------------------------------------------------------------------

/**
 * Session mode master switch: default ON; explicit opt-out values disable it.
 */
export function sessionModeEnabled(): boolean {
  const raw = process.env.AGY_SESSION_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    return true;
  }
  return !(raw === '0' || raw === 'false' || raw === 'no' || raw === 'off');
}

/** Hidden agents that always stay stateless, never touching branch ledgers. */
export const EPHEMERAL_AGENTS = new Set(['title', 'summary', 'compaction']);

/**
 * Ephemeral agents that may run IN-SESSION as parented side turns (T14
 * Part A): only compaction today — its prompt embeds the full history and
 * benefits from agy's conversation cache. title/summary stay stateless.
 */
export const SIDETURN_AGENTS = new Set(['compaction']);

/** True when this request should enter session mode (else legacy path). */
export function isSessionEligible(sessionId: string, agent: string): boolean {
  if (!sessionModeEnabled()) {
    return false;
  }
  if (!sessionId || sessionId === '-') {
    return false;
  }
  return !EPHEMERAL_AGENTS.has(agent.toLowerCase());
}

/** Split delta messages into TOOL_RESULT lines vs plain `role: content` lines. */
export function renderDeltaMessages(delta: unknown[]): {
  toolResults: string[];
  newMessages: string[];
} {
  const toolResults: string[] = [];
  const newMessages: string[] = [];
  for (const item of delta) {
    if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      if (record['role'] === 'tool') {
        const name =
          (typeof record['name'] === 'string' && record['name']) || 'unknown_tool';
        const callId =
          (typeof record['tool_call_id'] === 'string' && record['tool_call_id']) || name;
        toolResults.push(
          `TOOL_RESULT for call ${callId} (tool ${name}): ${messageContentToString(record['content'])}`,
        );
        continue;
      }
    }
    const line = flattenOneMessage(item);
    if (line !== null) {
      newMessages.push(line);
    }
  }
  return { toolResults, newMessages };
}

function errorBody(message: string, code: string, type = 'server_error'): unknown {
  return { error: { message, code, type } };
}

function mapTurnError(err: unknown): { status: number; body: unknown } {
  if (err instanceof HttpError) {
    return { status: err.status, body: errorBody(err.message, err.code, 'invalid_request_error') };
  }
  if (err instanceof AgyBinaryMissingError) {
    return { status: 503, body: errorBody(err.message, 'agy_binary_missing') };
  }
  if (err instanceof AgyTimeoutError) {
    return { status: 504, body: errorBody(err.message, 'agy_timeout') };
  }
  if (err instanceof AgyExitError) {
    // Surface the agy failure verbatim so callers can see the real cause.
    return { status: 502, body: errorBody(err.message, 'agy_failed') };
  }
  if (err instanceof AgyToolDeniedError) {
    // 400 on purpose: the AI SDK (maxRetries default 2) retries 5xx, and every
    // retry would spawn a REAL agy turn against the user's plan quota. A
    // denial is deterministic, so make it non-retryable for the client.
    return { status: 400, body: errorBody(err.message, 'agy_tool_denied', 'invalid_request_error') };
  }
  if (err instanceof AgyConversationMismatchError) {
    // Resume raced a deleted/unknown conversation (E8). Session mode already
    // retried with a fresh bootstrap once; surfacing verbatim if it recurs.
    return { status: 502, body: errorBody(err.message, 'agy_conversation_mismatch') };
  }
  if (err instanceof AgyAbortedError) {
    // Client closed the socket / pressed Esc; nothing to answer anymore.
    return { status: 499, body: errorBody(err.message, 'client_closed_request') };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: errorBody(message || 'internal bridge error', 'internal_error') };
}

/** One SSE frame. Exported for tests. */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function newCompletionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

export interface BridgeOptions {
  adapter?: TurnAdapter;
  maxConcurrentTurns?: number;
  /** T16 version-gate override for tests; defaults to getAgyStatus().version. */
  agyVersion?: string | null;
  /** T18 test hook: warm-lane bounds + manager instance injection. */
  warmLaneManager?: WarmLaneManager;
}

/**
 * Build identity for the stale-daemon handshake (T12, case #38): sha1 over
 * the sorted dist/*.js contents backing this server. Computed lazily and
 * cached — dist files do not change while the process runs. Runs compiled
 * (node dist/index.js) from its own directory; from src (tests) falls back
 * to ../dist when present; 'dev' when no dist is found.
 */
let buildIdCache: string | null = null;
export function computeBuildId(): string {
  if (buildIdCache !== null) {
    return buildIdCache;
  }
  const candidates = [__dirname, path.resolve(__dirname, '..', 'dist')];
  for (const dir of candidates) {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.js'))
        .sort();
      if (files.length === 0) {
        continue;
      }
      const hash = files
        .map((f) => `${f}\0${fs.readFileSync(path.join(dir, f), 'utf8')}`)
        .join('\0');
      buildIdCache = sha1Hex(hash);
      return buildIdCache;
    } catch {
      // Try the next candidate.
    }
  }
  buildIdCache = 'dev';
  return buildIdCache;
}

export function buildApp(options: BridgeOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  let adapter = options.adapter ?? defaultAdapter;

  // T18 warm lane: when AGY_WARM_LANE=1, wrap the adapter — session-keyed
  // persistent processes first, transparent Option A fallback on any
  // anomaly (null return or thrown error). Legacy/ephemeral turns (no
  // sessionID) always go to the base adapter.
  if (warmLaneEnabled()) {
    const manager =
      options.warmLaneManager ??
      new WarmLaneManager((sessionID) => {
        const row = sessionModelOptions.get(sessionID);
        if (!row) {
          return null;
        }
        return {
          model: row.model,
          effort: row.effort ?? null,
          ...(row.workspaceDir ? { workspaceDir: row.workspaceDir } : {}),
        };
      });
    warmLaneManagerRef = manager;
    const baseAdapter = adapter;
    adapter = {
      runTurn: async (request, onDelta) => {
        if (request.signal?.aborted) {
          throw new AgyAbortedError();
        }
        if (!request.sessionID) {
          return baseAdapter.runTurn(request, onDelta);
        }
        try {
          const result = await manager.runTurn(request.sessionID, {
            prompt: request.prompt,
            model: request.model,
            effort: request.effort ?? null,
            signal: request.signal ?? new AbortController().signal,
            ...(request.conversationId ? { conversationId: request.conversationId } : {}),
            ...(request.workspaceDir ? { workspaceDir: request.workspaceDir } : {}),
            ...(request.onInit ? { onInit: request.onInit } : {}),
            ...(onDelta ? { onDelta } : {}),
          });
          if (result) {
            return {
              text: result.text,
              usage: result.usage,
              ...(result.conversationId ? { conversationId: result.conversationId } : {}),
            };
          }
          return baseAdapter.runTurn(request, onDelta);
        } catch (err) {
          // Anomaly: destroy happened inside the manager; fall back ONCE.
          if (err instanceof AgyAbortedError) {
            throw err; // aborts never fall back.
          }
          try {
            return await baseAdapter.runTurn(request, onDelta);
          } catch (fallbackErr) {
            throw fallbackErr;
          }
        }
      },
    };
  }
  const maxConcurrent = options.maxConcurrentTurns ?? MAX_CONCURRENT_TURNS;

  // T17 telemetry: per-app counters (fresh app = fresh counters, so tests
  // stay deterministic). Exposed via GET /v1/__debug/stats.
  const telemetry = {
    startedAt: new Date().toISOString(),
    turns: 0,
    byPath: {} as Record<string, number>,
    cacheHits: 0,
    deniedRetries: 0,
    deniedFatal: 0,
    timeouts: 0,
    aborts: 0,
    errors: 0,
  };
  const countPath = (label: string): void => {
    telemetry.turns += 1;
    telemetry.byPath[label] = (telemetry.byPath[label] ?? 0) + 1;
  };

  // Simple semaphore: at most N agy spawns run at once; the rest queue FIFO.
  let active = 0;
  const waiters: Array<() => void> = [];
  async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }
    active += 1;
    try {
      return await work();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  }

  // Stale-daemon handshake fields (T12): buildId lets the plugin detect a
  // daemon serving OLD code after an upgrade (healthz 200 alone hides it);
  // pid lets the plugin kill exactly that process on mismatch; inflight
  // gates the restart so in-flight turns of other opencode instances are
  // never killed (defer to the next watchdog tick).
  app.get('/healthz', () => ({
    status: 'ok',
    agy: getAgyStatus(),
    buildId: computeBuildId(),
    pid: process.pid,
    inflight: active,
  }));

  app.get('/v1/models', () => toOpenAIModelList());

  // Experiment E1 probe: echo the received headers back. Localhost-only
  // server, zero agy cost.
  app.get('/v1/__debug/echo', async (request) => ({ headers: request.headers ?? {} }));

  // T15: the plugin forwards opencode's session.deleted; the record becomes
  // tombstoneed (GC-eligible after grace) but stays on disk — the ledger
  // authority revives it on the next matching request. agy's own store is
  // NEVER touched.
  app.post('/v1/__session/tombstone', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : '';
    if (!sessionId || sessionId === '-') {
      return reply.code(400).send(errorBody('sessionId is required', 'invalid_request'));
    }
    const record = loadSessionRecord(sessionId);
    if (record.branches.length === 0 && record.inflightMarkers.length === 0) {
      // Never bridged: nothing to tombstone.
      return reply.code(200).send({ status: 'noop' });
    }
    record.tombstonedAt = new Date().toISOString();
    saveSessionRecord(record);
    logBridgeLine('POST', '/v1/__session/tombstone', 200, sessionId, '-', '-', 'tombstoned');
    return reply.code(200).send({ status: 'tombstoned' });
  });

  // T17 telemetry (Phase 2 optional item): per-app turn counters + registry
  // overview. Localhost-only, zero agy cost.
  app.get('/v1/__debug/stats', async () => {
    let sessions = 0;
    let tombstonedSessions = 0;
    let branches = 0;
    let tombstonedBranches = 0;
    let inflightMarkers = 0;
    try {
      for (const file of fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json'))) {
        sessions += 1;
        try {
          const record = loadSessionRecord(path.basename(file, '.json'));
          if (record.tombstonedAt) {
            tombstonedSessions += 1;
          }
          branches += record.branches.length;
          tombstonedBranches += record.branches.filter((b) => b.tombstoned).length;
          inflightMarkers += record.inflightMarkers.length;
        } catch {
          // Corrupt: storage guard owns it; count the file only.
        }
      }
    } catch {
      // No sessions dir yet.
    }
    return {
      status: 'ok',
      startedAt: telemetry.startedAt,
      uptimeSec: Math.floor((Date.now() - Date.parse(telemetry.startedAt)) / 1000),
      turns: telemetry.turns,
      byPath: { ...telemetry.byPath },
      cacheHits: telemetry.cacheHits,
      deniedRetries: telemetry.deniedRetries,
      deniedFatal: telemetry.deniedFatal,
      timeouts: telemetry.timeouts,
      aborts: telemetry.aborts,
      errors: telemetry.errors,
      registry: { sessions, tombstonedSessions, branches, tombstonedBranches, inflightMarkers },
      warmLanes: warmLaneManagerRef?.describe() ?? { lanes: 0, keys: [] },
      warmLanesEnabled: warmLaneEnabled(),
    };
  });

  // Single-line logger for every non-chat request. Chat completions are
  // covered by their own BEFORE/AFTER lines below.
  app.addHook('onResponse', async (request, reply) => {
    try {
      const urlPath = request.url;
      if (request.method === 'POST' && urlPath.startsWith('/v1/chat/completions')) {
        return;
      }
      const identity = identityFromHeaders(
        (request.headers ?? {}) as Record<string, unknown>,
      );
      const status = reply.statusCode;
      const extra = status >= 400 ? `err=status-${status}` : undefined;
      logBridgeLine(
        request.method,
        urlPath,
        status,
        identity.sessionId,
        identity.agent,
        identity.msgId,
        extra,
      );
    } catch {
      // Never break a request from the logger.
    }
  });

  app.post('/v1/chat/completions', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const chatIdentity = identityFromHeaders(
      (request.headers ?? {}) as Record<string, unknown>,
    );
    const chatPath = '/v1/chat/completions';
    const requestedModel = typeof body['model'] === 'string' ? body['model'] : '';
    if (!requestedModel) {
      logBridgeLine(
        'POST',
        chatPath,
        400,
        chatIdentity.sessionId,
        chatIdentity.agent,
        chatIdentity.msgId,
        'err=model_not_found',
      );
      return reply
        .code(400)
        .send(errorBody('model is required', 'model_not_found', 'invalid_request_error'));
    }
    const catalogEntry = findModel(requestedModel);
    if (!catalogEntry) {
      logBridgeLine(
        'POST',
        chatPath,
        404,
        chatIdentity.sessionId,
        chatIdentity.agent,
        chatIdentity.msgId,
        'err=model_not_found',
      );
      return reply.code(404).send(
        errorBody(
          `Model '${requestedModel}' is not served by this bridge.`,
          'model_not_found',
          'invalid_request_error',
        ),
      );
    }
    const { baseModel, effort } = parseEffort(requestedModel);

    const toolDefs = parseToolDefinitions(body['tools']);
    const toolsMode = toolDefs.length > 0;
    const toolNames = toolDefs.map((def) => def.name);
    // Observability (T-subagent gap): which tools the client ACTUALLY sent
    // for this request, so "no dispatcher" claims can be verified against
    // the request payload instead of guessed.
    const tagTargets = ['task', 'bash', 'edit', 'write', 'read', 'glob'];
    const presentTargets = tagTargets.filter((t) => toolNames.includes(t));
    const toolNamesTag = `tools=${toolNames.length}[${toolNames.slice(0, 12).join(',')}] present=${presentTargets.join('|')}`;

    let prompt: string;
    try {
      prompt = flattenMessages(body['messages'], body['tools']);
    } catch (err) {
      const mapped = mapTurnError(err);
      logBridgeLine(
        'POST',
        chatPath,
        mapped.status,
        chatIdentity.sessionId,
        chatIdentity.agent,
        chatIdentity.msgId,
        `err=${errorCodeFromBody(mapped.body)}`,
      );
      return reply.code(mapped.status).send(mapped.body);
    }
    // Deterministic prompt budget (agy silently truncates oversized input):
    // keep head (instructions/manifest) and tail (current request), loud
    // omission marker for the middle. Safety net; session mode will replace
    // most of the pressure.
    prompt = trimPromptToBudget(prompt, maxPromptCharsFromEnv());
    // Session-mode decision (flag + headers + non-ephemeral agent). The
    // legacy prompt above is still computed first so flag-off behavior and
    // validation errors stay byte-identical.
    const sessionActive = isSessionEligible(chatIdentity.sessionId, chatIdentity.agent);
    // Appended to AFTER lines only; empty in legacy mode (byte-identical).
    let sessionLogSuffix = '';
    if (!sessionActive) {
      // BEFORE line: request received with the byte size actually sent to agy.
      logBridgeLine(
        'POST',
        chatPath,
        'received',
        chatIdentity.sessionId,
        chatIdentity.agent,
        chatIdentity.msgId,
        `bytes=${Buffer.byteLength(prompt, 'utf8')} model=${requestedModel} ${toolNamesTag}`,
      );
    }

    const stream = body['stream'] === true;
    const created = Math.floor(Date.now() / 1000);
    const completionId = newCompletionId();

    // Client-disconnect contract (interrupt / network drop / closed tab): as
    // soon as the SOCKET closes, abort the in-flight (or queued) agy turn so
    // the process tree is killed, plan quota stops burning and the
    // concurrency slot is released. NOTE: listen on the underlying socket,
    // NOT on request.raw — an IncomingMessage fires 'close' when its body has
    // merely been consumed (kept-alive connection!), which would abort every
    // turn just as the client finished sending it. After normal completion
    // the close event may fire once more; aborting a settled turn is a no-op.
    const abortController = new AbortController();
    const signal = abortController.signal;
    let clientGone = false;
    const onSocketClose = (): void => {
      clientGone = true;
      abortController.abort();
    };
    request.raw.socket.on('close', onSocketClose);

    /**
     * Execute one logical turn. Legacy mode: single adapter call with the
     * precomputed prompt. Session mode: plan + spawn(s) under ONE per-session
     * lock (E1 decision logging included); replay short-circuits with NO
     * adapter call (idempotent retry).
     */
    const executeTurn = async (
      onDelta?: (chunk: string) => void,
    ): Promise<{ text: string; usage: AgyUsage | null }> => {
      if (!sessionActive) {
        // T14 Part A — parented side turn: a compaction agent turn parented
        // to a live session branch runs IN-SESSION (resume the parent
        // branch's agy conversation) instead of stateless. agy's cache
        // already holds the whole conversation, so the (huge) compaction
        // request re-encodes mostly from cache. The parent branch LEDGER is
        // untouched: the compaction Q&A is opencode machinery, not
        // conversation content — the turn only travels through agy.
        if (SIDETURN_AGENTS.has(chatIdentity.agent) && chatIdentity.parentSessionId !== '-') {
          const parentRecord = loadSessionRecord(chatIdentity.parentSessionId);
          const donor = [...liveBranches(parentRecord)]
            .reverse()
            .find((b) => b.agyConversationID);
          if (donor) {
            try {
              const result = await withSlot(() =>
                adapter.runTurn(
                  {
                    model: baseModel,
                    effort,
                    prompt,
                    signal,
                    conversationId: donor.agyConversationID,
                    ...(donor.workspaceDir ? { workspaceDir: donor.workspaceDir } : {}),
                    onInit: (actualId: string) =>
                      actualId !== donor.agyConversationID ? 'kill' : 'continue',
                  },
                  onDelta,
                ),
              );
              logBridgeLine(
                'POST',
                chatPath,
                'received',
                chatIdentity.sessionId,
                chatIdentity.agent,
                chatIdentity.msgId,
                `session path=side-turn parent=${chatIdentity.parentSessionId} branch=${donor.branchID}`,
              );
              return result;
            } catch (err) {
              // A failed side turn leaves noise in the conversation: dirty
              // the parent branch so the next build turn repairs it.
              markBranchDirty(donor);
              saveSessionRecord(parentRecord);
              throw err;
            }
          }
        }
        // Legacy path: stateless, so the corrective turn re-sends the full
        // original prompt with the correction appended (agy cannot "remember"
        // the denied attempt — each turn is independent).
        try {
          return await withSlot(() =>
            adapter.runTurn({ model: baseModel, effort, prompt, signal }, onDelta),
          );
        } catch (err) {
          if (err instanceof AgyToolDeniedError) {
            const correction = `${prompt}\n\n${buildDeniedCorrectionPrompt({
              deniedActions: err.deniedActions,
              toolsMode,
            })}`;
            logBridgeLine(
              'POST',
              chatPath,
              'received',
              chatIdentity.sessionId,
              chatIdentity.agent,
              chatIdentity.msgId,
              `session path=denied-retry denied=${err.deniedActions.join(', ')} toolsMode=${toolsMode}`,
            );
            return withSlot(() =>
              adapter.runTurn({ model: baseModel, effort, prompt: correction, signal }, onDelta),
            );
          }
          throw err;
        }
      }
      return withSessionLock(chatIdentity.sessionId, async () => {
        const sessionID = chatIdentity.sessionId;
        const record: SessionRecord = loadSessionRecord(sessionID);
        // T15 revival: the ledger authority is the request itself — a
        // tombstoned record receiving a matching request revives.
        if (record.tombstonedAt) {
          console.error(`agy-bridge session: ${sessionID} revived from tombstone`);
          delete record.tombstonedAt;
          saveSessionRecord(record);
        }
        const parentHeader = headerText(
          (request.headers ?? {}) as Record<string, unknown>,
          'x-agy-parent-session-id',
        );
        if (record.branches.length === 0 && parentHeader !== '-') {
          record.parentSessionID = parentHeader;
        }
        // T16 version gate: branches born under a DIFFERENT agy version than
        // the current binary are tombstoned (their conversations may not
        // resume across an auto-upgrade — case #34). Selection then falls
        // through to a fresh bootstrap. Loud, once per detected mismatch.
        const currentAgyVersion = options.agyVersion !== undefined ? options.agyVersion : getAgyStatus().version;
        if (currentAgyVersion) {
          for (const branch of record.branches) {
            if (!branch.tombstoned && branch.agyVersion && branch.agyVersion !== currentAgyVersion) {
              console.error(
                `agy-bridge session: agy version changed for ${sessionID} ` +
                  `(branch ${branch.branchID}: ${branch.agyVersion} -> ${currentAgyVersion}); ` +
                  'tombstoning branch — next turn bootstraps fresh',
              );
              branch.tombstoned = true;
            }
          }
        }
        const incoming: unknown[] = Array.isArray(body['messages'])
          ? (body['messages'] as unknown[])
          : [];
        // Ledger view excludes system messages (date rollovers / AGENTS.md
        // edits / agent switches must refresh, never rebootstrap). All
        // ledger indices below align with ledgerView, not with incoming.
        const ledgerView = ledgerMessages(incoming);
        const digests = ledgerDigests(incoming);
        const sysD = systemDigest(incoming);
        const selection = selectBranch(record, digests);

        if (selection.kind === 'replay' && selection.branch) {
          // Exact-equal history + stored response: idempotent retry, NO spawn.
          saveSessionRecord(record);
          const branch = selection.branch;
          const text = branch.lastResponse ?? '';
          logBridgeLine(
            'POST',
            chatPath,
            'received',
            sessionID,
            chatIdentity.agent,
            chatIdentity.msgId,
            `bytes=0 model=${requestedModel} session path=replay branch=${branch.branchID} epoch=${branch.epoch}`,
          );
          sessionLogSuffix = ` session path=replay branch=${branch.branchID}`;
          return { text, usage: null };
        }

        const budget = maxPromptCharsFromEnv();
        let branch: BranchRecord;
        let prompts: string[];
        let pathLabel: string;
        if (selection.kind === 'bootstrap') {
          branch = createBranch(record, selection.origin ?? 'initial', {
            modelFamily: catalogEntry.family,
            effort,
            systemDigest: sysD,
          });
          // T16: record the agy version this branch was born under (case #34
          // gate on later resumes). Null during the startup probe window is
          // fine: the gate only fires when BOTH versions are known.
          branch.agyVersion =
            options.agyVersion !== undefined ? options.agyVersion : getAgyStatus().version;
          // T14 Part B — epoch bootstrap: a divergence bootstrap (no prefix
          // match: compaction, revert, hard divergence) RESUMES the newest
          // existing agy conversation instead of cold-starting a new one.
          // The compacted/restated history re-encodes mostly from agy's
          // conversation cache; a divergence note tells agy the parts below
          // are the authoritative state. First bootstrap (no donor) is
          // byte-identical to before.
          let divergenceNote: string | undefined;
          if (selection.origin === 'divergence') {
            const donor = [...record.branches]
              .reverse()
              .find(
                (b) =>
                  b.branchID !== branch.branchID &&
                  !!b.agyConversationID &&
                  !b.tombstoned,
              );
            if (donor) {
              // convId is adopted later from branch.agyConversationID.
              branch.agyConversationID = donor.agyConversationID;
              // The conversation was BORN in the donor's version: inherit.
              branch.agyVersion = donor.agyVersion;
              if (donor.workspaceDir) {
                branch.workspaceDir = donor.workspaceDir;
              }
              branch.epoch = donor.epoch + 1;
              divergenceNote = DIVERGENCE_NOTE;
              console.error(
                `agy-bridge session: divergence bootstrap resumes donor conversation ${donor.agyConversationID} (epoch ${branch.epoch})`,
              );
            }
          }
          const parts = flattenParts(body['messages'], body['tools']);
          if (chunkBootstrapEnabled()) {
            const chunks = chunkBootstrapPrompts(
              {
                preamble: parts.preamble,
                turns: parts.turns,
                reminder: parts.reminder,
                full: parts.full,
              },
              budget,
            );
            prompts = chunks.map((chunk) =>
              chunk.length > budget ? trimPromptToBudget(chunk, budget) : chunk,
            );
          } else {
            prompts = [trimPromptToBudget(parts.full, budget)];
          }
          if (divergenceNote && prompts.length > 0) {
            // The note rides on the FIRST prompt only; ACK chunks carry it
            // as leading context for agy (it stays in the conversation).
            prompts[0] = `${divergenceNote}\n\n${prompts[0]}`;
          }
          pathLabel = prompts.length > 1 ? 'bootstrap-chunked' : 'bootstrap';
          if (divergenceNote) {
            pathLabel = prompts.length > 1 ? 'bootstrap-chunked-epoch' : 'bootstrap-epoch';
          }
        } else {
          branch = selection.branch as BranchRecord;
          const deltaMsgs = ledgerView.slice(selection.deltaStart);
          const { toolResults, newMessages } = renderDeltaMessages(deltaMsgs);
          let refresh: string | undefined;
          if (branch.systemDigest && branch.systemDigest !== sysD) {
            refresh =
              `system instructions changed since this branch started ` +
              `(digest ${branch.systemDigest.slice(0, 12)} -> ${sysD.slice(0, 12)}); ` +
              `treat the following as authoritative updates.`;
          }
          const deltaPrompt = buildDeltaPrompt({
            sessionID,
            branchID: branch.branchID,
            epoch: branch.epoch,
            ...(refresh ? { systemRefresh: refresh } : {}),
            repair: selection.needsRepair || branch.dirty === true,
            toolResults,
            newMessages,
            toolsMode,
          });
          // T-task gap: fresh protocol reminder on every delta turn — the
          // manifest only rides the bootstrap, and stale in-conversation
          // memory let the model claim/hallucinate tool activity without
          // emitting TOOL_CALL markers.
          const reminder = toolsMode ? deltaProtocolReminder() : '';
          prompts = [
            trimPromptToBudget(
              reminder ? `${reminder}\n\n${deltaPrompt}` : deltaPrompt,
              budget,
            ),
          ];
          pathLabel = selection.needsRepair || branch.dirty === true ? 'repair' : 'delta';
        }

        // Workspace pin: reuse the branch dir, else mint + persist it.
        let workspaceDir: string | undefined;
        try {
          if (branch.workspaceDir) {
            fs.mkdirSync(branch.workspaceDir, { recursive: true });
            workspaceDir = branch.workspaceDir;
          } else {
            const created = ensureWorkspaceDir(branch.branchID);
            if (created) {
              branch.workspaceDir = created;
              workspaceDir = created;
            }
          }
        } catch (err) {
          console.error(
            `agy-bridge session: cannot ensure workspace for branch ${branch.branchID}: ` +
              `${(err as Error).message}; spawning without pinned cwd`,
          );
          workspaceDir = undefined;
        }

        // Store-first: inflight marker on disk BEFORE any spawn.
        const turnDigest = sha1Hex(digests.join('|'));
        let deniedRetryUsed = false;
        // T18: refresh the warm-lane spawn info for this session (model,
        // effort, workspace pin) BEFORE any adapter call.
        sessionModelOptions.set(sessionID, {
          model: baseModel,
          effort: effort ?? null,
          ...(workspaceDir ? { workspaceDir } : {}),
        });
        record.inflightMarkers.push({
          bootId: getBootId(),
          branchID: branch.branchID,
          deltaDigest: turnDigest,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        });
        if (record.inflightMarkers.length > 50) {
          record.inflightMarkers.splice(0, record.inflightMarkers.length - 50);
        }
        saveSessionRecord(record);

        let convId: string | undefined = branch.agyConversationID || undefined;
        const onInit = (actualId: string): 'continue' | 'kill' => {
          if (convId && actualId !== convId) {
            return 'kill';
          }
          if (!convId && actualId) {
            // Store-first: persist the fresh conversation id BEFORE the
            // turn completes (crash mid-bootstrap must not orphan it).
            convId = actualId;
            branch.agyConversationID = actualId;
            saveSessionRecord(record);
          }
          return 'continue';
        };

        const runPrompts = async (
          usePrompts: string[],
        ): Promise<{ text: string; usage: AgyUsage | null }> => {
          let text = '';
          let usage: AgyUsage | null = null;
          for (let index = 0; index < usePrompts.length; index += 1) {
            const isLast = index === usePrompts.length - 1;
            let result;
            try {
              result = await withSlot(() =>
                adapter.runTurn(
                  {
                    model: baseModel,
                    effort,
                    prompt: usePrompts[index] as string,
                    signal,
                    sessionID,
                    ...(convId ? { conversationId: convId } : {}),
                    ...(workspaceDir ? { workspaceDir } : {}),
                    onInit,
                  },
                  isLast ? onDelta : undefined,
                ),
              );
            } catch (err) {
              // Denied self-runtime-tool attempt: ONE self-healing corrective
              // turn instead of a hard failure. The agy conversation already
              // holds the whole context, so only the correction travels; the
              // redirect sends the model to the TOOL_CALL: relay (client
              // executes AGENT tools) or to plain text when no client tools
              // exist. Retry budget: exactly 1, and only for the terminal
              // prompt — mid-chain ACK failures are protocol failures.
              if (
                err instanceof AgyToolDeniedError &&
                isLast &&
                !deniedRetryUsed
              ) {
                deniedRetryUsed = true;
                telemetry.deniedRetries += 1;
                const correction = buildDeniedCorrectionPrompt({
                  deniedActions: err.deniedActions,
                  toolsMode,
                  ...(convId ? { sessionHeader: `[agy-bridge session: ${sessionID} branch: ${branch.branchID} epoch: ${branch.epoch}]` } : {}),
                });
                logBridgeLine(
                  'POST',
                  chatPath,
                  'received',
                  sessionID,
                  chatIdentity.agent,
                  chatIdentity.msgId,
                  `session path=denied-retry branch=${branch.branchID} denied=${err.deniedActions.join(', ')} toolsMode=${toolsMode}`,
                );
                sessionLogSuffix =
                  ` session path=denied-retry branch=${branch.branchID}`;
                result = await withSlot(() =>
                  adapter.runTurn(
                    {
                      model: baseModel,
                      effort,
                      prompt: correction,
                      signal,
                      sessionID,
                      ...(convId ? { conversationId: convId } : {}),
                      ...(workspaceDir ? { workspaceDir } : {}),
                      onInit,
                    },
                    onDelta,
                  ),
                );
                if (!convId && result.conversationId) {
                  convId = result.conversationId;
                  branch.agyConversationID = result.conversationId;
                }
              } else {
                throw err;
              }
            }
            if (!convId && result.conversationId) {
              // Fake/test adapters never fire onInit: adopt the id post-turn.
              convId = result.conversationId;
              branch.agyConversationID = result.conversationId;
            }
            if (isLast) {
              text = result.text;
              usage = result.usage;
            }
          }
          return { text, usage };
        };

        const totalBytes = prompts.reduce(
          (sum, item) => sum + Buffer.byteLength(item, 'utf8'),
          0,
        );
        logBridgeLine(
          'POST',
          chatPath,
          'received',
          sessionID,
          chatIdentity.agent,
          chatIdentity.msgId,
          `bytes=${totalBytes} model=${requestedModel} ${toolNamesTag} session path=${pathLabel} branch=${branch.branchID} epoch=${branch.epoch} turns=${prompts.length}`,
        );
        sessionLogSuffix = ` session path=${pathLabel} branch=${branch.branchID} turns=${prompts.length}`;

        let outcome: { text: string; usage: AgyUsage | null };
        try {
          outcome = await runPrompts(prompts);
        } catch (err) {
          if (err instanceof AgyConversationMismatchError) {
            // E8: agy silently started a fresh conversation for an unknown
            // id. Loud fallback: dirty the orphaned branch, bootstrap fresh,
            // retry once.
            console.error(
              `agy-bridge session: ${err.message} bootstrapping a fresh branch instead`,
            );
            markBranchDirty(branch);
            saveSessionRecord(record);
            const fresh = createBranch(record, 'divergence', {
              modelFamily: catalogEntry.family,
              effort,
              systemDigest: sysD,
            });
            branch = fresh;
            convId = undefined;
            const parts = flattenParts(body['messages'], body['tools']);
            const retryPrompts = chunkBootstrapEnabled()
              ? chunkBootstrapPrompts(
                  {
                    preamble: parts.preamble,
                    turns: parts.turns,
                    reminder: parts.reminder,
                    full: parts.full,
                  },
                  budget,
                )
              : [trimPromptToBudget(parts.full, budget)];
            logBridgeLine(
              'POST',
              chatPath,
              'received',
              sessionID,
              chatIdentity.agent,
              chatIdentity.msgId,
              `bytes=${retryPrompts.join('').length} model=${requestedModel} session path=bootstrap-mismatch-retry branch=${branch.branchID} epoch=${branch.epoch} turns=${retryPrompts.length}`,
            );
            sessionLogSuffix =
              ` session path=bootstrap-mismatch-retry branch=${branch.branchID} turns=${retryPrompts.length}`;
            try {
              outcome = await runPrompts(retryPrompts);
            } catch (retryErr) {
              markBranchDirty(branch);
              saveSessionRecord(record);
              throw retryErr;
            }
          } else {
            markBranchDirty(branch);
            saveSessionRecord(record);
            throw err;
          }
        }

        // Success: ledger advances to the full incoming history; the assistant
        // response becomes the provisional tail the next echo confirms.
        confirmTurn(branch, digests, outcome.text, provisionalDigestForResponse(outcome.text));
        branch.systemDigest = sysD;
        record.inflightMarkers = record.inflightMarkers.filter(
          (marker) => marker.branchID !== branch.branchID || marker.deltaDigest !== turnDigest,
        );
        saveSessionRecord(record);
        return outcome;
      });
    };

    /**
     * Shape a validated marker match as OpenAI tool_calls. `forStream`
     * selects the chunk form (with index) vs the message form.
     */
    const toToolCallPayload = (call: ExtractedToolCall, forStream: boolean) => ({
      ...(forStream ? { index: 0 } : {}),
      id: `call_${Math.floor(Math.random() * 0xffffffffffff).toString(36)}`,
      type: 'function' as const,
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {}),
      },
    });

    if (!stream) {
      try {
        const result = await executeTurn();
        const openAIUsage = toOpenAIUsage(result.usage);
        // T17 telemetry: count the turn (session path label when present).
        countPath(sessionLogSuffix.match(/path=([a-z-]+)/)?.[1] ?? 'legacy');
        if ((openAIUsage.cached_tokens ?? 0) > 0) {
          telemetry.cacheHits += 1;
        }
        const summary =
          `prompt=${openAIUsage.prompt_tokens} ` +
          `completion=${openAIUsage.completion_tokens} ` +
          `total=${openAIUsage.total_tokens} cached=${openAIUsage.cached_tokens ?? 0}` +
          sessionLogSuffix;
        if (toolsMode) {
          const call = extractToolCall(result.text, toolNames);
          if (call) {
            logBridgeLine(
              'POST',
              chatPath,
              200,
              chatIdentity.sessionId,
              chatIdentity.agent,
              chatIdentity.msgId,
              summary,
            );
            return reply.send({
              id: completionId,
              object: 'chat.completion',
              created,
              model: requestedModel,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [toToolCallPayload(call, false)],
                  },
                  finish_reason: 'tool_calls' as const,
                },
              ],
              usage: openAIUsage,
            });
          }
          logBridgeLine(
            'POST',
            chatPath,
            200,
            chatIdentity.sessionId,
            chatIdentity.agent,
            chatIdentity.msgId,
            summary,
          );
          return reply.send({
            id: completionId,
            object: 'chat.completion',
            created,
            model: requestedModel,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: stripDanglingMarker(result.text) },
                finish_reason: 'stop' as const,
              },
            ],
            usage: openAIUsage,
          });
        }
        logBridgeLine(
          'POST',
          chatPath,
          200,
          chatIdentity.sessionId,
          chatIdentity.agent,
          chatIdentity.msgId,
          summary,
        );
        return reply.send({
          id: completionId,
          object: 'chat.completion',
          created,
          model: requestedModel,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: result.text },
              finish_reason: 'stop' as const,
            },
          ],
          usage: openAIUsage,
        });
      } catch (err) {
        const mapped = mapTurnError(err);
        // T17 telemetry: failures by class.
        telemetry.errors += 1;
        if (err instanceof AgyTimeoutError) {
          telemetry.timeouts += 1;
        }
        if (err instanceof AgyToolDeniedError) {
          telemetry.deniedFatal += 1;
        }
        logBridgeLine(
          'POST',
          chatPath,
          mapped.status,
          chatIdentity.sessionId,
          chatIdentity.agent,
          chatIdentity.msgId,
          `err=${errorCodeFromBody(mapped.body)}`,
        );
        return reply.code(mapped.status).send(mapped.body);
      }
    }

    // Streaming: hijack the reply and write SSE frames incrementally as agy
    // deltas arrive, so clients see tokens as they are produced.
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const sendChunk = (delta: Record<string, unknown>, finishReason: string | null): void => {
      if (clientGone || raw.writableEnded || raw.destroyed) {
        return;
      }
      raw.write(
        sseData({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }),
      );
    };
    sendChunk({ role: 'assistant' }, null);
    // T10 streamed tools mode: BOTH modes stream now. Chat-only keeps raw
    // deltas exactly as before. Tools mode routes deltas through the
    // marker-safe buffer so content streams per line while a TOOL_CALL:
    // marker can never leak as content — at turn end the full text still
    // decides between a tool_calls chunk and the final content remainder.
    const streamBuffer = toolsMode ? new MarkerSafeStreamBuffer() : null;
    const onTurnDelta = toolsMode
      ? (delta: string) => {
          const safe = streamBuffer?.consume(delta) ?? '';
          if (safe) {
            sendChunk({ content: safe }, null);
          }
        }
      : (delta: string) => sendChunk({ content: delta }, null);
    try {
      const result = await executeTurn(onTurnDelta);
      if (clientGone) {
        // Client is gone; the agy turn was aborted. Do not write.
        telemetry.aborts += 1;
        logBridgeLine(
          'POST',
          chatPath,
          'aborted',
          chatIdentity.sessionId,
          chatIdentity.agent,
          chatIdentity.msgId,
          'err=client-gone',
        );
        return undefined;
      }
      // T17 telemetry: count the streamed turn.
      countPath(sessionLogSuffix.match(/path=([a-z-]+)/)?.[1] ?? 'legacy');
      if ((toOpenAIUsage(result.usage).cached_tokens ?? 0) > 0) {
        telemetry.cacheHits += 1;
      }
      logBridgeLine(
        'POST',
        chatPath,
        200,
        chatIdentity.sessionId,
        chatIdentity.agent,
        chatIdentity.msgId,
        `${usageSummary(result.usage)}${sessionLogSuffix}`,
      );
      if (toolsMode) {
        const call = extractToolCall(result.text, toolNames);
        if (call) {
          sendChunk({ tool_calls: [toToolCallPayload(call, true)] }, null);
          const toolFinalChunk: Record<string, unknown> = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: toOpenAIUsage(result.usage),
          };
          raw.write(sseData(toolFinalChunk));
        } else {
          // Text case: content already streamed per line; the final chunk
          // carries only the never-emitted remainder (usually '' — a full
          // re-send of result.text would duplicate everything).
          const remainder = streamBuffer ? streamBuffer.finalRemainder() : '';
          if (remainder) {
            sendChunk({ content: remainder }, null);
          }
          const textFinalChunk: Record<string, unknown> = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: toOpenAIUsage(result.usage),
          };
          raw.write(sseData(textFinalChunk));
        }
      } else {
        const finalChunk: Record<string, unknown> = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: requestedModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: toOpenAIUsage(result.usage),
        };
        raw.write(sseData(finalChunk));
      }
    } catch (err) {
      // Already OpenAI-shaped ({error:{message,...}}); do NOT double-wrap or
      // the SDK fails type validation and retries uselessly.
      const mapped = mapTurnError(err);
      // T17 telemetry: failures by class.
      telemetry.errors += 1;
      if (err instanceof AgyTimeoutError) {
        telemetry.timeouts += 1;
      }
      if (err instanceof AgyToolDeniedError) {
        telemetry.deniedFatal += 1;
      }
      logBridgeLine(
        'POST',
        chatPath,
        mapped.status,
        chatIdentity.sessionId,
        chatIdentity.agent,
        chatIdentity.msgId,
        `err=${errorCodeFromBody(mapped.body)}`,
      );
      if (!clientGone) {
        raw.write(sseData(mapped.body));
        raw.write('data: [DONE]\n\n');
        raw.end();
      }
      return undefined;
    }
    if (clientGone) {
      telemetry.aborts += 1;
      logBridgeLine(
        'POST',
        chatPath,
        'aborted',
        chatIdentity.sessionId,
        chatIdentity.agent,
        chatIdentity.msgId,
        'err=client-gone',
      );
      return undefined;
    }
    raw.write('data: [DONE]\n\n');
    raw.end();
    return undefined;
  });

  return app;
}
