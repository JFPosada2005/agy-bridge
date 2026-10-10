import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agyChildEnv, runAgyTurn } from '../src/agy';
import { healthProof, loadOrCreateToken, TOKEN_HEADER } from '../src/security';
import { buildApp, type TurnAdapter } from '../src/server';
import {
  freshSessionRecord,
  isValidSessionId,
  loadSessionRecord,
  saveSessionRecord,
} from '../src/sessionStore';

// Security regressions found in the 2026-10-09 audit. Every test runs against
// an isolated AGY_BRIDGE_HOME with a "victim" folder next to it: nothing may
// ever be read, renamed or written outside <home>/sessions.

process.env.AGY_WARM_LANE = '0';
const ENV_KEYS = ['AGY_SESSION_MODE', 'AGY_BRIDGE_HOME', 'AGY_BRIDGE_DEBUG'] as const;
const MODEL = 'gemini-3.6-flash-low';

let root = '';
let victimDir = '';
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), 'agy-bridge-security-'));
  process.env.AGY_BRIDGE_HOME = join(root, 'home');
  process.env.AGY_SESSION_MODE = '1';
  victimDir = join(root, 'victim');
  mkdirSync(victimDir, { recursive: true });
  writeFileSync(join(victimDir, 'config.json'), '{"keep":"me"}');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function victimUntouched(): void {
  expect(readdirSync(victimDir)).toEqual(['config.json']);
  expect(readFileSync(join(victimDir, 'config.json'), 'utf8')).toBe('{"keep":"me"}');
}

const okAdapter: TurnAdapter = {
  runTurn: () => Promise.resolve({ text: 'OK', usage: null, conversationId: 'conv-1' }),
};

const TRAVERSAL_IDS = ['../../victim/config', '..\\..\\victim\\config', '../x', 'a/b', 'C:\\x', 'a.b'];

describe('session id validation (path traversal)', () => {
  it('accepts opaque ids and rejects anything path-like', () => {
    for (const ok of ['ses_01JABCDEF', 'ses-chat-1', 'A_b-9', 'x'.repeat(128)]) {
      expect(isValidSessionId(ok)).toBe(true);
    }
    for (const bad of [...TRAVERSAL_IDS, '', 'x'.repeat(129), 'ses 1', 'ses\n1', 42, null]) {
      expect(isValidSessionId(bad)).toBe(false);
    }
  });

  it('loadSessionRecord never touches files outside the store', () => {
    const record = loadSessionRecord('../../victim/config');
    expect(record.branches).toEqual([]);
    victimUntouched();
  });

  it('saveSessionRecord refuses invalid ids (nothing written)', () => {
    saveSessionRecord(freshSessionRecord('../../victim/new'));
    expect(existsSync(join(victimDir, 'new.json'))).toBe(false);
    victimUntouched();
  });

  it('tombstone route rejects traversal ids with 400', async () => {
    const app = buildApp({ adapter: okAdapter });
    for (const sessionId of TRAVERSAL_IDS) {
      const res = await app.inject({ method: 'POST', url: '/v1/__session/tombstone', payload: { sessionId } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_session_id');
    }
    victimUntouched();
    await app.close();
  });

  it('chat route rejects traversal in x-agy-session-id and x-agy-parent-session-id', async () => {
    const app = buildApp({ adapter: okAdapter });
    for (const header of ['x-agy-session-id', 'x-agy-parent-session-id']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { [header]: '../../victim/config', 'x-agy-agent': 'build' },
        payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_session_id');
    }
    victimUntouched();
    await app.close();
  });

  it('valid session ids keep working', async () => {
    const app = buildApp({ adapter: okAdapter });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-agy-session-id': 'ses_valid1', 'x-agy-agent': 'build' },
      payload: { model: MODEL, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(root, 'home', 'sessions', 'ses_valid1.json'))).toBe(true);
    await app.close();
  });
});

const TOKEN = 'a'.repeat(64);
const chatPayload = { model: MODEL, messages: [{ role: 'user', content: 'hi' }] };

describe('install token, Host and Origin gate', () => {
  it('requires the token on API routes when configured', async () => {
    const app = buildApp({ adapter: okAdapter, security: { token: TOKEN } });
    const none = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chatPayload });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { [TOKEN_HEADER]: 'b'.repeat(64) },
      payload: chatPayload,
    });
    expect(wrong.statusCode).toBe(401);
    const header = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { [TOKEN_HEADER]: TOKEN },
      payload: chatPayload,
    });
    expect(header.statusCode).toBe(200);
    const bearer = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: chatPayload,
    });
    expect(bearer.statusCode).toBe(200);
    const models = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(models.statusCode).toBe(401);
    const tombstone = await app.inject({ method: 'POST', url: '/v1/__session/tombstone', payload: { sessionId: 'ses_x' } });
    expect(tombstone.statusCode).toBe(401);
    await app.close();
  });

  it('rejects non-loopback Host headers (DNS rebinding) even with the token', async () => {
    const app = buildApp({ adapter: okAdapter, security: { token: TOKEN } });
    for (const host of ['attacker.example:41667', 'attacker.example', '127.0.0.1.attacker.example']) {
      const res = await app.inject({ method: 'GET', url: '/healthz', headers: { host, [TOKEN_HEADER]: TOKEN } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden_host');
    }
    for (const host of ['127.0.0.1:41667', 'localhost:41667', 'localhost']) {
      const res = await app.inject({ method: 'GET', url: '/healthz', headers: { host } });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it('rejects browser requests from foreign origins', async () => {
    const app = buildApp({ adapter: okAdapter, security: { token: TOKEN } });
    for (const origin of ['https://evil.example', 'null']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { origin, [TOKEN_HEADER]: TOKEN },
        payload: chatPayload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('forbidden_origin');
    }
    const local = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { origin: 'http://127.0.0.1:4096', [TOKEN_HEADER]: TOKEN },
      payload: chatPayload,
    });
    expect(local.statusCode).toBe(200);
    await app.close();
  });

  it('public /healthz returns only non-sensitive fields plus the HMAC proof', async () => {
    const app = buildApp({ adapter: okAdapter, security: { token: TOKEN } });
    const anon = await app.inject({ method: 'GET', url: '/healthz?nonce=n0nce' });
    expect(anon.statusCode).toBe(200);
    const body = anon.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok', inflight: 0 });
    expect(typeof body['pid']).toBe('number');
    expect(body['agy']).toBeUndefined();
    expect(body['proof']).toBe(healthProof(TOKEN, 'n0nce'));
    expect(body['proof']).not.toBe(healthProof('c'.repeat(64), 'n0nce'));
    const authed = await app.inject({ method: 'GET', url: '/healthz', headers: { [TOKEN_HEADER]: TOKEN } });
    expect((authed.json() as Record<string, unknown>)['agy']).toBeDefined();
    await app.close();
  });

  it('debug routes are off unless AGY_BRIDGE_DEBUG is set, and never echo the token', async () => {
    delete process.env.AGY_BRIDGE_DEBUG;
    const app = buildApp({ adapter: okAdapter, security: { token: TOKEN } });
    for (const url of ['/v1/__debug/echo', '/v1/__debug/stats']) {
      const res = await app.inject({ method: 'GET', url, headers: { [TOKEN_HEADER]: TOKEN } });
      expect(res.statusCode).toBe(404);
    }
    process.env.AGY_BRIDGE_DEBUG = '1';
    const echo = await app.inject({
      method: 'GET',
      url: '/v1/__debug/echo',
      headers: { [TOKEN_HEADER]: TOKEN, 'x-agy-session-id': 'ses_1' },
    });
    expect(echo.statusCode).toBe(200);
    const echoed = (echo.json() as { headers: Record<string, string> }).headers;
    expect(echoed['x-agy-session-id']).toBe('ses_1');
    expect(echoed[TOKEN_HEADER]).toBeUndefined();
    const noToken = await app.inject({ method: 'GET', url: '/v1/__debug/stats' });
    expect(noToken.statusCode).toBe(401);
    await app.close();
  });
});

describe('loadOrCreateToken', () => {
  it('creates a 64-hex token once, reuses it, and replaces a malformed file', () => {
    const file = join(root, 'home', 'token');
    const first = loadOrCreateToken(file);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(loadOrCreateToken(file)).toBe(first);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o077).toBe(0);
    }
    writeFileSync(file, 'garbage');
    const replaced = loadOrCreateToken(file);
    expect(replaced).toMatch(/^[0-9a-f]{64}$/);
    expect(replaced).not.toBe(first);
  });

  it('the daemon entrypoint always wires the token into buildApp', () => {
    const indexSrc = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(indexSrc).toMatch(/loadOrCreateToken\(\)/);
    expect(indexSrc).toMatch(/buildApp\(\{ security: \{ token \} \}\)/);
  });
});

