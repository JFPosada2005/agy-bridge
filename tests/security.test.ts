import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const ENV_KEYS = ['AGY_SESSION_MODE', 'AGY_BRIDGE_HOME'] as const;
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
