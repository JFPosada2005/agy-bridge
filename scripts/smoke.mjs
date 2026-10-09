// Smoke test against a running bridge: models listing plus ONE real agy turn
// (non-stream AND stream) with model gemini-3.6-flash-low.
// Usage: start the server first, then `npm run smoke`.
// This consumes plan requests on the user's agy account (authorized, ~2 turns).
// Env: AGY_BRIDGE_URL (default http://127.0.0.1:41667).

const base = process.env.AGY_BRIDGE_URL ?? 'http://127.0.0.1:41667';
const MODEL = 'gemini-3.6-flash-low';
const PROMPT = 'Reply with the single word: OK';

async function getJson(path) {
  const res = await fetch(`${base}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function postTurn(stream) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: PROMPT }],
      stream,
    }),
  });
  if (!stream) {
    const body = await res.json();
    if (!res.ok) {
      throw new Error(`POST non-stream -> ${res.status}: ${JSON.stringify(body)}`);
    }
    return body;
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST stream -> ${res.status}: ${text}`);
  }
  return text;
}

function parseSse(raw) {
  const deltas = [];
  let finishReason = null;
  let done = false;
  for (const frame of raw.split('\n\n')) {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const data = trimmed.slice('data:'.length).trim();
      if (data === '[DONE]') {
        done = true;
        continue;
      }
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      const choice = event?.choices?.[0];
      if (typeof choice?.delta?.content === 'string') {
        deltas.push(choice.delta.content);
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }
  }
  return { text: deltas.join(''), finishReason, done };
}

const models = await getJson('/v1/models');
const ids = models.data.map((entry) => entry.id);
console.log(`models: ${ids.length} entries; has ${MODEL}: ${ids.includes(MODEL)}`);

const plain = await postTurn(false);
console.log(`non-stream content: ${JSON.stringify(plain.choices?.[0]?.message?.content)}`);
console.log(`non-stream usage: ${JSON.stringify(plain.usage)}`);

const rawSse = await postTurn(true);
const parsed = parseSse(rawSse);
console.log(`stream assembled: ${JSON.stringify(parsed.text)}`);
console.log(`stream finish_reason=${parsed.finishReason} done=${parsed.done}`);

if (!parsed.done || parsed.finishReason !== 'stop') {
  throw new Error('stream did not terminate correctly');
}
console.log('smoke: OK');
