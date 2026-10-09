import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectTurn,
  eventKind,
  extractDeniedActions,
  extractResultText,
  extractTextDelta,
  extractUsage,
  parseNdjsonLine,
} from '../src/agy';

const FIXTURE_PATH = join(__dirname, 'fixtures', 'stream-json-sample.ndjson');

function fixtureLines(): string[] {
  return readFileSync(FIXTURE_PATH, 'utf8').split('\n');
}

describe('parseNdjsonLine', () => {
  it('parses JSON object lines', () => {
    const event = parseNdjsonLine('{"type":"init"}');
    expect(event).toEqual({ type: 'init' });
  });

  it('skips blank lines and non-JSON lead lines', () => {
    expect(parseNdjsonLine('')).toBeNull();
    expect(parseNdjsonLine('   ')).toBeNull();
    expect(parseNdjsonLine('Fetching available models...')).toBeNull();
    expect(parseNdjsonLine('# SYNTHETIC fixture')).toBeNull();
  });

  it('skips malformed JSON without throwing', () => {
    expect(parseNdjsonLine('{"type":')).toBeNull();
  });
});

describe('eventKind', () => {
  it('recognizes init, step_update and result', () => {
    expect(eventKind({ type: 'init' })).toBe('init');
    expect(eventKind({ type: 'step_update' })).toBe('step_update');
    expect(eventKind({ type: 'result' })).toBe('result');
  });

  it('falls back to other for tool_info and unknown shapes', () => {
    expect(eventKind({ type: 'tool_info' })).toBe('other');
    expect(eventKind({ foo: 1 })).toBe('other');
  });
});

describe('extractTextDelta', () => {
  it('reads snake_case and camelCase delta keys', () => {
    expect(extractTextDelta({ type: 'step_update', text_delta: 'hi' })).toBe('hi');
    expect(extractTextDelta({ delta: { text: 'yo' } })).toBe('yo');
  });

  it('reads the real nested agy shape (event/step_update.text_delta)', () => {
    expect(
      extractTextDelta({
        event: 'step_update',
        step_update: { step_index: 1, state: 'ACTIVE', text_delta: 'OK' },
      }),
    ).toBe('OK');
  });

  it('returns empty string when no delta is present', () => {
    expect(extractTextDelta({ type: 'tool_info' })).toBe('');
  });
});

describe('extractUsage', () => {
  it('captures usage including thinking_tokens', () => {
    const usage = extractUsage({
      type: 'result',
      usage: { input_tokens: 12, output_tokens: 2, total_tokens: 15, thinking_tokens: 3 },
    });
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 2, totalTokens: 15, thinkingTokens: 3 });
  });

  it('captures the real nested usage (result.usage)', () => {
    const usage = extractUsage({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'OK\n',
        usage: { input_tokens: 12722, output_tokens: 108, thinking_tokens: 107, total_tokens: 12830 },
      },
    });
    expect(usage).toMatchObject({ inputTokens: 12722, thinkingTokens: 107, totalTokens: 12830 });
  });

  it('returns null when no usage is present', () => {
    expect(extractUsage({ type: 'step_update', text_delta: 'x' })).toBeNull();
  });
});

describe('extractResultText', () => {
  it('reads the terminal result text', () => {
    expect(extractResultText({ type: 'result', result: 'OK' })).toBe('OK');
  });

  it('reads the real nested response (result.response)', () => {
    expect(
      extractResultText({ event: 'result', result: { status: 'SUCCESS', response: 'OK\n' } }),
    ).toBe('OK\n');
  });
});

describe('extractDeniedActions (real agy denial shape)', () => {
  it('extracts display names from a denied tool turn', () => {
    const resultEvent = {
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: '',
        denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }],
      },
    };
    expect(extractDeniedActions(resultEvent)).toEqual(['CallMcpTool']);
  });

  it('reads the nested result payload', () => {
    const resultEvent = {
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: '',
        denied_actions: [{ action: 'mcp', display_name: 'CallMcpTool' }, { action: 'edit' }],
      },
    };
    expect(extractDeniedActions(resultEvent)).toEqual(['CallMcpTool', 'edit']);
  });

  it('returns empty when no denial happened', () => {
    expect(extractDeniedActions({ event: 'result', result: { response: 'hi' } })).toEqual([]);
    expect(extractDeniedActions({ type: 'result' })).toEqual([]);
  });
});

describe('collectTurn (synthetic fixture)', () => {
  it('assembles incremental deltas and skips lead lines', () => {
    const collected = collectTurn(fixtureLines());
    expect(collected.text).toBe('OK\n');
    expect(collected.usage?.thinkingTokens).toBe(107);
    expect(collected.usage?.inputTokens).toBe(12722);
    expect(collected.warnings.length).toBeGreaterThanOrEqual(2);
    expect(collected.resultEvent).not.toBeNull();
    expect(collected.deniedActions).toEqual([]);
  });

  it('propagates denied actions from the result event', () => {
    const collected = collectTurn([
      '{"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"mcp","display_name":"CallMcpTool"}]}}',
    ]);
    expect(collected.text).toBe('');
    expect(collected.deniedActions).toEqual(['CallMcpTool']);
  });

  it('falls back to the result text when no deltas were streamed', () => {
    const collected = collectTurn(['{"type":"result","result":"fallback answer"}']);
    expect(collected.text).toBe('fallback answer');
  });

  it('prefers per-turn step_update usage over session-cumulative result usage (E11)', () => {
    const collected = collectTurn([
      '{"type":"init","conversation_id":"c-1"}',
      '{"type":"step_update","usage":{"input_tokens":14854,"cache_read_tokens":32691,"output_tokens":2,"total_tokens":14856}}',
      '{"type":"result","result":{"response":"READY2","usage":{"input_tokens":48973,"cache_read_tokens":32691,"output_tokens":4,"total_tokens":48977}}}',
    ]);
    // The result event is session-cumulative (34119 + 14854 = 48973); the
    // step_update event carries the real per-turn consumption. Per-turn wins.
    expect(collected.usage).toEqual({
      inputTokens: 14854,
      cacheReadTokens: 32691,
      outputTokens: 2,
      totalTokens: 14856,
    });
  });

  it('falls back to result usage when no step_update usage exists', () => {
    const collected = collectTurn([
      '{"type":"init","conversation_id":"c-1"}',
      '{"type":"result","result":{"response":"OK","usage":{"input_tokens":34119,"output_tokens":2,"total_tokens":34121}}}',
    ]);
    expect(collected.usage).toMatchObject({ inputTokens: 34119, outputTokens: 2 });
  });

  it('keeps the last step_update usage when several are present', () => {
    const collected = collectTurn([
      '{"type":"step_update","usage":{"input_tokens":1000,"output_tokens":1}}',
      '{"type":"step_update","usage":{"input_tokens":14854,"cache_read_tokens":32691,"output_tokens":2}}',
      '{"type":"result","result":{"response":"OK","usage":{"input_tokens":48973,"output_tokens":4}}}',
    ]);
    expect(collected.usage?.inputTokens).toBe(14854);
    expect(collected.usage?.cacheReadTokens).toBe(32691);
  });
});
