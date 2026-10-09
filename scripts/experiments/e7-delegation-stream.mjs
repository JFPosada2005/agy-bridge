// E7: raw-stream probe — what does agy ACTUALLY do when asked to delegate
// a subagent? Captures EVERY stream-jsoEvent for a delegation request under
// the bridge-equivalent context (manifest + TOOL_CALL protocol + task nudge
// + per-turn reminder), flagging any event carrying tool/agent/permission/
// delegation markers. Answers: native agent attempt? TOOL_CALL marker?
// prose-only fabrication?
// Invariant: official agy binary only; no --continue; no
// --dangerously-skip-permissions.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGY_BIN =
  process.env.AGY_BIN ??
  (process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe` : 'agy');

const model = process.env.E7_MODEL ?? 'gemini-3.8-flash-medium';
const effort = process.env.E7_EFFORT ?? 'medium';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ws = join(root, 'design', 'experiments', 'ws-e7');
mkdirSync(ws, { recursive: true });

const result = {
  experiment: 'E7',
  goal: 'raw delegation behavior under bridge-equivalent manifest + reminder',
  model,
  effort,
  flaggedEvents: [],
  resultResponse: null,
  verdict: 'UNKNOWN',
};

const MANIFEST = [
  '# TOOL PROTOCOL (meta-level; obey strictly in every turn)',
  'You are a bridge-agent: a host runtime (opencode) executes tools for you.',
  '### task — Launch a background subagent child session. Args: {"agent":"<name>","prompt":"<task>"}',
  '### bash — Run one shell command. Args: {"command":"<cmd>"}',
  '### write — Create or overwrite a file. Args: {"filePath":"<path>","content":"<text>"}',
  '# INVOCATION RULE',
  'At the END of every turn, for EACH tool call emit one line EXACTLY:',
  'TOOL_CALL: <toolname> {"arg":"value"}',
  'Only an emitted marker executes; prose claiming an action is NOT an action.',
  'IMPORTANT: `task` genuinely launches a background subagent (separate child session); effort to delegate research/work: emit `TOOL_CALL: task {"agent":"<name>","prompt":"<task>"}`. Never claim subagent delegation is unavailable and never fabricate having delegated.',
];

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

const child = spawn(
  AGY_BIN,
  [
    '--output-format', 'stream-json',
    '--model', model,
    '--effort', effort,
    '--input-format', 'stream-json',
    '--disable-slash-commands',
  ],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd: ws },
);

const pending = [];
let buf = '';
const flagPattern = /tool_call|TOOL_CALL|agent|permission|deny|denied|subagent|delegat|task|tech_researcher|antigravity_user|conversationId|tool/i;
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
child.on('close', () => {
  alive = false;
});

function drainFlagged() {
  // Flag interesting NON-result events; leave everything else (including
  // results) in `pending` for pendingResult() to consume.
  for (let idx = 0; idx < pending.length; ) {
    let ev;
    try {
      ev = JSON.parse(pending[idx]);
    } catch {
      idx++;
      continue;
    }
    const blob = JSON.stringify(ev);
    if (flagPattern.test(blob) && eventKind(ev) !== 'result') {
      result.flaggedEvents.push({ kind: eventKind(ev), blob: blob.slice(0, 400) });
      pending.splice(idx, 1);
      continue;
    }
    idx++;
  }
}

async function awaitResult(timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive) {
    drainFlagged();
    for (const lineSplice of pending) {
      void lineSplice;
      // results are captured via flag
    }
  }
  return null;
}
// Simpler: poll for result event directly.
function pendingResult() {
  for (let idx = 0; idx < pending.length; idx++) {
    let ev;
    try {
      ev = JSON.parse(pending[idx]);
    } catch {
      continue;
    }
    if (eventKind(ev) === 'result') {
      pending.splice(idx, 1);
      return {
        response: deepFirstString(ev, ['response', 'text', 'output', 'content']),
        raw: JSON.stringify(ev).slice(0, 3000),
      };
    }
  }
  return null;
}

async function waitKind(timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && alive) {
    drainFlagged();
    const r = pendingResult();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 150));
  }
  drainFlagged();
  return { response: '', raw: `timeout/alive=${alive} stderr=${stderr.slice(-300)}` };
}

main().catch((err) => {
  result.error = String(err?.stack ?? err);
  writeFileSync(join(root, 'design', 'experiments', 'e7.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.error(result.error);
  if (alive) child.kill();
  process.exitCode = 1;
});

async function main() {
  // Kick the lane alive, then ask for a delegation with the bridge context.
  child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: `${MANIFEST.join('\n')}\n\nReply with the single word READY.` } })}\n`);
  const a = await waitKind(240000);
  result.baseline = a.response?.slice(0, 30);

  child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: 'Delegate the investigation of 2026 office Wi-Fi standards to a subagent (it must save a research .md). Execute this through the environment protocol right now.' } })}\n`);
  const d = await waitKind(240000);
  result.resultResponse = d.response;
  try {
    child.kill();
  } catch {
    // Gone.
  }

  const emittedMarker = /tool_call:\s*task/i.test(d.response ?? '');
  result.verdict = emittedMarker ? 'EMITS_TOOL_CALL_TASK' : 'NO_TOOL_CALL_EMITTED';
  writeFileSync(join(root, 'design', 'experiments', 'e7.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    verdict: result.verdict,
    baseline: result.baseline,
    response: (d.response ?? '').slice(0, 500),
    flaggedCount: result.flaggedEvents.length,
    flaggedKinds: result.flaggedEvents.slice(-12).map((f) => f.kind),
  }, null, 2));
}
