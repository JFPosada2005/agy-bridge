// E6: does conversation compaction inside the agy lane ERASE the tool
// protocol knowledge (manifest + TOOL_CALL instructions)? Phase-3 hardening
// gate. Protocol: Phase A: seed manifest (realistic scale: TOOL_CALL
// instructions + subagent rule + ~217 synthetic tool entries), verify
// baseline recall. Phase B: manual compaction turn (summary REPLACES
// history — models the T14 side-turn semantics). Phase C: recall probe
// (does the model still know the tool call syntax + task tool?).
// Phase D: behavioral probe (does a delegation request EMIT `TOOL_CALL:
// task` after compaction, or just prose?).
// Verdict: PROTOCOL_SURVIVES | PROTOCOL_DEGRADED | PROTOCOL_LOST.
// Invariant: official agy binary only; no --continue; no
// --dangerously-skip-permissions.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGY_BIN =
  process.env.AGY_BIN ??
  (process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe` : 'agy');

const model = process.env.E6_MODEL ?? 'gemini-3.8-flash-medium';
const effort = process.env.E6_EFFORT ?? 'medium';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ws = join(root, 'design', 'experiments', 'ws-e6');
mkdirSync(ws, { recursive: true });

const result = {
  experiment: 'E6',
  goal: 'manifest/TOOL_CALL protocol survival across a compaction turn in-lane',
  model,
  effort,
  cwd: ws,
  phaseA: null,
  phaseB: null,
  phaseC: null,
  phaseD: null,
  verdict: 'UNKNOWN',
};

// ---- Manifest at realistic scale (model must treat lines as meta-instruction) ----
const MANIFEST = [
  '# TOOL PROTOCOL (meta-level; obey strictly in every turn)',
  'You are a bridge-agent: a host runtime (opencode) executes tools for you.',
  'Tools available (synthetic filler at production-like scale):',
  '### task — Launch a background subagent child session. Args: {"agent":"<name>","prompt":"<task>"}',
  '### bash — Run one shell command. Args: {"command":"<cmd>"}',
  '### write — Create or overwrite a file. Args: {"filePath":"<path>","content":"<text>"}',
  '### edit — Edit an existing file. Args: {"filePath":"<path>","find":"<old>","replace":"<new>"}',
  '### read — Read a file. Args: {"filePath":"<path>"}',
  '### glob — List files by pattern. Args: {"pattern":"<glob>"}',
];
for (let i = 1; i <= 211; i++) {
  MANIFEST.push(`### synthetic_mcp_tool_${i} — Generic synthetic capability ${i} (filler for manifest realism).`);
}
MANIFEST.push(
  '# INVOCATION RULE (critical)',
  'At the END of every turn, for EACH tool call emit one line EXACTLY:',
  'TOOL_CALL: <toolname> {"arg":"value"}',
  'The bridge runtime executes each call and returns results next turn. Prose is NOT a tool call; only the marker is.',
);

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

function laneSession() {
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
    writeTurn: (text) => {
      try {
        child.stdin.write(`${JSON.stringify({ event: 'user', message: { content: text } })}\n`);
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
          if (eventKind(ev) === 'result') {
            return {
              kind: 'result',
              response: deepFirstString(ev, ['response', 'text', 'output', 'content']),
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
  const lane = laneSession();

  // ---- Phase A: manifest seed + baseline recall ----
  const a1 = await lane.awaitResult(30000);
  result.phaseA = { warmup: a1.kind };
  lane.writeTurn(`${MANIFEST.join('\n')}\n\nUSER REQUEST: reply with the single word READY only.`);
  const a2 = await lane.awaitResult(180000);
  lane.writeTurn('List your available tools (names only), then state EXACTLY the line syntax you must emit to invoke one.');
  const a3 = await lane.awaitResult(180000);
  const a3Response = (a3.response ?? '').trim();
  const baselineOk =
    a3Response.length > 0 &&
    /tool_call:/i.test(a3Response) &&
    /task|bash|write/i.test(a3Response);
  result.phaseA = { ready: (a2.response ?? '').slice(0, 20), recall: a3Response.slice(0, 400), baselineOk };
  if (!baselineOk) {
    lane.kill();
    result.verdict = 'BASELINE_FAILURE';
    writeFileSync(join(root, 'design', 'experiments', 'e6.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ verdict: result.verdict, phaseA: result.phaseA }, null, 2));
    return;
  }

  // ---- Phase B: manual compaction turn (T14 side-turn semantics model) ----
  lane.writeTurn(
    'CONTEXT COMPACTION: summarize the ENTIRE conversation so far (including the tool protocol block) ' +
      'into one compact summary. That summary REPLACES the conversation history going forward; ' +
      'pre-summary raw history may be treated as dropped per your internal compaction policy. ' +
      'Reply with the summary only.',
  );
  const b1 = await lane.awaitResult(180000);
  result.phaseB = { kind: b1.kind, summaryChars: (b1.response ?? '').length, head: (b1.response ?? '').slice(0, 220) };
  if (b1.kind !== 'result' || (b1.response ?? '').length === 0) {
    lane.kill();
    result.verdict = 'COMPACTION_TURN_FAILED';
    writeFileSync(join(root, 'design', 'experiments', 'e6.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ verdict: result.verdict, phaseB: result.phaseB }, null, 2));
    return;
  }

  // ---- Phase C: recall probe after compaction ----
  lane.writeTurn('State the exact invocation rule from this environment: what marker line must you emit to call a tool, and which tool launches a subagent?');
  const c1 = await lane.awaitResult(180000);
  const c1Response = (c1.response ?? '').trim();
  const syntaxOk = /TOOL_CALL:/i.test(c1Response);
  const taskOk = /\btask\b/i.test(c1Response);
  result.phaseC = { response: c1Response.slice(0, 400), syntaxOk, taskOk };

  // ---- Phase D: behavioral probe post-compaction (does it EMIT the marker?) ----
  lane.writeTurn('Delegate the investigation of 2026 office wifi standards to a subagent. Do it through the environment protocol.');
  const d1 = await lane.awaitResult(180000);
  const d1EmittedToolCall = /tool_call:\s*task/i.test((d1.response ?? ''));
  result.phaseD = { response: (d1.response ?? '').slice(0, 400), emittedToolCall: d1EmittedToolCall };
  lane.kill();

  result.verdict =
    syntaxOk && taskOk && d1EmittedToolCall
      ? 'PROTOCOL_SURVIVES'
      : syntaxOk || taskOk
        ? 'PROTOCOL_DEGRADED'
        : 'PROTOCOL_LOST';
  writeFileSync(join(root, 'design', 'experiments', 'e6.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    verdict: result.verdict,
    phaseA: { baselineOk: result.phaseA.baselineOk },
    phaseB: { summaryChars: result.phaseB.summaryChars },
    phaseC: { syntaxOk: result.phaseC.syntaxOk, taskOk: result.phaseC.taskOk },
    phaseD: { emittedToolCall: result.phaseD.emittedToolCall },
  }, null, 2));
}

main().catch((err) => {
  result.error = String(err?.stack ?? err);
  writeFileSync(join(root, 'design', 'experiments', 'e6.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.error(result.error);
  process.exitCode = 1;
});
