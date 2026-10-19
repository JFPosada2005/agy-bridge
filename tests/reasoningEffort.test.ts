import { describe, expect, it } from 'vitest';
import { buildApp, type TurnAdapter } from '../src/server';

// The bridge serves one model id per family and selects reasoning effort per
// request: the OpenAI `reasoning_effort` field (what OpenCode V2 sends for a
// model variant) or a legacy model-id suffix, which wins when present.

process.env.AGY_WARM_LANE = '0';

type Seen = Array<{ model: string; effort: string | null; prompt: string }>;

function recordingAdapter(seen: Seen): TurnAdapter {
  return {
    runTurn: async (request) => {
      seen.push({ model: request.model, effort: request.effort, prompt: request.prompt });
      return { text: 'OK', usage: null };
    },
  };
}

const messages = [{ role: 'user', content: 'hi' }];

describe('reasoning_effort request selection', () => {
  it('sends the requested effort with the base model id', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.8-flash', reasoning_effort: 'high', messages },
    });
    expect(response.statusCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.model).toBe('gemini-3.8-flash');
    expect(seen[0]?.effort).toBe('high');
    await app.close();
  });

  it('keeps the legacy model suffix authoritative', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.8-flash-low', reasoning_effort: 'high', messages },
    });
    expect(response.statusCode).toBe(200);
    expect(seen[0]?.model).toBe('gemini-3.8-flash');
    expect(seen[0]?.effort).toBe('low');
    await app.close();
  });

  it('uses the model default when no effort is selected', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gpt-oss-120b', messages },
    });
    expect(seen[0]?.effort).toBe('medium');
    await app.close();
  });

  it('leaves effort unset for a family without effort control', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.8-flash', messages },
    });
    expect(seen[0]?.effort).toBeNull();
    await app.close();
  });

  it('rejects an effort the model does not support', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.8-flash', reasoning_effort: 'ultra', messages },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()?.error?.code).toBe('invalid_reasoning_effort');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('rejects reasoning_effort for a model with no effort control', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'claude-sonnet-4-6', reasoning_effort: 'high', messages },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()?.error?.code).toBe('invalid_reasoning_effort');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('rejects a legacy suffix the family does not support', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.1-pro-medium', messages },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()?.error?.code).toBe('invalid_reasoning_effort');
    expect(response.json()?.error?.message).toContain('Supported: low, high.');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('rejects a suffix on a family with no effort control', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'claude-sonnet-4-6-high', messages },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()?.error?.code).toBe('invalid_reasoning_effort');
    expect(seen).toHaveLength(0);
    await app.close();
  });

  it('rejects a non-string reasoning_effort with a clear message', async () => {
    const seen: Seen = [];
    const app = buildApp({ adapter: recordingAdapter(seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'gemini-3.8-flash', reasoning_effort: 3, messages },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()?.error?.code).toBe('invalid_reasoning_effort');
    expect(response.json()?.error?.message).toBe('reasoning_effort must be a string.');
    expect(seen).toHaveLength(0);
    await app.close();
  });
});
