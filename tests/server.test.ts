import { describe, expect, it } from 'vitest';
import {
  AgyBinaryMissingError,
  AgyExitError,
  type AgyUsage,
} from '../src/agy';
import {
  applyToolDescriptionNudge,
  buildApp,
  deltaProtocolReminder,
  flattenMessages,
  parseToolDefinitions,
  type TurnAdapter,
} from '../src/server';

function promptText(p: { messages: Array<{ role: string; content: string }> }): string {
  return p.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
}

function stubAdapter(
  behavior: (request: { model: string }) => Promise<{ text: string; usage: AgyUsage | null }>,
): TurnAdapter {
  return {
    runTurn: (request, onDelta) =>
      behavior(request).then((result) => {
        // Replay deltas like the live adapter does.
        onDelta?.('O');
        onDelta?.('K');
        return result;
      }),
  };
}

describe('GET /v1/models', () => {
  it('serves the OpenAI-shaped catalog listing', async () => {
    const app = buildApp({ adapter: stubAdapter(async () => ({ text: '', usage: null })) });
    const response = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { object: string; data: Array<{ id: string; object: string }> };
    expect(body.object).toBe('list');
    expect(body.data.map((entry) => entry.id)).toContain('gemini-3.6-flash');
    await app.close();
  });
});

describe('GET /healthz', () => {
  it('reports status without crashing', async () => {
    const app = buildApp({ adapter: stubAdapter(async () => ({ text: '', usage: null })) });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });

  it('exposes build-id handshake fields for stale-daemon detection (T12)', async () => {
    const app = buildApp({ adapter: stubAdapter(async () => ({ text: '', usage: null })) });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    const body = response.json() as { buildId: string; pid: number; inflight: number };
    expect(typeof body.buildId).toBe('string');
    expect(body.buildId.length).toBeGreaterThan(0);
    expect(typeof body.pid).toBe('number');
    expect(body.inflight).toBe(0);
    await app.close();
  });
});

