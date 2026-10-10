// Session-mode smoke: daemon restart over local HTTP + in-process session
// path with a FAKE adapter. Zero live agy turns (healthz/echo only on the
// daemon; buildApp fake adapter in-process).
// Usage: `node scripts/session-smoke.mjs` (run `npm run build` first).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../dist/server.js';

const failures = [];
function check(name, ok, detail = '') {
  console.log(`${name}: ${ok ? 'OK' : 'FAIL'}${detail ? ` (${detail})` : ''}`);
  if (!ok) {
    failures.push(name);
  }
}

const home = mkdtempSync(join(tmpdir(), 'agy-bridge-session-smoke-'));
const port = 41679;

// --- Part A: real daemon restart, local HTTP only ---
const daemon = spawn(process.execPath, ['dist/index.js'], {
  env: {
    ...process.env,
    AGY_BRIDGE_PORT: String(port),
    AGY_BRIDGE_HOME: home,
    AGY_BRIDGE_LOG: join(home, 'bridge.log'),
    AGY_SESSION_MODE: '1',
    AGY_BRIDGE_DEBUG: '1',
  },
  stdio: 'ignore',
});

async function waitForHealthz() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        return true;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

try {
  check('daemon restart (healthz)', await waitForHealthz());

  // The daemon creates the install token on start (security audit 2026-10-09).
  const token = readFileSync(join(home, 'token'), 'utf8').trim();
  const echo = await fetch(`http://127.0.0.1:${port}/v1/__debug/echo`, {
    headers: {
      'x-agy-token': token,
      'x-agy-session-id': 'ses-smoke',
      'x-agy-agent': 'build',
      'x-agy-message-id': 'm1',
      'x-agy-parent-session-id': 'ses-parent',
      'x-agy-client-instance': 'smoke',
    },
  });
  const echoBody = await echo.json();
  check(
    'echo returns identity headers',
    echo.status === 200 && echoBody.headers?.['x-agy-session-id'] === 'ses-smoke',
    `status=${echo.status}`,
  );
} finally {
  daemon.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
}

// --- Part B: session path with a fake adapter (zero agy) ---
process.env.AGY_BRIDGE_HOME = home;
process.env.AGY_SESSION_MODE = '1';
// Warm lanes are default ON and would spawn the REAL agy for session turns
// (plan quota) instead of the fake adapter; this smoke promises zero agy.
process.env.AGY_WARM_LANE = '0';

let turns = 0;
const seenPrompts = [];
const app = buildApp({
  adapter: {
    runTurn: (request) => {
      turns += 1;
      seenPrompts.push(request.prompt);
      return Promise.resolve({ text: 'smoke answer', usage: null, conversationId: 'conv-smoke-1' });
    },
  },
});

const headers = {
  'x-agy-session-id': 'ses-smoke',
  'x-agy-agent': 'build',
  'x-agy-message-id': 'm1',
};
const messages = [{ role: 'user', content: 'smoke question' }];

const first = await app.inject({
  method: 'POST',
  url: '/v1/chat/completions',
  headers,
  payload: { model: 'gemini-3.6-flash-low', messages },
});
check('bootstrap turn', first.statusCode === 200, `status=${first.statusCode}`);

const recordFile = join(home, 'sessions', 'ses-smoke.json');
check('registry file created', existsSync(recordFile));
if (existsSync(recordFile)) {
  const record = JSON.parse(readFileSync(recordFile, 'utf8'));
  check('ledger advanced + convId persisted', record.branches?.[0]?.ledger?.length === 1
    && record.branches?.[0]?.agyConversationID === 'conv-smoke-1');
}

const retry = await app.inject({
  method: 'POST',
  url: '/v1/chat/completions',
  headers,
  payload: { model: 'gemini-3.6-flash-low', messages },
});
check('identical retry replays without re-invoking adapter', retry.statusCode === 200 && turns === 1, `turns=${turns}`);

const followUp = await app.inject({
  method: 'POST',
  url: '/v1/chat/completions',
  headers,
  payload: {
    model: 'gemini-3.6-flash-low',
    messages: [...messages, { role: 'assistant', content: 'smoke answer' }, { role: 'user', content: 'second' }],
  },
});
check('delta follow-up', followUp.statusCode === 200 && turns === 2, `turns=${turns}`);
check('delta prompt carries session header', (seenPrompts[1] ?? '').includes('[agy-bridge session: ses-smoke'));

await app.close();
rmSync(home, { recursive: true, force: true });

if (failures.length > 0) {
  throw new Error(`session-smoke FAILED: ${failures.join(', ')}`);
}
console.log('session-smoke: OK');
