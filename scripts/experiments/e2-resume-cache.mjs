// E2 — RESUME-BY-ID + CACHE CONTINUITY ACROSS PROCESS RESTARTS.
// Turn 1 (fresh process, cwd=ws-e7): store codeword. Turn 2 (NEW process,
// --conversation <id>): recall it. Verdict CORRECT iff T2 names PINEAPPLE77.
// Turn-2 cache_read_tokens/input_tokens = cache-continuity evidence for the
// Option-A-vs-B decision. Turn 1 doubles as E7's workspace-pinning turn.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  MODEL_SLUG,
  budget,
  expectedWorkspaceUri,
  repoRoot,
  runTurn,
  writeJson,
} from './lib-agy.mjs';

export const CODEWORD = 'PINEAPPLE77';

export async function runE2({ wsDir, outPath }) {
  const before = budget.used;
  const t1 = await runTurn({
    label: 'e2-turn1-store',
    cwd: wsDir,
    prompt: 'Remember the codeword PINEAPPLE77. Reply with only: ACK',
  });
  const conversationId = t1.conversationId ?? null;
  let t2 = null;
  if (conversationId) {
    t2 = await runTurn({
      label: 'e2-turn2-recall',
      cwd: wsDir,
      conversationId,
      prompt: 'What codeword did I ask you to remember? Reply with ONLY the codeword.',
    });
  }
  const correct =
    t2 != null && t2.exitCode === 0 && t2.text.includes(CODEWORD);
  const result = {
    experiment: 'E2',
    goal: 'resume-by-id + cache continuity across process restarts (A-vs-B driver)',
    model: MODEL_SLUG,
    effort: 'low',
    cwd: wsDir,
    expected_workspace_uri: expectedWorkspaceUri(wsDir),
    live_requests_used: budget.used - before,
    verdict: conversationId == null ? 'NO_CONVERSATION_ID' : correct ? 'CORRECT' : 'WRONG',
    conversation_id: conversationId,
    turn1: {
      exitCode: t1.exitCode,
      conversationIdFromInit: t1.conversationIdFromInit,
      text: (t1.text ?? '').slice(0, 200),
      usage: t1.usage ?? {},
      ms: t1.ms,
    },
    turn2: t2
      ? {
        exitCode: t2.exitCode,
        text: (t2.text ?? '').slice(0, 200),
        usage: t2.usage ?? {},
        cache_read_tokens: t2.usage?.cache_read_tokens ?? null,
        input_tokens: t2.usage?.input_tokens ?? null,
        ms: t2.ms,
      }
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
  runE2({ wsDir, outPath: `${root}\\design\\experiments\\e2.json` }).then((r) => {
    console.log(JSON.stringify({ verdict: r.verdict, live_requests_used: r.live_requests_used, conversation_id: r.conversation_id, turn2_usage: r.turn2?.usage ?? null }, null, 2));
  });
}
