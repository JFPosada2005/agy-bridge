import { describe, expect, it } from 'vitest';
import {
  buildApp,
  extractToolCall,
  flattenMessages,
  stripDanglingMarker,
  type TurnAdapter,
} from '../src/server';
import type { AgyUsage } from '../src/agy';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from disk.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  { type: 'function', function: { name: 'list_dir', parameters: { type: 'object' } } },
  {
    type: 'function',
    function: {
      name: 'skill',
      description: 'Load a specialized skill.',
      parameters: { type: 'object', properties: { id: { type: 'string' } } },
    },
  },
];

const MODEL = 'gemini-3.6-flash-low';

function capturingAdapter(
  text: string,
  seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean },
): TurnAdapter {
  return {
    runTurn: (request, onDelta) => {
      seen.prompt = request.prompt;
      seen.onDeltaSeen = typeof onDelta === 'function';
      if (onDelta) {
        // T10 streamed tools mode: realistic live replay — the final text
        // streams in a few deltas (matches real agy text_delta behavior).
        const third = Math.max(1, Math.ceil(text.length / 3));
        for (let i = 0; i < text.length; i += third) {
          const piece = text.slice(i, i + third);
          onDelta(piece);
          seen.deltas.push(piece);
        }
      }
      const usage: AgyUsage | null = null;
      return Promise.resolve({ text, usage });
    },
  };
}

describe('extractToolCall', () => {
  it('parses a valid marker for a known tool', () => {
    const call = extractToolCall('TOOL_CALL: {"name": "read_file", "arguments": {"path": "a.txt"}}', [
      'read_file',
    ]);
    expect(call).toEqual({ name: 'read_file', arguments: { path: 'a.txt' } });
  });

  it('parses the natural shorthand form emitted by Gemini', () => {
    expect(extractToolCall('TOOL_CALL: skill {"id": "docx"}', ['skill'])).toEqual({
      name: 'skill',
      arguments: { id: 'docx' },
    });
    expect(extractToolCall('TOOL_CALL: read_file {"path": "a.txt"}', ['read_file'])).toEqual({
      name: 'read_file',
      arguments: { path: 'a.txt' },
    });
    expect(extractToolCall('TOOL_CALL: list_dir', ['list_dir'])).toEqual({
      name: 'list_dir',
      arguments: {},
    });
    expect(extractToolCall('TOOL_CALL: skill({"id": "docx"})', ['skill'])).toEqual({
      name: 'skill',
      arguments: { id: 'docx' },
    });
    expect(extractToolCall('TOOL_CALL: skill {"id": "docx"} ```', ['skill'])).toEqual({
      name: 'skill',
      arguments: { id: 'docx' },
    });
  });

  it('rejects an unknown shorthand name and malformed shorthand arguments', () => {
    expect(extractToolCall('TOOL_CALL: delete_everything {"x": 1}', ['skill'])).toBeNull();
    expect(extractToolCall('TOOL_CALL: skill not-json', ['skill'])).toBeNull();
    expect(extractToolCall('TOOL_CALL: skill ["not","object"]', ['skill'])).toBeNull();
  });

  it('defaults missing arguments to {}', () => {
    expect(extractToolCall('TOOL_CALL: {"name": "list_dir"}', ['list_dir'])).toEqual({
      name: 'list_dir',
      arguments: {},
    });
  });

  it('rejects unparsable JSON', () => {
    expect(extractToolCall('TOOL_CALL: {"name": ', ['read_file'])).toBeNull();
    expect(extractToolCall('TOOL_CALL: not json at all', ['read_file'])).toBeNull();
  });

  it('rejects hallucinated names not among the request tools', () => {
    const text = 'TOOL_CALL: {"name": "delete_everything", "arguments": {}}';
    expect(extractToolCall(text, ['read_file', 'list_dir'])).toBeNull();
  });

  it('trims trailing code fences around the JSON', () => {
    const call = extractToolCall(
      'TOOL_CALL: {"name": "read_file", "arguments": {"path": "a.txt"}} ```',
      ['read_file'],
    );
    expect(call).toEqual({ name: 'read_file', arguments: { path: 'a.txt' } });
  });

  it('still matches when other content precedes the marker', () => {
    const text = 'Let me check that file for you.\nTOOL_CALL: {"name": "read_file"}';
    expect(extractToolCall(text, ['read_file'])?.name).toBe('read_file');
  });

  it('ignores prose that merely discusses markers', () => {
    expect(
      extractToolCall('You can emit something like TOOL_CALL: {"name": "x"} in theory', [
        'x',
      ]),
    ).toBeNull();
    expect(extractToolCall('TOOL_CALL is not used here', ['TOOL_CALL'])).toBeNull();
  });

  it('allows leading whitespace but rejects empty names and non-object arguments', () => {
    expect(
      extractToolCall('   TOOL_CALL: {"name": "read_file", "arguments": {}}', ['read_file']),
    ).not.toBeNull();
    expect(extractToolCall('TOOL_CALL: {"name": "", "arguments": {}}', [''])).toBeNull();
    expect(
      extractToolCall('TOOL_CALL: {"name": "read_file", "arguments": "oops"}', ['read_file']),
    ).toBeNull();
    expect(
      extractToolCall('TOOL_CALL: {"name": "read_file", "arguments": []}', ['read_file']),
    ).toBeNull();
  });
});

