// Tool-call smoke against a LOCAL buildApp with a FAKE adapter (no agy at all).
// Zero plan cost: nothing spawns the agy binary.
// Usage: `node scripts/tool-smoke.mjs` (run `npm run build` first).

import { buildApp } from '../dist/server.js';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
];

function fakeAdapter(text) {
  return {
    runTurn: (request) => {
      if (!request.prompt.includes('### read_file')) {
        throw new Error('manifest missing from prompt sent to the model');
      }
      return Promise.resolve({ text, usage: null });
    },
  };
}

async function post(app, body) {
  const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: body });
  return { status: res.statusCode, body: res.json(), raw: res.body };
}

const failures = [];

// 1. Tool candidate -> tool_calls + finish_reason tool_calls.
{
  const app = buildApp({
    adapter: fakeAdapter('TOOL_CALL: {"name": "read_file", "arguments": {"path": "a.txt"}}'),
  });
  const { status, body } = await post(app, {
    model: 'gemini-3.6-flash-low',
    messages: [{ role: 'user', content: 'read a.txt' }],
    tools: TOOLS,
  });
  const choice = body?.choices?.[0];
  const ok =
    status === 200 &&
    choice?.finish_reason === 'tool_calls' &&
    choice?.message?.tool_calls?.[0]?.function?.name === 'read_file';
  console.log(`non-stream tool_calls: status=${status} finish=${choice?.finish_reason} fn=${choice?.message?.tool_calls?.[0]?.function?.name} -> ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) {
    failures.push('non-stream tool_calls');
  }
  await app.close();
}

// 2. Plain answer in tools mode -> content + stop.
{
  const app = buildApp({ adapter: fakeAdapter('Just chatting.') });
  const { status, body } = await post(app, {
    model: 'gemini-3.6-flash-low',
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
  });
  const choice = body?.choices?.[0];
  const ok = status === 200 && choice?.finish_reason === 'stop' && choice?.message?.content === 'Just chatting.';
  console.log(`non-stream content: status=${status} finish=${choice?.finish_reason} -> ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) {
    failures.push('non-stream content');
  }
  await app.close();
}

// 3. Stream tool candidate -> tool_calls chunk, no content, [DONE].
{
  const app = buildApp({
    adapter: fakeAdapter('TOOL_CALL: {"name": "read_file", "arguments": {}}'),
  });
  const res = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    payload: {
      model: 'gemini-3.6-flash-low',
      messages: [{ role: 'user', content: 'read it' }],
      tools: TOOLS,
      stream: true,
    },
  });
  const raw = res.body;
  const ok =
    res.statusCode === 200 &&
    raw.includes('"tool_calls"') &&
    raw.includes('"finish_reason":"tool_calls"') &&
    !raw.includes('"content"') &&
    raw.trimEnd().endsWith('data: [DONE]');
  console.log(`stream tool_calls: status=${res.statusCode} -> ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) {
    failures.push('stream tool_calls');
  }
  await app.close();
}

if (failures.length > 0) {
  throw new Error(`tool-smoke FAILED: ${failures.join(', ')}`);
}
console.log('tool-smoke: OK');
