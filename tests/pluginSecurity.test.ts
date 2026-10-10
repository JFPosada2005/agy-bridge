import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateToken } from '../src/security';
import { buildApp } from '../src/server';

// Behavioral checks of plugins/agy-bridge.ts (security audit 2026-10-09):
// the watchdog must never kill a pid, nor hand out the install token, unless
// the listener on the bridge port proves it knows that token.

process.env.AGY_WARM_LANE = '0';
const ENV_KEYS = ['AGY_BRIDGE_PORT', 'AGY_BRIDGE_HOME', 'AGY_BRIDGE_REPO', 'AGY_BRIDGE_NODE', 'USERPROFILE', 'HOME'] as const;

type Hooks = {
  'chat.headers': (input: unknown, output: { headers?: Record<string, string> }) => Promise<void>;
};

let root = '';
let savedEnv: Record<string, string | undefined> = {};
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), 'agy-bridge-plugin-'));
  process.env.AGY_BRIDGE_HOME = join(root, 'home');
  process.env.USERPROFILE = join(root, 'profile');
  process.env.HOME = join(root, 'profile');
  // A dist/ so the stale-build handshake is armed (expectedBuildId != null).
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'dist'), { recursive: true });
  writeFileSync(join(repo, 'dist', 'index.js'), '// fake build\n');
  process.env.AGY_BRIDGE_REPO = repo;
  // Any accidental spawn must fail harmlessly.
  process.env.AGY_BRIDGE_NODE = join(root, 'no-such-node');
  vi.resetModules();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  rmSync(root, { recursive: true, force: true });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startVictim(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  cleanups.push(() => {
    child.kill();
  });
  return child;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

async function loadPlugin(port: number): Promise<Hooks> {
  process.env.AGY_BRIDGE_PORT = String(port);
  const mod = (await import('../plugins/agy-bridge')) as { default: () => Promise<Hooks> };
  return mod.default();
}

const agyChat = { sessionID: 'ses_1', agent: 'build', model: { providerID: 'agy-bridge' } };

describe('plugin watchdog vs a foreign listener on the bridge port', () => {
  it('does not kill the pid reported by an unverified listener and does not send the token', async () => {
    const victim = startVictim();
    const impostor = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', buildId: 'stale', pid: victim.pid, inflight: 0 }));
    });
    const port = await listen(impostor);
    const hooks = await loadPlugin(port);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(victim.pid as number)).toBe(true);
    const out: { headers?: Record<string, string> } = {};
    await hooks['chat.headers'](agyChat, out);
    expect(out.headers?.['x-agy-session-id']).toBe('ses_1');
    expect(out.headers?.['x-agy-token']).toBeUndefined();
  });

  it('verifies the real daemon via the HMAC proof and then sends the token', async () => {
    const token = loadOrCreateToken(join(root, 'home', 'token'));
    const app = buildApp({
      adapter: { runTurn: () => Promise.resolve({ text: 'OK', usage: null }) },
      security: { token },
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    cleanups.push(() => app.close());
    const port = (app.server.address() as AddressInfo).port;
    const hooks = await loadPlugin(port);
    const out: { headers?: Record<string, string> } = {};
    await hooks['chat.headers'](agyChat, out);
    expect(out.headers?.['x-agy-token']).toBe(token);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...out.headers },
      body: JSON.stringify({ model: 'gemini-3.6-flash-low', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
  });
});
