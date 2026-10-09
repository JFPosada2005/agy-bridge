// E3 v3 FINAL: stream-json persistent lane (Phase 3 gate).
// Known: input NDJSON line = {event: 'user_input', <content-field>: string}.
// Phase 1: discover the content field (text|message|content) â€” one probe
// each, waiting for a REAL result (response text non-empty).
// Phase 2: persistent-lane proof â€” TWO turns into the SAME process, one
// result each, with per-turn usage sightings.
// Invariant: official agy binary only; no --continue; no
// --dangerously-skip-permissions.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGY_BIN =
  process.env.AGY_BIN ??
  (process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe` : 'agy');

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ws = join(root, 'design', 'experiments', 'ws-e3');
mkdirSync(ws, { recursive: true });

const result = {
  experiment: 'E3',
  v: 3,
  goal: 'persistent stream-json lane: content field + two-turn proof + usage semantics',
  model: 'gemini-3.6-flash-low',
  effort: 'low',
  cwd: ws,
  phase1: [],
  phase2: null,
  verdict: 'UNKNOWN',
};

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function findConversationIdDeep(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 7) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const r = findConversationIdDeep(v, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const k of ['conversation_id', 'conversationId']) {
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
    if (typeof ev[k] === 'string') return ev[k];
  }
  return 'other';
}
function deepFirstString(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return '';
  for (const k of keys) {
    if (typeof obj[k] === 'string' && obj[k]) return obj[k];
  }
  for (const v of Object.values(obj)) {
    const r = deepFirstString(v, keys, depth + 1);
    if (r) return r;
  }
  return '';
}
function usageSightings(obj, acc, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return;
  if (Array.isArray(obj)) {
    for (const v of obj) usageSightings(v, acc, depth + 1);
    return;
  }
  if ('input_tokens' in obj || 'output_tokens' in obj || 'cache_read_tokens' in obj) {
    acc.push({
      input_tokens: typeof obj.input_tokens === 'number' ? obj.input_tokens : undefined,
      cache_read_tokens: typeof obj.cache_read_tokens === 'number' ? obj.cache_read_tokens : undefined,
      output_tokens: typeof obj.output_tokens === 'number' ? obj.output_tokens : undefined,
    });
  }
  for (const v of Object.values(obj)) usageSightings(v, acc, depth + 1);
}

function laneSession() {
  const child = spawn(
    AGY_BIN,
    [
      '--output-format', 'stream-json',
      '--model', 'gemini-3.6-flash',
      '--effort', 'low',
      '--input-format', 'stream-json',
      '--disable-slash-commands',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: ws },
  );
  const pending = [];
  let buf = '';
  child.stdout?.on('data', (c) => {
    buf += c.toString('utf8');
    let i = buf.indexOf('\n');
    while (i >= 0) {
      pending.push(buf.slice(0, i));
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
    }
  });
  let stderr = '';
  child.stderr?.on('data', (c) => {
    stderr += c.toString('utf8');
  });
  let alive = true;
  child.on('close', (code) => {
    alive = false;
  });
  return {
    child,
    alive: () => alive,
    stderrText: () => stderr,
    writeTurn: (field, text) => {
      try {
        child.stdin.write(`${JSON.stringify({ event: 'user_input', ...(field ? { [field]: text } : {}) })}\n`);
        return true;
      } catch {
        return false;
      }
    },
    writeTurnWithMessage: (message) => {
      try {
        child.stdin.write(`${JSON.stringify({ event: 'user', message })}\n`);
        return true;
      } catch {
        return false;
      }
    },
    awaitResult: async (timeoutMs = 180000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && alive) {
        while (pending.length > 0) {
          const line = pending.shift();
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          const kind = eventKind(ev);
          if (kind === 'result') {
            const usage = [];
            usageSightings(ev, usage);
            return {
              kind,
              conversationId: findConversationIdDeep(ev),
              response: deepFirstString(ev, ['response', 'text', 'output', 'content']),
              usageLast: usage[usage.length - 1] ?? null,
              compact: JSON.stringify(ev).slice(0, 900),
            };
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      return { kind: 'timeout-or-exit', alive, stderr: stderr.slice(-400) };
    },
    kill: () => {
      try {
        child.kill();
      } catch {
        // Gone.
      }
    },
  };
}

async function main() {
  // ---- Phase 1: content field discovery ----
  let contentField = null;
  // Shape discovery in ONE process: decode errors are free (no model turn),
  // so iterate shapes after each ERROR result until one runs a real turn.
  const SHAPES = [
    { name: 'content-string', message: { content: 'Reply with exactly this word and nothing else: FIELDPROBE' } },
    { name: 'items-strings', message: { items: ['Reply with exactly this word and nothing else: FIELDPROBE'] } },
    { name: 'items-objects', message: { items: [{ text: 'Reply with exactly this word and nothing else: FIELDPROBE' }] } },
    { name: 'content-string-message', message: { content: 'Reply with exactly this word and nothing else: FIELDPROBE', role: 'user' } },
  ];
  const shapeResults = [];
  let foundShape = null;
  let lane = laneSession();
  for (const shape of SHAPES) {
    if (!lane.alive()) {
      lane = laneSession(); // respawn after process death; errors are free
    }
    lane.writeTurnWithMessage(shape.message);
    const r = await lane.awaitResult(120000);
    const isError = /failed to decode/.test(r.compact ?? '') || /status..ERROR/.test(r.compact ?? '') || (r.stderr ?? '').includes('error:');
    shapeResults.push({
      shape: shape.name,
      kind: r.kind,
      isError,
      response: (r.response ?? '').slice(0, 40),
      conversationId: r.conversationId,
      usage: r.usageLast,
      stderr: lane.stderrText().slice(-200),
    });
    result.phase1.push(shapeResults[shapeResults.length - 1]);
    if (!isError && r.kind === 'result' && (r.response ?? '').length > 0) {
      foundShape = shape;
      contentField = shape.name;
      break;
    }
  }
  result.contentField = contentField;
  if (!foundShape) {
    result.verdict = 'NO_SHAPE_ACCEPTED';
    lane.kill();
    writeFileSync(join(root, 'design', 'experiments', 'e3.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ verdict: result.verdict, phase1: shapeResults }, null, 2));
    return;
  }

  // ---- Persistent proof: two more turns in the SAME process ----
  const prime = Object.keys(foundShape.message)[0];
  lane.writeTurnWithMessage({ [prime]: 'Reply with exactly this word and nothing else: TURNONE' });
  const t1 = await lane.awaitResult(180000);
  lane.writeTurnWithMessage({ [prime]: 'Reply with exactly this word and nothing else: TURNTWO' });
  const t2 = await lane.awaitResult(180000);
  lane.kill();
  result.phase2 = { turn1: t1, turn2: t2 };
  const ok =
    t1.kind === 'result' &&
    t2.kind === 'result' &&
    (t1.response ?? '').length > 0 &&
    (t2.response ?? '').length > 0;
  result.verdict = ok ? 'PERSISTENT_LANE_OK' : 'LANE_INCOMPLETE';
  writeFileSync(join(root, 'design', 'experiments', 'e3.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ verdict: result.verdict, contentField, phase2: { turn1: { response: t1.response, usage: t1.usageLast }, turn2: { response: t2.response, usage: t2.usageLast } } }, null, 2));
}

main().catch((err) => {
  result.error = String(err?.stack ?? err);
  writeFileSync(join(root, 'design', 'experiments', 'e3.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.error(result.error);
  process.exitCode = 1;
});
