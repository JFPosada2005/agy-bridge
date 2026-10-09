// Runner: E2(+E7 sharing E2 turn-1) -> E5 -> E6 -> E8, in sequence.
// Enforces the STRICT budget: max 8 real agy turns TOTAL (spawn-counted in
// lib-agy.mjs). Prints a FINAL SUMMARY table: experiment | verdict |
// live requests used | key numbers. Writes design/experiments/e<N>.json.
import { mkdirSync } from 'node:fs';
import { budget, repoRoot } from './lib-agy.mjs';
import { runE2 } from './e2-resume-cache.mjs';
import { runE7 } from './e7-workspace.mjs';
import { runE5 } from './e5-kill-recovery.mjs';
import { runE6 } from './e6-truncation.mjs';
import { runE8 } from './e8-unknown-id.mjs';
import { writeJson } from './lib-agy.mjs';

const root = repoRoot();
const wsDir = `${root}\\design\\experiments\\ws-e7`;
const expDir = `${root}\\design\\experiments`;
mkdirSync(wsDir, { recursive: true });
mkdirSync(expDir, { recursive: true });

// Planned costs: E2=2, E7=+1 (shares E2 conv), E5=2, E6=1(+1 spare), E8=1 -> 7 total.
const plan = [
  { id: 'E2', cost: 2 },
  { id: 'E7', cost: 1 },
  { id: 'E5', cost: 2 },
  { id: 'E6', cost: 2 }, // 1 + 1 spare follow-up
  { id: 'E8', cost: 1 },
];

const results = {};
let e2Conv = null;

for (const step of plan) {
  if (budget.used + step.cost > budget.max) {
    results[step.id] = { experiment: step.id, verdict: 'SKIPPED_BUDGET', live_requests_used: 0 };
    console.log(`[run-all] SKIP ${step.id}: budget ${budget.used}/${budget.max} + cost ${step.cost} would exceed max`);
    continue;
  }
  if (step.id === 'E2') {
    const r = await runE2({ wsDir, outPath: `${expDir}\\e2.json` });
    results.E2 = r;
    e2Conv = r.conversation_id;
  } else if (step.id === 'E7') {
    const r = await runE7({ wsDir, outPath: `${expDir}\\e7.json`, conversationId: e2Conv });
    results.E7 = r;
  } else if (step.id === 'E5') {
    results.E5 = await runE5({ wsDir, outPath: `${expDir}\\e5.json` });
  } else if (step.id === 'E6') {
    results.E6 = await runE6({ wsDir, outPath: `${expDir}\\e6.json` });
  } else if (step.id === 'E8') {
    results.E8 = await runE8({ wsDir, outPath: `${expDir}\\e8.json` });
  }
  console.log(`[run-all] ${step.id}: verdict=${results[step.id].verdict} live=${results[step.id].live_requests_used} budget=${budget.used}/${budget.max}`);
}

const keyNumbers = (id) => {
  const r = results[id] ?? {};
  if (id === 'E2') return `t2 cache_read=${r.turn2?.cache_read_tokens ?? '?'} input=${r.turn2?.input_tokens ?? '?'}`;
  if (id === 'E7') return `uri_match=${r.workspace_uri_match ?? '?'} uris=${JSON.stringify(r.workspace_uris ?? null)}`;
  if (id === 'E5') return `flags=${JSON.stringify(r.pre_resume_summary ?? null)}`;
  if (id === 'E6') return `input_tokens=${r.turn?.input_tokens ?? '?'} prompt_est~${r.prompt_tokens_estimate_chars_div_4 ?? '?'}`;
  if (id === 'E8') return `exit=${r.exitCode ?? '?'}`;
  return '';
};

console.log('');
console.log('FINAL SUMMARY');
console.log('experiment | verdict | live requests used | key numbers');
for (const step of plan) {
  const r = results[step.id] ?? {};
  console.log(`${step.id} | ${r.verdict ?? '?'} | ${r.live_requests_used ?? '?'} | ${keyNumbers(step.id)}`);
}
console.log(`TOTAL live requests: ${budget.used}/${budget.max}`);

writeJson(`${expDir}\\run-summary.json`, {
  budget_used: budget.used,
  budget_max: budget.max,
  experiments: Object.fromEntries(
    Object.entries(results).map(([k, r]) => [k, { verdict: r.verdict, live_requests_used: r.live_requests_used, key_numbers: keyNumbers(k) }]),
  ),
});