describe('request body limit', () => {
  it('accepts a 2 MB chat body (Fastify default 1 MiB answered 413)', async () => {
    const app = buildApp({ adapter: okAdapter });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: MODEL, messages: [{ role: 'user', content: 'x'.repeat(2_000_000) }] },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe('agy child environment', () => {
  it('drops credential-looking variables and honors AGY_ENV_PASSTHROUGH', () => {
    const env = agyChildEnv({
      PATH: '/bin',
      USERPROFILE: 'C:\\u',
      OPENAI_API_KEY: 's',
      GITHUB_TOKEN: 't',
      AWS_SECRET_ACCESS_KEY: 'a',
      MY_PASSWORD: 'p',
      GOOGLE_APPLICATION_CREDENTIALS: 'c',
      TOKENIZER_PATH: 'v',
      AGY_ENV_PASSTHROUGH: 'github_token',
    });
    expect(Object.keys(env).sort()).toEqual(['AGY_ENV_PASSTHROUGH', 'GITHUB_TOKEN', 'PATH', 'TOKENIZER_PATH', 'USERPROFILE']);
  });

  it('the spawned agy process does not receive them', async () => {
    process.env.FAKE_PROVIDER_API_KEY = 'leak-me';
    try {
      const script =
        "process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify(" +
        "{ event: 'result', result: { response: Object.keys(process.env).join(',') } })));";
      const result = await runAgyTurn({
        model: 'fake-model',
        effort: null,
        prompt: 'hi',
        binaryPath: process.execPath,
        commandOverride: { cmd: process.execPath, args: ['-e', script] },
      });
      expect(result.text).toMatch(/PATH/i);
      expect(result.text).not.toContain('FAKE_PROVIDER_API_KEY');
    } finally {
      delete process.env.FAKE_PROVIDER_API_KEY;
    }
  }, 15_000);
});
