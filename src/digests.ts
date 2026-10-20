// Canonical message digests for session mode (Phase 1).
//
// A ledger entry proves "agy already knows this message". Incoming opencode
// history is canonicalized so volatile wrappers (transient system-reminders,
// daily date rollovers, prune placeholders, random tool_call ids) do NOT
// cause false divergence. Pure functions, exported for unit tests.

import { createHash } from 'node:crypto';
import { parseToolCallMarker } from './toolCallMarker';

/** sha1 hex of a string (node:crypto only, no new deps). */
export function sha1Hex(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Collapse all whitespace runs to one space and trim. */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// One volatile date/env line inside a SYSTEM message only (never user text).
const VOLATILE_LINE_RE = /^\s*(\*+\s*)?(date|today|current date)\b/i;

/** Content that a compaction prune (or an empty result) leaves behind. */
export function isWildcardToolOutput(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return true;
  }
  return /pruned|omitted|redacted|placeholder|\[compaction/i.test(trimmed);
}

interface TextPart {
  type?: unknown;
  text?: unknown;
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as TextPart[])
      .filter((part) => typeof part?.text === 'string')
      .map((part) => part.text as string)
      .join('');
  }
  return '';
}

/** Recursively sort object keys so arg JSON digests are key-order stable. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Best-effort canonical args: JSON string or object -> sorted compact JSON. */
export function canonicalArgs(args: unknown): string {
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) {
      return '{}';
    }
    try {
      return canonicalJson(JSON.parse(trimmed) as unknown);
    } catch {
      return trimmed;
    }
  }
  if (args === undefined) {
    return '{}';
  }
  try {
    return canonicalJson(args);
  } catch {
    return String(args);
  }
}

function describeToolCallsCanonical(calls: unknown): string[] {
  if (!Array.isArray(calls)) {
    return [];
  }
  const out: string[] = [];
  for (const call of calls) {
    if (!isRecord(call)) {
      continue;
    }
    // NOTE: tool_call ids are VOLATILE (the bridge mints call_<rand> per turn
    // and opencode echoes it back). Digests deliberately ignore ids so the
    // assistant echo confirms the provisional tail.
    const fn = call['function'];
    if (!isRecord(fn) || typeof fn['name'] !== 'string' || !fn['name']) {
      continue;
    }
    out.push(`calls tool ${fn['name']} with arguments ${canonicalArgs(fn['arguments'])}`);
  }
  return out;
}

/**
 * Canonical form of ONE message. Roles are prefixed so a user/assistant swap
 * can never digest-equal. Messages that canonicalize to nothing digest as
 * `role:(empty)` (stable, never the empty string).
 */
export function canonicalMessage(message: unknown): string {
  if (!isRecord(message)) {
    return 'unknown:(empty)';
  }
  const role = typeof message['role'] === 'string' && message['role'] ? message['role'] : 'user';

  if (role === 'assistant' && Array.isArray(message['tool_calls'])) {
    const calls = describeToolCallsCanonical(message['tool_calls']);
    const text = normalizeWhitespace(contentToString(message['content']));
    const parts = [...calls];
    if (text) {
      parts.push(text);
    }
    const body = parts.join('; ');
    return body ? `assistant:${body}` : 'assistant:(empty)';
  }

  if (role === 'tool') {
    // tool_call_id ignored (volatile, see above); name preferred, id never.
    const name =
      (typeof message['name'] === 'string' && message['name']) || 'unknown_tool';
    const raw = contentToString(message['content']);
    if (isWildcardToolOutput(raw)) {
      return `tool ${name}:*`;
    }
    const body = normalizeWhitespace(raw);
    return body ? `tool ${name}:${body}` : `tool ${name}:(empty)`;
  }

  let raw = contentToString(message['content']);
  if (role === 'system') {
    raw = raw.replace(SYSTEM_REMINDER_RE, '');
    const kept = raw
      .split('\n')
      .filter((line) => !VOLATILE_LINE_RE.test(line))
      .join('\n');
    raw = kept;
  }
  const body = normalizeWhitespace(raw);
  return body ? `${role}:${body}` : `${role}:(empty)`;
}

/** Canonical form of each message in order. */
export function canonicalMessages(messages: unknown[]): string[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.map((message) => canonicalMessage(message));
}

/** True for system-role messages (tracked via systemDigest, not the ledger). */
export function isSystemMessage(message: unknown): boolean {
  return isRecord(message) && message['role'] === 'system';
}

/**
 * Ledger view of history: system messages EXCLUDED. System content changes
 * (date rollover, AGENTS.md edits, agent switches) must produce a
 * `[context refresh]` block in the next delta — never a false-divergence
 * rebootstrap (design rows 16/17). Both selection and confirm use this view,
 * so ledger indices always align with it (never with the raw array).
 */
export function ledgerMessages(messages: unknown[]): unknown[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  return messages.filter((message) => !isSystemMessage(message));
}

/** sha1 per ledger message, in order. */
export function ledgerDigests(messages: unknown[]): string[] {
  return canonicalMessages(ledgerMessages(messages)).map((canonical) => sha1Hex(canonical));
}

/** sha1 per canonical message, in order. */
export function messageDigests(messages: unknown[]): string[] {
  return canonicalMessages(messages).map((canonical) => sha1Hex(canonical));
}

/** Digest of system-role messages only (for the [context refresh] diff). */
export function systemDigest(messages: unknown[]): string {
  if (!Array.isArray(messages)) {
    return sha1Hex('system:(empty)');
  }
  const systemForms = messages
    .filter((message) => isRecord(message) && message['role'] === 'system')
    .map((message) => canonicalMessage(message));
  return sha1Hex(systemForms.join('\n'));
}

/**
 * Digest of OUR assistant response in the canonical form opencode will echo
 * it back as: plain text -> `assistant:<text>`; a TOOL_CALL marker turn ->
 * the assistant tool_calls form (ids excluded). Best-effort: unparsable
 * markers fall back to normalized text. Accepts the same canonical and
 * shorthand marker forms as the request relay.
 */
export function provisionalDigestForResponse(
  text: string,
  allowedNames?: readonly string[],
): string {
  const call = parseToolCallMarker(text, allowedNames);
  if (call) {
    return sha1Hex(
      `assistant:calls tool ${call.name} with arguments ${canonicalJson(call.arguments)}`,
    );
  }
  const body = normalizeWhitespace(text);
  return sha1Hex(body ? `assistant:${body}` : 'assistant:(empty)');
}
