// E7 — WORKSPACE SCOPING. Given a conversation created with cwd=ws-e7,
// verify its workspace_uris pin equals that dir (read-only DB evidence),
// then resume from the SAME cwd with a trivial turn to confirm resumption
// works with pinned cwd. Reuses E2 turn-1's conversation (no extra bootstrap).
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MODEL_SLUG,
  budget,
  expectedWorkspaceUri,
  readSummaryWithRetry,
  repoRoot,
  runTurn,
  writeJson,
} from './lib-agy.mjs';
import { runE2 } from './e2-resume-cache.mjs';

export async function runE7({ wsDir, outPath, conversationId = null }) {
  const before = budget.used;
  let e2Result = null;
  let convId = conversationId;
  if (!convId) {
    e2Result = await runE2({ wsDir, outPath: null });
    convId = e2Result.conversation_id;
  }
  let summary = null;
  let resume = null;
  let uriMatch = false;
  if (convId) {
    summary = await readSummaryWithRetry(convId);
    const expected = expectedWorkspaceUri(wsDir);
    const uris = summary?.workspace_uris;
    uriMatch = Array.isArray(uris) && uris.length === 1 && uris[0] === expected;
    resume = await runTurn({ label: 'e7-resume-ack2', cwd: wsDir, conversationId: convId, prompt: 'Reply with only: ACK2' });
  }
  const resumable = resume != null && resume.exitCode === 0 && resume.text.includes('ACK2');
  const result = {
    experiment: 'E7',
    goal: 'workspace scoping: spawn-cwd pin + resume from pinned cwd',
    model: MODEL_SLUG,
    effort: 'low',
    cwd: wsDir,
    expected_workspace_uri: expectedWorkspaceUri(wsDir),
    live_requests_used: budget.used - before,
    verdict: convId == null ? 'NO_CONVERSATION_ID' : uriMatch && resumable ? 'PINNED_AND_RESUMABLE' : 'MISMATCH',
    conversation_id: convId,
    workspace_uris: summary?.workspace_uris ?? null,
    workspace_uri_match: uriMatch,
    summary_status: summary?.status ?? null,
    summary_flags: summary ? { not_fully_idle: summary.not_fully_idle, killed: summary.killed } : null,
    resume_turn: resume
      ? { exitCode: resume.exitCode, text: (resume.text ?? '').slice(0, 200), usage: resume.usage ?? {} }
      : null,
  };
  if (outPath) writeJson(outPath, result);
  return result;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const root = repoRoot();
  const wsDir = `${root}\\design\\experiments\\ws-e7`;
  mkdirSync(wsDir, { recursive: true });
  runE7({ wsDir, outPath: `${root}\\design\\experiments\\e7.json` }).then((r) => {
    console.log(JSON.stringify({ verdict: r.verdict, live_requests_used: r.live_requests_used, workspace_uris: r.workspace_uris }, null, 2));
  });
}
