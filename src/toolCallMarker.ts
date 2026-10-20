// Shared parser for the text tool-call protocol the bridge sends to agy.
//
// Canonical form (documented in the prompt):
//   TOOL_CALL: {"name": "skill", "arguments": {"id": "docx"}}
//
// Models also naturally emit the shorthand:
//   TOOL_CALL: skill {"id": "docx"}
//   TOOL_CALL: skill({"id": "docx"})
//   TOOL_CALL: list_dir
//
// Both are accepted. Parsing is deliberately strict about the line prefix but
// tolerant about the argument shape; an unknown tool name is never fabricated.

export const TOOL_CALL_PREFIX = 'TOOL_CALL:'

export interface ParsedToolCallMarker {
  name: string
  arguments: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Remainder after the marker prefix, or null when the line is not a marker. */
export function markerRemainder(line: string): string | null {
  const trimmed = line.replace(/^\s+/, '')
  if (!trimmed.startsWith(TOOL_CALL_PREFIX)) {
    return null
  }
  return trimmed.slice(TOOL_CALL_PREFIX.length)
}

/** Drop a trailing ``` fence so fenced JSON still parses. */
export function stripTrailingFence(value: string): string {
  const trimmed = value.trim()
  return trimmed.endsWith('```') ? trimmed.slice(0, -3).trim() : trimmed
}

function parseRemainder(remainder: string): ParsedToolCallMarker | null {
  const raw = stripTrailingFence(remainder).trim()
  if (!raw) {
    return null
  }

  // Canonical object form.
  if (raw.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (!isRecord(parsed) || typeof parsed['name'] !== 'string' || parsed['name'].length === 0) {
      return null
    }
    if (parsed['arguments'] === undefined) {
      return { name: parsed['name'], arguments: {} }
    }
    if (!isRecord(parsed['arguments'])) {
      return null
    }
    return { name: parsed['name'], arguments: parsed['arguments'] }
  }

  // Shorthand: <name> [<json>] or <name>(<json>).
  const nameMatch = raw.match(/^([A-Za-z0-9_.-]+)/)
  if (!nameMatch) {
    return null
  }
  const name = nameMatch[1]!
  let rest = raw.slice(name.length).trim()
  if (!rest) {
    return { name, arguments: {} }
  }
  if (rest.startsWith('(') && rest.endsWith(')')) {
    rest = rest.slice(1, -1).trim()
  }
  if (!rest.startsWith('{')) {
    return null
  }
  let args: unknown
  try {
    args = JSON.parse(stripTrailingFence(rest))
  } catch {
    return null
  }
  if (!isRecord(args)) {
    return null
  }
  return { name, arguments: args }
}

/**
 * Parse the first TOOL_CALL marker line in the model text.
 *
 * Returns null when there is no marker, the arguments do not parse, the shape
 * is invalid, or the name is not among `allowedNames` (a hallucinated tool must
 * stream back as plain text — never be fabricated into a call).
 *
 * The first marker line decides the turn: failure there is null, not "keep
 * scanning" (text before a marker is intentionally discarded by the caller).
 */
export function parseToolCallMarker(
  text: string,
  allowedNames?: readonly string[],
): ParsedToolCallMarker | null {
  const allow = allowedNames ? new Set(allowedNames) : null
  for (const line of text.split('\n')) {
    const remainder = markerRemainder(line)
    if (remainder === null) {
      continue
    }
    const call = parseRemainder(remainder)
    if (!call) {
      return null
    }
    if (allow && !allow.has(call.name)) {
      return null
    }
    return call
  }
  return null
}
