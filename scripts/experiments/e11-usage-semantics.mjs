// E11: usage semantics — is agy's reported input_tokens per-turn or
// session-cumulative? Decisive experiment for the phantom 1.3M-token report
// observed live (user chat ~100K tokens, bridge reported prompt=1305129).
// Protocol: 3 consecutive turns re-sending the SAME filler (~9K tokens).
//   per-turn semantics  -> turn3.input ~= turn2.input (stable, cache grows)
//   cumulative semantics -> turn3.input keeps growing toward 3x filler
// Invariant respected: official agy binary only, no --continue,
// no --dangerously-skip-permissions. Prompt travels on stdin.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { budget, runTurn, writeJson, repoRoot } from './lib-agy.mjs';

const root = repoRoot();
const wsE11 = join(root, 'design', 'experiments', 'ws-e11');
mkdirSync(wsE11, { recursive: true });

// ~9K tokens of deterministic filler: 400 lines x ~90 chars.
const filler = Array.from({ length: 400 }, (_, i) =>
  `Line ${String(i).padStart(4, '0')}: The quick brown fox jumps over the lazy dog. ` +
  `0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ.`).join('\n');
const ask = (n) =>
  `\n\nIGNORE ALL FILLER ABOVE COMPLETELY. It is padding only. ` +
  `Reply with exactly this word and nothing else: READY${n}\n`;
const prompt = (n) => filler + ask(n);

const result = {
  experiment: 'E11',
  goal: 'usage semantics: per-turn vs session-cumulative input_tokens',
  model_base: process.env.AGY_EXP_MODEL_BASE ?? 'gemini-3.6-flash',
  model_slug: process.env.AGY_EXP_MODEL ?? 'gemini-3.6-flash-low',
  effort: 'low',
  cwd: wsE11,
  filler_lines: 400,
  filler_chars: filler.length,
  turns: [],
  verdict: 'UNKNOWN',
};

async function main() {
  let conversationId = null;
  for (let i = 1; i <= 3; i += 1) {
    const t = await runTurn({
      prompt: prompt(i),
      effort: result.effort,
      conversationId,
      cwd: wsE11,
      timeoutMs: 240000,
      label: `turn${i}`,
    });
    if (t.conversationIdFromInit) conversationId = t.conversationIdFromInit;
    result.turns.push({
      label: t.label,
      exitCode: t.exitCode,
      conversationId: t.conversationId,
      text: (t.text ?? '').slice(0, 60),
      usage: t.usage,
      usageSightings: t.usageSightings?.slice(-4) ?? [],
      eventCount: t.eventCount,
      ms: t.ms,
      stderr: (t.stderr ?? '').slice(0, 500),
    });
  }

  const u = result.turns.map((t) => t.usage);
  const i2 = u[1]?.input_tokens ?? null;
  const i3 = u[2]?.input_tokens ?? null;
  const i1 = u[0]?.input_tokens ?? null;
  const okShape = i1 !== null && i2 !== null && i3 !== null;
  if (!okShape) {
    result.verdict = 'INCOMPLETE';
  } else {
    const growth2 = i2 - i1;
    const growth3 = i3 - i2;
    // per-turn: growth3 ~= 0 (same content re-sent). cumulative: growth3 ~= filler.
    result.analysis = {
      input_turn1: i1,
      input_turn2: i2,
      input_turn3: i3,
      growth_turn2_minus_turn1: growth2,
      growth_turn3_minus_turn2: growth3,
      expected_filler_tokens_approx: 9000,
    };
    if (Math.abs(growth3) <= 1500) {
      result.verdict = 'PER_TURN';
    } else if (growth3 >= 4000) {
      result.verdict = 'CUMULATIVE';
    } else {
      result.verdict = 'AMBIGUOUS';
    }
  }
  result.budgetUsed = budget.used;
  writeJson(join(root, 'design', 'experiments', 'e11.json'), result);
  console.log(JSON.stringify({ verdict: result.verdict, analysis: result.analysis ?? null }, null, 2));
}

main().catch((err) => {
  result.error = String(err?.stack ?? err);
  result.budgetUsed = budget.used;
  writeJson(join(root, 'design', 'experiments', 'e11.json'), result);
  console.error(result.error);
  process.exitCode = 1;
});