describe('POST /v1/chat/completions (non-stream)', () => {
  const payload = {
    model: 'gemini-3.6-flash-low',
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
  };

  it('returns the standard completion object with usage', async () => {
    const app = buildApp({
      adapter: stubAdapter(async () => ({
        text: 'OK',
        usage: { inputTokens: 12, outputTokens: 2, totalTokens: 15, thinkingTokens: 3 },
      })),
    });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: Record<string, number>;
    };
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('OK');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage.thinking_tokens).toBe(3);
    await app.close();
  });

  it('maps a missing agy binary to 503 with an actionable message', async () => {
    const app = buildApp({
      adapter: {
        runTurn: () => Promise.reject(new AgyBinaryMissingError('C:\\missing\\agy.exe')),
      },
    });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    expect(response.statusCode).toBe(503);
    expect(String(response.json()?.error?.message)).toContain('AGY_BIN');
    await app.close();
  });

  it('maps agy failures to 502 with the agy error verbatim', async () => {
    const verbatim = 'agy says: quota exhausted (verbatim)';
    const app = buildApp({
      adapter: {
        runTurn: () => Promise.reject(new AgyExitError(verbatim, 1, verbatim)),
      },
    });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    expect(response.statusCode).toBe(502);
    expect(response.json()?.error?.message).toContain(verbatim);
    await app.close();
  });

  it('maps tool denials to 400 so the SDK does not retry with real agy spawns', async () => {
    const { AgyToolDeniedError } = await import('../src/agy');
    const app = buildApp({
      adapter: {
        runTurn: () => Promise.reject(new AgyToolDeniedError(['CallMcpTool'])),
      },
    });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('agy_tool_denied');
    expect(body.error.message).toContain('CallMcpTool');
    await app.close();
  });

  it('tool-denied legacy turn retries ONCE with a redirect correction, then 400 again if still denied', async () => {
    const { AgyToolDeniedError } = await import('../src/agy');
    const prompts: string[] = [];
    let calls = 0;
    const app = buildApp({
      adapter: {
        runTurn: (request) => {
          calls += 1;
          prompts.push(request.prompt);
          if (calls === 1) {
            return Promise.reject(new AgyToolDeniedError(['CallMcpTool']));
          }
          return Promise.reject(new AgyToolDeniedError(['CallBrowserTool']));
        },
      },
    });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    expect(calls).toBe(2); // original + exactly ONE corrective retry
    expect(response.statusCode).toBe(400);
    expect(prompts[1]).toContain('CORRECTION');
    expect(prompts[1]).toContain('CallMcpTool'); // names the denied actions
    expect(prompts[1]).toContain(promptText(payload)); // full original prompt re-sent (legacy stateless)
    await app.close();
  });

  it('tool-denied legacy turn recovers when the correction makes the model answer in text', async () => {
    const { AgyToolDeniedError } = await import('../src/agy');
    let calls = 0;
    const app = buildApp({
      adapter: {
        runTurn: (request) => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(new AgyToolDeniedError(['CallMcpTool']));
          }
          expect(request.prompt).toContain('CORRECTION');
          return Promise.resolve({ text: 'Recovered answer without tools.', usage: null });
        },
      },
    });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0].message.content).toBe('Recovered answer without tools.');
    await app.close();
  });

  it('tool-denied turn with client tools redirects to the TOOL_CALL marker (no plain-text fallback first)', async () => {
    const { AgyToolDeniedError } = await import('../src/agy');
    let calls = 0;
    const app = buildApp({
      adapter: {
        runTurn: (request) => {
          calls += 1;
          if (calls === 1) {
            return Promise.reject(new AgyToolDeniedError(['CallMcpTool']));
          }
          expect(request.prompt).toContain('TOOL_CALL: {"name"');
          expect(request.prompt).toContain('from your manifest');
          expect(request.prompt).toContain('answer the request in plain text');
          return Promise.resolve({ text: 'TOOL_CALL: {"name":"read_file","arguments":{}}', usage: null });
        },
      },
    });
    const payloadWithTools = {
      ...payload,
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'reads a file', parameters: { type: 'object', properties: {} } },
        },
      ],
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: payloadWithTools,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: Array<{ message: { tool_calls?: unknown[] }; finish_reason: string }>;
    };
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls).toHaveLength(1);
    await app.close();
  });

  it('rejects unknown models with 404', async () => {
    const app = buildApp({ adapter: stubAdapter(async () => ({ text: '', usage: null })) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...payload, model: 'nope-9000' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('exposes telemetry counters with a fresh-app shape (T17)', async () => {
    const app = buildApp({
      adapter: stubAdapter(async () => ({
        text: 'OK',
        usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 },
      })),
    });
    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload });
    const stats = await app.inject({ method: 'GET', url: '/v1/__debug/stats' });
    expect(stats.statusCode).toBe(200);
    const body = stats.json() as {
      turns: number;
      byPath: Record<string, number>;
      cacheHits: number;
      errors: number;
      registry: Record<string, number>;
      uptimeSec: number;
    };
    expect(body.turns).toBe(1);
    expect(body.byPath.legacy).toBe(1); // no session headers
    expect(body.cacheHits).toBe(1); // cacheReadTokens 5 > 0
    expect(body.errors).toBe(0);
    expect(typeof body.registry.sessions).toBe('number');
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
    await app.close();
  });
});

