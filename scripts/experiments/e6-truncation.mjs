// E6 — PER-MESSAGE TRUNCATION INSIDE A CONVERSATION. One turn: ~45K-token
// filler + tail line 'END-INSTRUCTION: reply with only: TAIL-OK'. Records
// usage.input_tokens and whether the tail was honored → quantifies the
// in-conversation per-message cap (vs ~32K measured statelessly).
import { fileURLToPath } from 'node:url';
import { MODEL_SLUG, budget, repoRoot, runTurn, writeJson } from './lib-agy.mjs';

const FILLER_REPS = 6000; // 'budget boundary filler words. ' ~= 31 chars -> ~186KB ~= ~45K tokens
const FILLER = 'budget boundary filler words. ';

export async function runE6({ wsDir, outPath }) {
  const before = budget.used;
  const filler = FILLER.repeat(FILLER_REPS);
  const prompt = `${filler}\nEND-INSTRUCTION: reply with only: TAIL-OK\n`;
  const promptChars = prompt.length;
  const turn = await runTurn({
    label: 'e6-filler-tail',
    cwd: wsDir,
    timeoutMs: 300000,
    prompt,
  });
  let verdict;
  let followUp = null;
  if (turn.exitCode === 0 && turn.text.length > 0) {
    verdict = turn.text.includes('TAIL-OK') ? 'TAIL_HONORED' : 'TAIL_LOST';
  } else {
    // Ambiguous (crash/empty): ONE follow-up turn max to disambiguate.
    followUp = await runTurn({
      label: 'e6-followup',
      cwd: wsDir,
      conversationId: turn.conversationId,
      prompt: 'Reply with only TAIL-OK if you saw the END-INSTRUCTION line; otherwise reply SAW-NO-TAIL.',
    });
    verdict =
      followUp.exitCode === 0 && followUp.text.includes('TAIL-OK')
        ? 'TAIL_HONORED_LATE'
        : 'INCONCLUSIVE';
  }
  const result = {
    experiment: 'E6',
    goal: 'per-message truncation limit inside an existing conversation (chunk sizing)',
    model: MODEL_SLUG,
    effort: 'low',
    live_requests_used: budget.used - before,
    verdict,
    prompt_chars: promptChars,
    prompt_bytes: Buffer.byteLength(prompt, 'utf8'),
    filler_reps: FILLER_REPS,
    prompt_tokens_estimate_chars_div_4: Math.round(promptChars / 4),
    turn: {
      exitCode: turn.exitCode,
      conversationId: turn.conversationId,
      text: (turn.text ?? '').slice(0, 300),
      usage: turn.usage ?? {},
      input_tokens: turn.usage?.input_tokens ?? null,
      cache_read_tokens: turn.usage?.cache_read_tokens ?? null,
      output_tokens: turn.usage?.output_tokens ?? null,
      ms: turn.ms,
    },
    follow_up: followUp
      ? { exitCode: followUp.exitCode, text: (followUp.text ?? '').slice(0, 200), usage: followUp.usage ?? {} }
      : null,
  };
  if (outPath) writeJson(outPath, result);
  return result;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const root = repoRoot();
  runE6({ wsDir: `${root}\\design\\experiments\\ws-e7`, outPath: `${root}\\design\\experiments\\e6.json` }).then((r) => {
    console.log(JSON.stringify({ verdict: r.verdict, live_requests_used: r.live_requests_used, input_tokens: r.turn.input_tokens, response: r.turn.text }, null, 2));
  });
}
