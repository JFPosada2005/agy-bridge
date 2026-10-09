// E5 — KILLED-MID-TURN RECOVERY. Spawn effort=high + 2000-word essay prompt,
// kill the process tree ~4s in (taskkill /T /F), then resume by id in a NEW
// process and ask for a one-sentence summary of the interruption. Verdict on
// resumability after kill + status flags (not_fully_idle/killed) as evidence.
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { MODEL_SLUG, budget, readSummaryWithRetry, repoRoot, runTurn, writeJson } from './lib-agy.mjs';

// NOTE: the task's "~4s" kill fires during cold spawn (~20-25s MCP init), i.e.
// pre-init: no conversation exists yet, nothing to resume. That 4s attempt is
// preserved as prior_attempts evidence; the meaningful mid-turn kill needs a
// longer delay (default 35s: init seen, generation in flight).
export async function runE5({ wsDir, outPath, killAfterMs = 35000 }) {
  const before = budget.used;
  const killed = await runTurn({
    label: 'e5-kill-mid-turn',
    cwd: wsDir,
    effort: 'high',
    killAfterMs,
    timeoutMs: 180000,
    prompt: 'Write a 2000-word essay about the history of computing',
  });
  const conversationId = killed.conversationId ?? null;
  const preSummary = conversationId ? await readSummaryWithRetry(conversationId) : null;
  let resume = null;
  if (conversationId) {
    resume = await runTurn({
      label: 'e5-resume-after-kill',
      cwd: wsDir,
      conversationId,
      prompt: 'Summarize what I last asked you and whether you were interrupted. Reply in one sentence.',
    });
  }
  const resumed =
    resume != null &&
    resume.exitCode === 0 &&
    resume.text.length > 0 &&
    /essay|comput|interrupt|kill|stop/i.test(resume.text);
  const result = {
    experiment: 'E5',
    goal: 'killed-mid-turn recovery (dirty-recovery path)',
    model: MODEL_SLUG,
    kill_after_ms: killAfterMs,
    effort_kill_turn: 'high',
    effort_resume_turn: 'low',
    live_requests_used: budget.used - before,
    verdict: conversationId == null ? 'NO_CONVERSATION_ID' : resumed ? 'RESUMED' : 'FAILED',
    conversation_id: conversationId,
    kill_turn: {
      exitCode: killed.exitCode,
      killedByUs: killed.killedByUs,
      textLength: killed.textLength,
      eventCount: killed.eventCount,
      usage: killed.usage ?? {},
      ms: killed.ms,
    },
    pre_resume_summary: preSummary
      ? {
        status: preSummary.status,
        not_fully_idle: preSummary.not_fully_idle,
        killed: preSummary.killed,
        step_count: preSummary.step_count,
      }
      : null,
    resume_turn: resume
      ? {
        exitCode: resume.exitCode,
        text: (resume.text ?? '').slice(0, 500),
        usage: resume.usage ?? {},
        cache_read_tokens: resume.usage?.cache_read_tokens ?? null,
        ms: resume.ms,
      }
      : null,
  };
  if (outPath) {
    // Preserve the 4s pre-init kill attempt as prior_attempts evidence.
    try {
      if (existsSync(outPath)) {
        const prior = JSON.parse(readFileSync(outPath, 'utf8'));
        if (prior?.experiment === 'E5' && prior.kill_after_ms !== killAfterMs) {
          result.prior_attempts = [...(prior.prior_attempts ?? []), {
            kill_after_ms: prior.kill_after_ms ?? 4000,
            verdict: prior.verdict,
            kill_turn: prior.kill_turn ?? null,
            note: 'kill fired during cold spawn (pre-init): no conversation existed, nothing to resume',
          }];
        }
      }
    } catch { /* prior file unreadable: overwrite */ }
    writeJson(outPath, result);
  }
  return result;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const root = repoRoot();
  runE5({ wsDir: `${root}\\design\\experiments\\ws-e7`, outPath: `${root}\\design\\experiments\\e5.json` }).then((r) => {
    console.log(JSON.stringify({ verdict: r.verdict, live_requests_used: r.live_requests_used, resume_text: r.resume_turn?.text ?? null }, null, 2));
  });
}
