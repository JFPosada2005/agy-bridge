// Shared helpers for slice-3 agy verification experiments (E2/E5/E6/E7/E8).
// Spawns the official agy binary exactly like the bridge does:
//   agy --output-format stream-json --model <base> [--effort <e>]
//       --input-format text --disable-slash-commands [--conversation <id>]
// Prompt travels on stdin. NEVER --continue, NEVER --dangerously-skip-permissions.
// Read-only evidence comes from conversation_summaries.db (metadata only).
import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGY_BIN =
  process.env.AGY_BIN ??
  (process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe` : 'agy');
export const MODEL_BASE = 'gemini-3.6-flash';
export const MODEL_SLUG = 'gemini-3.6-flash-low';
export const EFFORT_DEFAULT = 'low';

const DB_PATH = `${process.env.USERPROFILE}\\.gemini\\antigravity-cli\\conversation_summaries.db`;

// STRICT LIVE-REQUEST BUDGET: max 8 real agy turns TOTAL across all experiments.
// Every spawn counts (including kills/failures). Incremented at spawn time.
export const budget = { used: 0, max: 8 };

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Deep-search any object for the first conversation id under known key names.
export function findConversationIdDeep(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 7) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findConversationIdDeep(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const k of ['conversation_id', 'conversationId', 'conversationID']) {
    const v = obj[k];
    if (typeof v === 'string' && v.length >= 8) return v;
  }
  for (const v of Object.values(obj)) {
    const r = findConversationIdDeep(v, depth + 1);
    if (r) return r;
  }
  return null;
}

function eventKind(ev) {
  for (const k of ['type', 'event', 'kind']) {
    const v = ev[k];
    if (v === 'init' || v === 'step_update' || v === 'result' || v === 'error') return v;
  }
  return 'other';
}

function asText(v) {
  if (typeof v === 'string') return v;
  if (isRecord(v) && typeof v.text === 'string') return v.text;
  return '';
}

function nestedPayload(ev) {
  for (const k of ['step_update', 'result', 'init', 'data', 'payload', 'error']) {
    if (isRecord(ev[k])) return ev[k];
  }
  return null;
}

function extractDelta(ev) {
  const nested = nestedPayload(ev);
  const sources = nested ? [nested, ev] : [ev];
  for (const s of sources) {
    for (const k of ['text_delta', 'textDelta', 'content_delta', 'contentDelta', 'delta']) {
      const t = asText(s[k]);
      if (t) return t;
    }
  }
  return '';
}

function extractResultText(ev) {
  const nested = nestedPayload(ev);
  const sources = nested ? [nested, ev] : [ev];
  for (const s of sources) {
    for (const k of ['response', 'result', 'text', 'output', 'content']) {
      const t = asText(s[k]);
      if (t) return t;
    }
  }
  const nested2 = nested ?? ev;
  if (isRecord(nested2.message)) {
    const t = asText(nested2.message.content);
    if (t) return t;
  }
  return '';
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;
}

// Merge token usage from any holder object (agy + bridge key spellings).
function mergeUsage(holder, acc, sightings) {
  const cand = {
    input_tokens: num(holder.input_tokens) ?? num(holder.prompt_tokens),
    cache_read_tokens: num(holder.cache_read_tokens),
    output_tokens: num(holder.output_tokens) ?? num(holder.completion_tokens),
    thinking_tokens: num(holder.thinking_tokens) ?? num(holder.thinkingTokens),
    total_tokens: num(holder.total_tokens) ?? num(holder.totalTokens),
  };
  let hit = false;
  for (const [k, v] of Object.entries(cand)) {
    if (v !== undefined) {
      acc[k] = v; // last sighting wins (terminal result event is authoritative)
      hit = true;
    }
  }
  if (hit) sightings.push({ ...cand });
}

function scrubUsageDeep(obj, acc, sightings, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  if (Array.isArray(obj)) {
    for (const v of obj) scrubUsageDeep(v, acc, sightings, depth + 1);
    return;
  }
  if ('input_tokens' in obj || 'cache_read_tokens' in obj || 'output_tokens' in obj) {
    mergeUsage(obj, acc, sightings);
  }
  for (const v of Object.values(obj)) scrubUsageDeep(v, acc, sightings, depth + 1);
}

export function killTree(pid) {
  return new Promise((done) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => done());
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run ONE live agy turn in a fresh process. Counts 1 against the budget.
 * Returns a plain-JSON-safe record (no raw event dumps, capped strings).
 */
export function runTurn({
  prompt,
  effort = EFFORT_DEFAULT,
  conversationId = null,
  cwd,
  timeoutMs = 300000,
  killAfterMs = null,
  label = 'turn',
}) {
  return new Promise((resolveTurn) => {
    const args = [
      '--output-format', 'stream-json',
      '--model', MODEL_BASE,
      ...(effort ? ['--effort', effort] : []),
      '--input-format', 'text',
      '--disable-slash-commands',
      ...(conversationId ? ['--conversation', conversationId] : []),
    ];
    let child;
    try {
      child = spawn(AGY_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd });
    } catch (err) {
      resolveTurn({ label, spawnError: String(err?.message ?? err), exitCode: null });
      return;
    }
    budget.used += 1; // every successful spawn counts, even kills/failures
    const startedAt = Date.now();
    let stdoutBuf = '';
    let stderr = '';
    let text = '';
    let sawDelta = false;
    let convFromInit = null;
    let convAny = null;
    let resultEvent = null;
    let errorEventText = '';
    let eventCount = 0;
    const usage = {};
    const usageSightings = [];
    let killedByUs = false;
    let timedOut = false;
    let killTimer = null;
    let timeoutTimer = null;

    const finish = (extra = {}) => {
      if (killTimer) clearTimeout(killTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (!sawDelta && resultEvent) text = extractResultText(resultEvent);
      resolveTurn({
        label,
        exitCode: extra.exitCode ?? null,
        signal: extra.signal ?? null,
        conversationId: convFromInit ?? convAny,
        conversationIdFromInit: convFromInit,
        text,
        textLength: text.length,
        usage,
        usageSightings,
        eventCount,
        stderr: stderr.slice(0, 3000),
        errorEventText: errorEventText.slice(0, 1000),
        ms: Date.now() - startedAt,
        killedByUs,
        timedOut,
        budgetUsedAfter: budget.used,
        ...extra.summary,
      });
    };

    const handleLine = (line) => {
      const t = line.trim();
      if (!t || !t.startsWith('{')) return;
      let ev;
      try {
        ev = JSON.parse(t);
      } catch {
        return;
      }
      if (!isRecord(ev)) return;
      eventCount += 1;
      const kind = eventKind(ev);
      const found = findConversationIdDeep(ev);
      if (found && !convAny) convAny = found;
      if (kind === 'init' && found && !convFromInit) convFromInit = found;
      if (kind === 'step_update' || kind === 'other') {
        const d = extractDelta(ev);
        if (d) {
          text += d;
          sawDelta = true;
        }
      }
      if (kind === 'error') errorEventText += JSON.stringify(ev).slice(0, 1000);
      scrubUsageDeep(ev, usage, usageSightings);
      if (kind === 'result') resultEvent = ev;
    };

    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      let i = stdoutBuf.indexOf('\n');
      while (i >= 0) {
        handleLine(stdoutBuf.slice(0, i));
        stdoutBuf = stdoutBuf.slice(i + 1);
        i = stdoutBuf.indexOf('\n');
      }
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ exitCode: null, summary: { spawnError: String(err?.message ?? err) } });
    });
    child.on('close', (code, signal) => {
      if (stdoutBuf.length > 0) {
        handleLine(stdoutBuf);
        stdoutBuf = '';
      }
      finish({ exitCode: code, signal: signal ?? null });
    });

    if (killAfterMs != null) {
      killTimer = setTimeout(() => {
        killedByUs = true;
        if (child.pid) void killTree(child.pid);
      }, killAfterMs);
    }
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid) void killTree(child.pid);
    }, timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();

    try {
      child.stdin?.write(prompt);
      child.stdin?.end();
    } catch (err) {
      finish({ exitCode: null, summary: { spawnError: String(err?.message ?? err) } });
    }
  });
}

/**
 * Read-only lookup of one conversation's metadata row (status flags +
 * workspace_uris). Tries a read-only URI first, falls back to a plain open.
 * Returns null when the row is not (yet) visible.
 */
export function readSummary(conversationId) {
  if (!/^[0-9a-fA-F-]{8,}$/.test(conversationId)) {
    return Promise.resolve({ error: 'refused: not a uuid-shaped id' });
  }
  const sql =
    'SELECT conversation_id, status, workspace_uris, not_fully_idle, killed,' +
    ' title, last_modified_time, step_count FROM conversation_summaries' +
    ` WHERE conversation_id = '${conversationId}';`;
  const attempts = [
    [`file:${DB_PATH.replace(/\\/g, '/')}?mode=ro`, sql],
    [DB_PATH, sql],
  ];
  return new Promise((resolve) => {
    const tryOpen = (i) => {
      if (i >= attempts.length) {
        resolve(null);
        return;
      }
      execFile('sqlite3', ['-separator', '|', attempts[i][0], attempts[i][1]], (err, stdout) => {
        if (err) {
          tryOpen(i + 1);
          return;
        }
        const line = stdout.trim().split('\n').filter(Boolean)[0];
        if (!line) {
          resolve(null);
          return;
        }
        const [cid, status, workspaceUris, notFullyIdle, killed, title, lastModified, stepCount] =
          line.split('|');
        let uris = null;
        try {
          uris = JSON.parse(workspaceUris);
        } catch {
          uris = workspaceUris;
        }
        resolve({
          conversation_id: cid,
          status,
          workspace_uris: uris,
          not_fully_idle: Number(notFullyIdle) === 1,
          killed: Number(killed) === 1,
          title: (title ?? '').slice(0, 200),
          last_modified_time: lastModified ?? null,
          step_count: stepCount != null && stepCount !== '' ? Number(stepCount) : null,
        });
      });
    };
    tryOpen(0);
  });
}

export async function readSummaryWithRetry(conversationId, attempts = 4, delayMs = 3000) {
  let last = null;
  for (let i = 0; i < attempts; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    last = await readSummary(conversationId);
    if (last) return last;
    // eslint-disable-next-line no-await-in-loop
    await sleep(delayMs);
  }
  return last;
}

export function expectedWorkspaceUri(absDir) {
  return encodeURI(`file:///${absDir.replace(/\\/g, '/')}`);
}

export function writeJson(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

export function repoRoot() {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
}
