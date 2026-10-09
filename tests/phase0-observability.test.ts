import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectTurn, extractUsage, toOpenAIUsage } from '../src/agy';
import { buildApp } from '../src/server';

const MODEL = 'gemini-3.6-flash-low';
// Warm-lane pin: Option A semantics only in this file (see
// tests/warmLane.test.ts for dedicated lane coverage).
process.env.AGY_WARM_LANE = '0';

describe('toOpenAIUsage cache accounting (Phase 0)', () => {
  it('keeps legacy behavior with no cache_read (prompt=input, total passthrough)', () => {
    const mapped = toOpenAIUsage({
      inputTokens: 12,
      outputTokens: 2,
      totalTokens: 15,
      thinkingTokens: 3,
    });
    expect(mapped.prompt_tokens).toBe(12);
    expect(mapped.completion_tokens).toBe(2);
    expect(mapped.total_tokens).toBe(15);
    expect(mapped.thinking_tokens).toBe(3);
    expect(mapped.cached_tokens).toBeUndefined();
  });

  it('adds cache_read to prompt_tokens and keeps total consistent', () => {
    const mapped = toOpenAIUsage({
      inputTokens: 12722,
      outputTokens: 108,
      totalTokens: 12830,
      thinkingTokens: 107,
      cacheReadTokens: 8152,
    });
    expect(mapped.prompt_tokens).toBe(12722 + 8152);
    expect(mapped.completion_tokens).toBe(108);
    expect(mapped.total_tokens).toBe(12722 + 8152 + 108);
    expect(mapped.cached_tokens).toBe(8152);
    expect(mapped.thinking_tokens).toBe(107);
  });

  it('maps null usage to zeros with no cached_tokens', () => {
    const mapped = toOpenAIUsage(null);
    expect(mapped).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });
});

describe('extractUsage cache_read_tokens', () => {
  it('captures snake_case cache_read_tokens', () => {
    const usage = extractUsage({
      type: 'result',
      usage: { input_tokens: 100, output_tokens: 5, cache_read_tokens: 50 },
    });
    expect(usage).toMatchObject({ inputTokens: 100, cacheReadTokens: 50 });
  });

  it('collects cache_read from the synthetic fixture turn', () => {
    const collected = collectTurn([
      '{"event":"step_update","step_update":{"text_delta":"O"}}',
      '{"event":"result","result":{"response":"OK","usage":{"input_tokens":12722,"output_tokens":108,"thinking_tokens":107,"cache_read_tokens":8152,"total_tokens":12830}}}',
    ]);
    expect(collected.usage?.cacheReadTokens).toBe(8152);
    const mapped = toOpenAIUsage(collected.usage);
    expect(mapped.prompt_tokens).toBe(12722 + 8152);
    expect(mapped.cached_tokens).toBe(8152);
  });
});

describe('GET /v1/__debug/echo (E1 probe)', () => {
  it('returns the received headers with zero agy cost', async () => {
    const app = buildApp({
      adapter: { runTurn: () => Promise.reject(new Error('must not be called')) },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/__debug/echo',
      headers: { 'x-agy-session-id': 'ses-123', 'x-agy-agent': 'build' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { headers: Record<string, string> };
    expect(body.headers['x-agy-session-id']).toBe('ses-123');
    expect(body.headers['x-agy-agent']).toBe('build');
    await app.close();
  });
});

describe('request logger file (AGY_BRIDGE_LOG)', () => {
  const originalLog = process.env.AGY_BRIDGE_LOG;
  const originalHome = process.env.AGY_BRIDGE_HOME;
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agy-bridge-log-'));
    // Session-mode isolation: without this, a default-ON session mode would
    // read/write the REAL registry home (~/.agy-bridge) from tests.
    process.env.AGY_BRIDGE_HOME = dir;
  });

  afterEach(async () => {
    if (originalLog === undefined) {
      delete process.env.AGY_BRIDGE_LOG;
    } else {
      process.env.AGY_BRIDGE_LOG = originalLog;
    }
    if (originalHome === undefined) {
      delete process.env.AGY_BRIDGE_HOME;
    } else {
      process.env.AGY_BRIDGE_HOME = originalHome;
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup.
    }
  });

  it('writes a line to the file when env is set', async () => {
    const logFile = join(dir, 'nested', 'bridge.log');
    process.env.AGY_BRIDGE_LOG = logFile;
    const app = buildApp({
      adapter: { runTurn: () => Promise.resolve({ text: 'OK', usage: null }) },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/__debug/echo',
      headers: { 'x-agy-session-id': 'ses-log-1' },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
    const content = readFileSync(logFile, 'utf8');
    expect(content).toContain('GET');
    expect(content).toContain('/v1/__debug/echo');
    expect(content).toContain('sessionId=ses-log-1');
  });

  it('logs BEFORE/AFTER for chat completions with bytes and usage', async () => {
    const logFile = join(dir, 'bridge.log');
    process.env.AGY_BRIDGE_LOG = logFile;
    const app = buildApp({
      adapter: {
        runTurn: () =>
          Promise.resolve({
            text: 'OK',
            usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5 },
          }),
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-agy-session-id': 'ses-chat-1',
        'x-agy-agent': 'build',
        'x-agy-message-id': 'msg-1',
      },
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { usage: Record<string, number> };
    expect(body.usage.prompt_tokens).toBe(15);
    expect(body.usage.cached_tokens).toBe(5);
    await app.close();
    const content = readFileSync(logFile, 'utf8');
    expect(content).toContain('received');
    expect(content).toContain('bytes=');
    expect(content).toContain('sessionId=ses-chat-1');
    expect(content).toContain('agent=build');
    expect(content).toContain('msgId=msg-1');
    expect(content).toContain('cached=5');
  });

  it('does not crash when env is unset', async () => {
    delete process.env.AGY_BRIDGE_LOG;
    const app = buildApp({
      adapter: { runTurn: () => Promise.resolve({ text: 'OK', usage: null }) },
    });
    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });
    expect(response.statusCode).toBe(200);
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chat.statusCode).toBe(200);
    await app.close();
  });
});