describe('stripDanglingMarker', () => {
  it('strips a trailing bare marker line', () => {
    expect(stripDanglingMarker('Here is your answer.\nTOOL_CALL:')).toBe('Here is your answer.');
    expect(stripDanglingMarker('Answer.\n   TOOL_CALL:   ')).toBe('Answer.');
  });

  it('leaves text without a marker and markers with content untouched', () => {
    expect(stripDanglingMarker('Plain answer.')).toBe('Plain answer.');
    const withJson = 'Answer.\nTOOL_CALL: {"name": "read_file"}';
    expect(stripDanglingMarker(withJson)).toBe(withJson);
    expect(stripDanglingMarker('TOOL_CALL: is discussed here')).toBe(
      'TOOL_CALL: is discussed here',
    );
  });
});

describe('flattenMessages tools mode', () => {
  it('injects the manifest from the request tools and the tools reminder', () => {
    const prompt = flattenMessages([{ role: 'user', content: 'hi' }], TOOLS);
    expect(prompt).toContain('TOOL_CALL:');
    expect(prompt).toContain('### read_file');
    expect(prompt).toContain('Read a file from disk.');
    expect(prompt).toContain('(no description)');
    expect(prompt).toContain('"path"');
    expect(prompt).toContain(
      'Reminder: to use a tool, emit the TOOL_CALL: marker line first; otherwise answer in plain text.',
    );
    expect(prompt).not.toContain('answer in plain text only');
  });

  it('keeps the chat-only preamble when tools are absent or empty', () => {
    for (const tools of [undefined, [], [{ type: 'other' }]]) {
      const prompt = flattenMessages([{ role: 'user', content: 'hi' }], tools);
      expect(prompt).toContain('answer in plain text only');
      expect(prompt).toContain('do NOT use any tools.');
      expect(prompt).not.toContain('### ');
    }
  });

  it('never invents tools: only sent definitions appear in the manifest', () => {
    const prompt = flattenMessages([{ role: 'user', content: 'hi' }], [TOOLS[0]]);
    expect(prompt).toContain('read_file');
    expect(prompt).not.toContain('list_dir');
  });

  it('flattens assistant tool_calls turns', () => {
    const prompt = flattenMessages(
      [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            },
          ],
        },
      ],
      TOOLS,
    );
    expect(prompt).toContain('assistant: <calls tool read_file with arguments {"path":"a.txt"}>');
  });

  it('flattens tool role results, preferring name over tool_call_id', () => {
    const named = flattenMessages(
      [{ role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'hello' }],
      TOOLS,
    );
    expect(named).toContain('tool read_file: hello');

    const byId = flattenMessages(
      [{ role: 'tool', tool_call_id: 'call_9', content: 'world' }],
      TOOLS,
    );
    expect(byId).toContain('tool call_9: world');

    const unknown = flattenMessages([{ role: 'tool', content: '?' }], TOOLS);
    expect(unknown).toContain('tool unknown_tool: ?');
  });

  it('flattens array content parts in tool results', () => {
    const prompt = flattenMessages(
      [
        {
          role: 'tool',
          name: 'read_file',
          content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
        },
      ],
      TOOLS,
    );
    expect(prompt).toContain('tool read_file: ab');
  });

  it('keeps the 400 errors for empty and content-less message arrays', () => {
    expect(() => flattenMessages([], TOOLS)).toThrowError(/non-empty array/);
    expect(() => flattenMessages([null], TOOLS)).toThrowError(/non-empty message/);
  });
});