describe('POST /v1/chat/completions (stream)', () => {
  it('emits role delta, content deltas, final chunk and [DONE]', async () => {
    const app = buildApp({
      adapter: stubAdapter(async () => ({ text: 'OK', usage: null })),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gemini-3.6-flash-low',
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
        stream: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const body = response.body;
    expect(body).toContain('"role":"assistant"');
    expect(body).toContain('"content":"O"');
    expect(body).toContain('"content":"K"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await app.close();
  });

  const toolPayload = (messages: unknown[]) => ({
    model: 'gemini-3.6-flash-low',
    messages,
    stream: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'reads a file',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  });

  function lineStreamingAdapter(
    chunks: string[],
    finalText: string,
  ): TurnAdapter {
    return {
      runTurn: (request, onDelta) => {
        for (const chunk of chunks) {
          onDelta?.(chunk);
        }
        return Promise.resolve({ text: finalText, usage: null });
      },
    };
  }

  it('tools mode streams content per line instead of buffering (T10)', async () => {
    const app = buildApp({
      adapter: lineStreamingAdapter(
        ['Line one\n', 'Line two\n', 'DONE'],
        'Line one\nLine two\nDONE',
      ),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'explain' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    // Per-line streaming: each completed line streams as its own content.
    expect(body).toContain('"content":"Line one\\n"');
    expect(body).toContain('"content":"Line two\\n"');
    // The in-progress final line flushes at turn end (no full-text duplicate).
    expect(body).toContain('"content":"DONE"');
    expect(body.match(/"content":"DONE"/g)).toHaveLength(1);
    expect(body).toContain('"finish_reason":"stop"');
    await app.close();
  });

  it('tools mode suppresses the marker line from content and relays tool_calls', async () => {
    const marker = 'TOOL_CALL: {"name":"read_file","arguments":{}}';
    const app = buildApp({
      adapter: lineStreamingAdapter(
        ['Thinking out loud\n', `${marker}\n`, 'junk after marker'],
        `Thinking out loud\n${marker}\njunk after marker`,
      ),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'read the file' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain('"content":"Thinking out loud\\n"');
    // The marker never leaks as content; the call is relayed instead.
    expect(body).not.toContain('"content":"TOOL_CALL');
    expect(body).not.toContain('"content":"junk');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain('"name":"read_file"');
    await app.close();
  });

  it('tools mode withholds a partial marker forming across deltas', async () => {
    const app = buildApp({
      adapter: lineStreamingAdapter(
        ['TOOL_', 'CALL: {"name":"read_file","arguments":{}}\n'],
        'TOOL_CALL: {"name":"read_file","arguments":{}}\n',
      ),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'read the file' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    // No partial marker fragment may reach the client as content.
    expect(body).not.toContain('"content":"TOOL_');
    expect(body).toContain('"finish_reason":"tool_calls"');
    await app.close();
  });

  it('tools mode suppresses a dangling incomplete marker tail at turn end', async () => {
    const app = buildApp({
      adapter: lineStreamingAdapter(
        ['Answer text\n', 'TOOL_CALL: {bad'],
        'Answer text\nTOOL_CALL: {bad',
      ),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'hello' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain('"content":"Answer text\\n"');
    expect(body).not.toContain('"content":"TOOL_CALL');
    expect(body).toContain('"finish_reason":"stop"');
    await app.close();
  });
});

describe('concurrency cap', () => {
  it('drains more turns than the cap without deadlock', async () => {
    const app = buildApp({
      adapter: stubAdapter(async () => ({ text: 'OK', usage: null })),
      maxConcurrentTurns: 1,
    });
    const payload = {
      model: 'gemini-3.6-flash-low',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/v1/chat/completions', payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', payload }),
      app.inject({ method: 'POST', url: '/v1/chat/completions', payload }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }
    await app.close();
  });
});

describe('tool-description nudges', () => {
  const def = (name: string, description?: string) => ({
    type: 'function',
    function: {
      name,
      ...(description === undefined ? {} : { description }),
      parameters: { type: 'object', properties: {} },
    },
  });

  it('nudges write/edit toward reviewable file tools over shell redirection', () => {
    for (const name of ['write', 'edit']) {
      const parsed = parseToolDefinitions([def(name, 'Writes a file.')]);
      expect(parsed[0].description).toContain('Writes a file.');
      expect(parsed[0].description).toContain('PREFERRED over shell heredocs/redirects');
      expect(parsed[0].description).toContain('reviewable diff');
    }
  });

  it('filters the task tool out entirely (no subagent delegation for agy)', () => {
    const parsed = parseToolDefinitions([
      def('task', 'Runs a subagent.'),
      def('bash', 'Runs commands.'),
    ]);
    expect(parsed.map((d) => d.name)).toEqual(['bash']);
  });

  it('leaves all other tools untouched', () => {
    const parsed = parseToolDefinitions([def('read_file', 'reads a file')]);
    expect(parsed[0].description).toBe('reads a file');
  });

  it('is idempotent: an already-nudged description is returned unchanged', () => {
    const once = applyToolDescriptionNudge('write', 'Writes a file.');
    const twice = applyToolDescriptionNudge('write', once);
    expect(twice).toBe(once);
    expect(once.match(/PREFERRED over shell heredocs/g)).toHaveLength(1);
    // Through the full parse path as well (manifest text carries one nudge).
    const prompt = flattenMessages([{ role: 'user', content: 'hi' }], [def('write', once)]);
    expect(prompt.match(/PREFERRED over shell heredocs/g)).toHaveLength(1);
  });

  it('uses the nudge as the description when the client provides none', () => {
    const parsed = parseToolDefinitions([def('edit')]);
    expect(parsed[0].description).toContain('PREFERRED over shell heredocs/redirects');
  });
});

describe('deltaProtocolReminder (per-turn protocol freshness)', () => {
  it('always carries the marker-only execution rule', () => {
    const r = deltaProtocolReminder();
    expect(r).toContain('TOOL_CALL: <tool>');
    expect(r).toContain('prose claiming an action');
  });

  it('prohibits subagent delegation outright while running under the plugin', () => {
    const r = deltaProtocolReminder();
    expect(r).toContain('MUST NOT');
    expect(r).toContain('launch subagents');
    expect(r).toContain('TOOL_CALL: task is void');
    expect(r).toContain('perform the work yourself inline');
    expect(r).not.toContain('genuinely launches');
  });
});
