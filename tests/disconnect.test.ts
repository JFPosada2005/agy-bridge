import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, type TurnAdapter } from '../src/server';

// Real-socket integration tests for the client-disconnect contract. fastify
// .inject() cannot simulate a mid-stream socket close, so these run against an
// ephemeral listen port and use real fetch AbortControllers (zero agy cost:
// fake adapters only).

let app: ReturnType<typeof buildApp> | null = null;
let port = 0;

const startApp = async (adapter: TurnAdapter): Promise<number> => {
  app = buildApp({ adapter, maxConcurrentTurns: 2 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  return port;
};

afterAll(async () => {
  await app?.close();
  app = null;
});

const streamUrl = (p: number) => `http://127.0.0.1:${p}/v1/chat/completions`;

const payload = (stream: boolean) =>
  JSON.stringify({
    model: 'gemini-3.6-flash-low',
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    stream,
  });

describe('client disconnect (real socket)', () => {
  it('aborts the waiting adapter when the client aborts mid-turn', async () => {
    let sawSignal = false;
    const port2 = await startApp({
      runTurn: (request) =>
        new Promise((resolve) => {
          request.signal?.addEventListener('abort', () => {
            sawSignal = true;
            resolve({ text: '', usage: null });
          });
        }),
    });
    const controller = new AbortController();
    const pending = fetch(streamUrl(port2), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload(true),
      signal: controller.signal,
    }).catch(() => 'aborted');
    // Fetch may complete the request write and return before the turn ends;
    // only interrupt AFTER the body has actually been written and the turn
    // started waiting, then wait for the abort to propagate.
    const sent = new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });
    await sent;
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 150));
    expect(sawSignal).toBe(true);
  });

  it('completes a streaming turn normally on a kept-alive socket (no early abort)', async () => {
    // Regression for the IncomingMessage-close trap: with a persistent
    // connection, request body consumption must NOT abort the turn.
    const port3 = await startApp({
      runTurn: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ text: 'OK', usage: null }), 300);
        }),
    });
    const response = await fetch(streamUrl(port3), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload(true),
    });
    const body = await response.text();
    expect(body).toContain('finish_reason":"stop"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});