describe('POST /v1/chat/completions tools mode', () => {
  const toolPayload = (messages: unknown[], stream?: boolean) => ({
    model: MODEL,
    messages,
    tools: TOOLS,
    ...(stream === undefined ? {} : { stream }),
  });

  it('non-stream: marker match returns tool_calls with finish_reason tool_calls', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({
      adapter: capturingAdapter('TOOL_CALL: {"name": "read_file", "arguments": {"path": "a.txt"}}', seen),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'read a.txt' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: Array<{
        message: { role: string; content: string | null; tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
    };
    const choice = body.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls[0].type).toBe('function');
    expect(choice.message.tool_calls[0].id.startsWith('call_')).toBe(true);
    expect(choice.message.tool_calls[0].function.name).toBe('read_file');
    expect(JSON.parse(choice.message.tool_calls[0].function.arguments)).toEqual({ path: 'a.txt' });
    // The manifest reaching the model came only from the request tools.
    expect(seen.prompt).toContain('### read_file');
    await app.close();
  });

  it('non-stream: plain text answer returns content stop with dangling markers stripped', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({
      adapter: capturingAdapter('Just a chat reply.\nTOOL_CALL:', seen),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'hello' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.choices[0].message.content).toBe('Just a chat reply.');
    await app.close();
  });

  it('stream: marker match relays tool_calls without leaking marker content (T10 streamed)', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({
      adapter: capturingAdapter('TOOL_CALL: {"name": "list_dir", "arguments": {}}', seen),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'list files' }], true),
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    // T10: the marker-safe buffer withheld the whole marker (never emitted).
    expect(body).not.toContain('"content"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    // Streamed mode: the adapter receives a live delta callback.
    expect(seen.onDeltaSeen).toBe(true);
    await app.close();
  });

  it('stream: plain text answer streams content pieces with finish_reason stop', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({ adapter: capturingAdapter('Hello there.', seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'hi' }], true),
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    // T10: text streams in pieces as deltas arrive (no full-text duplicate).
    expect(body).toContain('"content":"Hell"');
    expect(body).toContain('"content":"ere."');
    expect(body).not.toContain('"content":"Hello there."');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await app.close();
  });

  it('non-stream: shorthand marker (skill docx) returns tool_calls', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({
      adapter: capturingAdapter('TOOL_CALL: skill {"id": "docx"}', seen),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'make a docx' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: Array<{
        message: { content: string | null; tool_calls: Array<{ function: { name: string; arguments: string } }> };
        finish_reason: string;
      }>;
    };
    const choice = body.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls[0].function.name).toBe('skill');
    expect(JSON.parse(choice.message.tool_calls[0].function.arguments)).toEqual({ id: 'docx' });
    await app.close();
  });

  it('non-stream: an invalid marker is returned as text, not an empty turn', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({ adapter: capturingAdapter('TOOL_CALL: ???', seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'hello' }]),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.choices[0].message.content).toBe('TOOL_CALL: ???');
    await app.close();
  });

  it('stream: shorthand marker relays tool_calls without leaking marker content', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({
      adapter: capturingAdapter('TOOL_CALL: skill {"id": "docx"}', seen),
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'make a docx' }], true),
    });
    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).not.toContain('"content"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    await app.close();
  });

  it('stream: an invalid marker is preserved as content, not an empty turn', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({ adapter: capturingAdapter('TOOL_CALL: ???', seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([{ role: 'user', content: 'hello' }], true),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('TOOL_CALL: ???');
    expect(response.body).toContain('"finish_reason":"stop"');
    await app.close();
  });

  it('follow-up turn with tool results round-trips through the flattened prompt', async () => {
    const seen: { prompt?: string; deltas: string[]; onDeltaSeen: boolean } = { deltas: [], onDeltaSeen: false };
    const app = buildApp({ adapter: capturingAdapter('Done reading it.', seen) });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: toolPayload([
        { role: 'user', content: 'read a.txt' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: 'file bytes' },
      ]),
    });
    expect(response.statusCode).toBe(200);
    expect(seen.prompt).toContain('<calls tool read_file with arguments {"path":"a.txt"}>');
    expect(seen.prompt).toContain('tool read_file: file bytes');
    const body = response.json() as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
    };
    expect(body.choices[0].message.content).toBe('Done reading it.');
    await app.close();
  });
});
