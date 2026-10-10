// One-shot live probe of the streaming path (SSE) through the running bridge.
// Usage: node scripts/probe-stream.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Install token (security audit 2026-10-09): env AGY_BRIDGE_TOKEN or <home>/token.
const token =
  process.env.AGY_BRIDGE_TOKEN?.trim() ||
  readFileSync(join(process.env.AGY_BRIDGE_HOME?.trim() || join(homedir(), '.agy-bridge'), 'token'), 'utf8').trim();
const body = {
  model: 'gemini-3.6-flash-low',
  stream: true,
  messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
};
const t0 = Date.now();
const res = await fetch('http://127.0.0.1:41667/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-agy-token': token },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log('status:', res.status);
console.log('has content chunk:', text.includes('"content"'));
console.log('finish stop:', text.includes('"finish_reason":"stop"'));
console.log('[DONE]:', text.includes('[DONE]'));
console.log('ms:', Date.now() - t0);
