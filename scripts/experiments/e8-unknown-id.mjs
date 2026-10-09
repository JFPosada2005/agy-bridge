// E8 — UNKNOWN CONVERSATION ID. Resume --conversation 00000000-...-00000000
// + 'Reply ACK'. Captures the exact error (exit code, stderr verbatim, stream
// events) for the design's loud-fallback path. Expected cost: 1 fast failure.
import { fileURLToPath } from 'node:url';
import { MODEL_SLUG, budget, repoRoot, runTurn, writeJson } from './lib-agy.mjs';

export const UNKNOWN_ID = '00000000-0000-0000-0000-000000000000';

export async function runE8({ wsDir, outPath }) {
  const before = budget.used;
  const turn = await runTurn({
    label: 'e8-unknown-id',
    cwd: wsDir,
    conversationId: UNKNOWN_ID,
    timeoutMs: 120000,
    prompt: 'Reply ACK',
  });
  const warnedNotFound = /conversation .* not found/i.test(`${turn.stderr ?? ''}\n${turn.errorEventText ?? ''}`);
  const answered = (turn.text ?? '').length > 0;
  // Observed 2026-10-08: unknown id -> stderr 'warning: conversation "<id>" not
  // found', exit 0, and agy ANSWERS on a silently-created FRESH conversation.
  // That is NOT a loud failure: the bridge must treat an init conversation_id
  // mismatch as fatal (design §3 init-mismatch rule), stderr warning or not.
  const verdict = warnedNotFound && turn.exitCode === 0 && answered
    ? 'WARN_THEN_FRESH'
    : turn.exitCode !== 0 || !answered
      ? 'LOUD_ERROR'
      : 'UNEXPECTED_RESUME';
  const result = {
    experiment: 'E8',
    goal: 'unknown conversation id error shape (loud-fallback path)',
    model: MODEL_SLUG,
    effort: 'low',
    live_requests_used: budget.used - before,
    verdict,
    resume_id: UNKNOWN_ID,
    exitCode: turn.exitCode,
    signal: turn.signal ?? null,
    stderr_verbatim: (turn.stderr ?? '').slice(0, 2000),
    error_event: (turn.errorEventText ?? '').slice(0, 1000),
    stdout_text: (turn.text ?? '').slice(0, 500),
    eventCount: turn.eventCount,
    ms: turn.ms,
  };
  if (outPath) writeJson(outPath, result);
  return result;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const root = repoRoot();
  runE8({ wsDir: `${root}\\design\\experiments\\ws-e7`, outPath: `${root}\\design\\experiments\\e8.json` }).then((r) => {
    console.log(JSON.stringify({ verdict: r.verdict, exitCode: r.exitCode, stderr: r.stderr_verbatim }, null, 2));
  });
}
