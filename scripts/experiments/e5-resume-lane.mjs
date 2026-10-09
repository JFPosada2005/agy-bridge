// E5: does `agy --conversation <id> --input-format stream-json` RESUME an
// existing conversation on a fresh persistent process? Phase 3 warm-lane
// resume gate (parent finding: lanes never engage for sessions that already
// carry a conversationId, because a fresh lane cannot resume — unless
// --conversation + stream-json works, which E3 never tested).
// Protocol: Process A (no --conversation) -> tiny turn -> capture
// conversation_id -> kill. Process B (fresh, WITH --conversation <id>,
// stream-json) -> asks for the previous answer word. Answer = SEED proves
// cross-process resume on a persistent stdin lane.
// Invariant: official agy binary only; no --continue; no
// --dangerously-skip-permissions.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGY_BIN =
  process.env.AGY_BIN ??
  (process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\agy\\bin\\agy.exe` : 'agy');

const model = process.env.E5_MODEL ?? 'gemini-3.8-flash-medium';
const effort = process.env.E5_EFFORT ?? 'medium';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const ws = join(root, 'design', 'experiments', 'ws-e5');
mkdirSync(ws, { recursive: true });

const result = {
  experiment: 'E5',
  goal: 'lane resume: fresh process + --conversation <id> + stream-json stdin',
  model,
  effort,
  cwd: ws,
  seed: null,
  resume: null,
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

function laneSession(conversationId) {
  const args = [
    '--output-format', 'stream-json',
    '--model', model,
    '--effort', effort,
    '--input-format', 'stream-json',
    '--disable-slash-commands',
  ];
  if (conversationId) args.push('--conversation', conversationId);
  const child = spawn(AGY_BIN, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: ws,
  });
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
              conversationId: findConversationIdDeep(ev),
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

async function waitHealthyProcess(lane, ms = 15000) {
  // The process must be alive before the turn can be trusted; a fast
  // close here means bad args (e.g. unknown --conversation id).
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && lane.alive() && lane.child.exitCode == null) {
    await new Promise((r) => setTimeout(r, 250));
  }
  return lane.alive();
}

async function main() {
  // ---- Phase A: seed conversation (fresh lane, no --conversation) ----
  const a = laneSession();
  a.writeTurn('Reply with exactly this word and nothing else: SEEDWORD42');
  const seed = await a.awaitResult(180000);
  a.kill();
  result.seed = seed;
  const seedConvId = seed.conversationId;
  if (seed.kind !== 'result' || !seedConvId || (seed.response ?? '').length === 0) {
    result.verdict = 'SEED_FAILED';
    writeFileSync(join(root, 'design', 'experiments', 'e5.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ verdict: result.verdict, seed }, null, 2));
    return;
  }

  // ---- Phase B: RESUME probe (fresh process WITH --conversation) ----
  const b = laneSession(seedConvId);
  if (!(await waitHealthyProcess(b))) {
    // Immediate exit: bad flag combination (resume unsupported with
    // stream-json, or conversation id rejected outright).
    b.kill();
    result.resume = {
      kind: 'process-exited-immediately',
      stderr: b.stderrText().slice(-400),
    };
    result.verdict = 'RESUME_REJECTED_AT_SPAWN';
    writeFileSync(join(root, 'design', 'experiments', 'e5.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ verdict: result.verdict, resume: result.resume }, null, 2));
    return;
  }
  b.writeTurn('What was the exact word you replied in your previous turn? Reply with exactly that word and nothing else.');
  const resume = await b.awaitResult(180000);
  b.kill();
  result.resume = resume;
  const resumedWord = (resume.response ?? '').trim();
  const ok = resume.kind === 'result' && resumedWord.includes('SEEDWORD42');
  result.verdict = ok ? 'RESUME_LANE_OK' : ok === false && resume.kind === 'result' ? 'RESUME_LOST_CONTEXT' : 'RESUME_INCOMPLETE';
  result.resumeMatch = ok;
  writeFileSync(join(root, 'design', 'experiments', 'e5.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    verdict: result.verdict,
    seed: { conversationId: seedConvId, response: seed.response },
    resume: { conversationId: resume.conversationId, response: resume.response },
  }, null, 2));
}

main().catch((err) => {
  result.error = String(err?.stack ?? err);
  writeFileSync(join(root, 'design', 'experiments', 'e5.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.error(result.error);
  process.exitCode = 1;
});
