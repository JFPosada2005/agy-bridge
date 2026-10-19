import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOrCreateToken } from '../src/security';

// Behavioral checks of plugins/agy-bridge-v2.ts: the V2 plugin must keep the
// V1 security contract (HMAC-verified listener, token only after proof) and the
// V1 identity/lifecycle behavior through the V2 domains.

process.env.AGY_WARM_LANE = '0';
const ENV_KEYS = [
  'AGY_BRIDGE_PORT',
  'AGY_BRIDGE_HOME',
  'AGY_BRIDGE_REPO',
  'AGY_BRIDGE_NODE',
  'AGY_BRIDGE_SPAWN_POLL_MS',
  'AGY_BRIDGE_SPAWN_ATTEMPTS',
  'USERPROFILE',
  'HOME',
] as const;

type V2Module = {
  default: {
    id: string;
    setup: (ctx: any) => Promise<() => Promise<void>>;
  };
};

type Hook = (event: any) => void | Promise<void>;

type FakeContext = {
  ctx: any;
  hooks: Map<string, Hook>;
  transforms: Array<(editor: any) => void>;
  modelTransforms: Array<(editor: any) => void>;
  push: (event: any) => void;
  signal: () => AbortSignal | undefined;
};

let root = '';
let savedEnv: Record<string, string | undefined> = {};
const cleanups: Array<() => void | Promise<void>> = [];

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
  root = mkdtempSync(join(tmpdir(), 'agy-bridge-plugin-v2-'));
  process.env.AGY_BRIDGE_HOME = join(root, 'home');
  process.env.USERPROFILE = join(root, 'profile');
  process.env.HOME = join(root, 'profile');
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

function makeContext(): FakeContext {
  const hooks = new Map<string, Hook>();
  const transforms: Array<(editor: any) => void> = [];
  const modelTransforms: Array<(editor: any) => void> = [];
  const queue: any[] = [];
  let signal: AbortSignal | undefined;
  const ctx = {
    location: { directory: 'C:/project' },
    session: {
      hook: async (name: string, callback: Hook) => {
        hooks.set(name, callback);
        return {
          dispose: async () => {
            hooks.delete(name);
          },
        };
      },
    },
    provider: {
      transform: async (callback: (editor: any) => void) => {
        transforms.push(callback);
        return { dispose: async () => undefined };
      },
    },
    model: {
      transform: async (callback: (editor: any) => void) => {
        modelTransforms.push(callback);
        return { dispose: async () => undefined };
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return (async function* () {
          while (!signal?.aborted) {
            if (queue.length > 0) {
              yield queue.shift();
              continue;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        })();
      },
    },
  };
  return {
    ctx,
    hooks,
    transforms,
    modelTransforms,
    push: (event: any) => queue.push(event),
    signal: () => signal,
  };
}

async function loadV2(port: number): Promise<V2Module['default']> {
  process.env.AGY_BRIDGE_PORT = String(port);
  const mod = (await import('../plugins/agy-bridge-v2')) as V2Module;
  return mod.default;
}

type FakeBridgeOptions = {
  token: string | null;
  validProof?: boolean;
  buildId?: string;
  pid?: number;
  inflight?: number;
};

type FakeBridge = {
  port: number;
  requests: Array<{ url: string; method: string; headers: Record<string, any>; body: string }>;
  close: () => Promise<void>;
};

async function startBridge(options: FakeBridgeOptions): Promise<FakeBridge> {
  const requests: FakeBridge['requests'] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/healthz') {
      const nonce = url.searchParams.get('nonce') ?? '';
      const proof =
        options.token && options.validProof !== false
          ? createHmac('sha256', options.token).update(`agy-bridge-health:${nonce}`).digest('hex')
          : 'not-a-valid-proof';
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          buildId: options.buildId ?? 'stale-build',
          pid: options.pid ?? process.pid,
          inflight: options.inflight ?? 1,
          proof,
        }),
      );
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body });
      res.statusCode = 200;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met before timeout');
}

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

describe('agy-bridge V2 plugin contract', () => {
  it('exports a default V2 definition with id and setup and no named exports', async () => {
    const bridge = await startBridge({ token: null, validProof: false });
    process.env.AGY_BRIDGE_PORT = String(bridge.port);
    const mod = (await import('../plugins/agy-bridge-v2')) as Record<string, any>;
    expect(Object.keys(mod)).toEqual(['default']);
    expect(mod.default.id).toBe('agy-bridge');
    expect(typeof mod.default.setup).toBe('function');
  });

  it('registers one model per family with variants and migrates the V1 surface', async () => {
    const bridge = await startBridge({ token: null, validProof: false });
    const plugin = await loadV2(bridge.port);
    const fake = makeContext();
    const cleanup = await plugin.setup(fake.ctx);
    cleanups.push(cleanup);

    expect(fake.transforms).toHaveLength(1);
    const added: any[] = [];
    fake.transforms[0]({
      get: () => undefined,
      add: (input: any) => added.push(input),
      models: { set: () => undefined },
    });
    expect(added).toHaveLength(1);
    expect(added[0].info).toMatchObject({
      id: 'agy-bridge',
      name: 'Antigravity (agy local)',
      activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${bridge.port}/v1` },
    });
    expect(added[0].models).toHaveLength(7);
    const flash = added[0].models.find((model: any) => model.modelID === 'gemini-3.8-flash');
    expect(flash).toMatchObject({
      id: 'gemini-3.8-flash',
      providerID: 'agy-bridge',
      name: 'Gemini 3.8 Flash',
      limit: { context: 1_048_576, output: 65_536 },
      capabilities: { tools: true },
    });
    expect(flash?.variants).toEqual([
      { id: 'low', settings: { reasoningEffort: 'low' } },
      { id: 'medium', settings: { reasoningEffort: 'medium' } },
      { id: 'high', settings: { reasoningEffort: 'high' } },
    ]);
    const gpt = added[0].models.find((model: any) => model.modelID === 'gpt-oss-120b');
    expect(gpt).toMatchObject({ settings: { reasoningEffort: 'medium' }, variants: [] });
    expect(added[0].models.some((model: any) => model.modelID === 'gemini-3.8-flash-low')).toBe(false);

    // Existing V1 surface: legacy per-effort ids are removed, the base model
    // keeps user fields and gets variants, unknown models are preserved.
    const legacy = { modelID: 'gemini-3.8-flash-low', name: 'Old low' };
    const base = { modelID: 'gemini-3.8-flash', name: 'My flash', limit: { context: 123, output: 45 } };
    const userModel = { modelID: 'my-custom-model', name: 'Mine' };
    let setModels: any[] | undefined;
    fake.transforms[0]({
      get: () => ({ models: new Map([legacy, base, userModel].map((model) => [model.modelID, model])) }),
      add: () => {
        throw new Error('add must not run when the provider exists');
      },
      models: {
        set: (_providerID: string, models: any[]) => {
          setModels = models;
        },
      },
    });
    expect(setModels).toHaveLength(8); // 7 base models + the user model
    expect(setModels?.map((model) => model.modelID)).not.toContain('gemini-3.8-flash-low');
    expect(setModels?.map((model) => model.modelID)).toContain('my-custom-model');
    const migrated = setModels?.find((model) => model.modelID === 'gemini-3.8-flash');
    expect(migrated).toMatchObject({ name: 'My flash', limit: { context: 123, output: 45 } });
    expect(migrated?.variants).toHaveLength(3);
    expect(setModels?.find((model) => model.modelID === 'my-custom-model')).toBe(userModel);

    // Fully migrated provider: no inventory rewrite (stable transform).
    let rewrites = 0;
    const all = new Map(added[0].models.map((model: any) => [model.modelID, model]));
    fake.transforms[0]({
      get: () => ({ models: all }),
      add: () => {
        throw new Error('add must not run when the provider exists');
      },
      models: {
        set: () => {
          rewrites += 1;
        },
      },
    });
    expect(rewrites).toBe(0);
  });

  it('hides the legacy per-effort ids from the active model collection', async () => {
    const bridge = await startBridge({ token: null, validProof: false });
    const plugin = await loadV2(bridge.port);
    const fake = makeContext();
    const cleanup = await plugin.setup(fake.ctx);
    cleanups.push(cleanup);

    expect(fake.modelTransforms).toHaveLength(1);
    const removed: string[] = [];
    fake.modelTransforms[0]({
      get: (_providerID: string, modelID: string) => ({ modelID }),
      remove: (_providerID: string, modelID: string) => {
        removed.push(modelID);
      },
    });
    expect(removed).toHaveLength(12);
    expect(removed).toContain('gemini-3.8-flash-low');
    expect(removed).toContain('gpt-oss-120b-medium');
    expect(removed).not.toContain('gemini-3.8-flash');
  });

  it('does not send the token or kill a pid reported by an unverified listener', async () => {
    const victim = startVictim();
    const token = await loadOrCreateToken(join(root, 'home', 'token'));
    const bridge = await startBridge({ token, validProof: false, pid: victim.pid, inflight: 0 });
    const plugin = await loadV2(bridge.port);
    const fake = makeContext();
    const cleanup = await plugin.setup(fake.ctx);
    cleanups.push(cleanup);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(isAlive(victim.pid as number)).toBe(true);
    const event = { sessionID: 'ses_1', agent: 'build', model: {}, kind: 'primary', headers: {} as Record<string, string> };
    await fake.hooks.get('model.request')?.(event);
    expect(event.headers['x-agy-session-id']).toBe('ses_1');
    expect(event.headers['x-agy-agent']).toBe('build');
    expect(event.headers['x-agy-client-instance']).toBeTruthy();
    expect(event.headers['x-agy-protocol-version']).toBe('1');
    expect(event.headers['x-agy-token']).toBeUndefined();
  });

  it('sends the token after the listener proves it knows it', async () => {
    const token = await loadOrCreateToken(join(root, 'home', 'token'));
    const bridge = await startBridge({ token, validProof: true, inflight: 1 });
    const plugin = await loadV2(bridge.port);
    const fake = makeContext();
    const cleanup = await plugin.setup(fake.ctx);
    cleanups.push(cleanup);

    const event = { sessionID: 'ses_1', agent: 'build', model: {}, kind: 'primary', headers: {} as Record<string, string> };
    await fake.hooks.get('model.request')?.(event);
    expect(event.headers['x-agy-token']).toBe(token);
  });

  it('caches the prompt messageID and injects it on the model request', async () => {
    const token = await loadOrCreateToken(join(root, 'home', 'token'));
    const bridge = await startBridge({ token, validProof: true, inflight: 1 });
    const plugin = await loadV2(bridge.port);
    const fake = makeContext();
    const cleanup = await plugin.setup(fake.ctx);
    cleanups.push(cleanup);

    await fake.hooks.get('prompt')?.({ sessionID: 'ses_1', messageID: 'msg_user_1', prompt: { text: 'hi' } });
    const event = { sessionID: 'ses_1', agent: 'build', model: {}, kind: 'primary', headers: {} as Record<string, string> };
    await fake.hooks.get('model.request')?.(event);
    expect(event.headers['x-agy-message-id']).toBe('msg_user_1');
  });

  it('tracks subagent parents and posts a tombstone on session deletion', async () => {
    const token = await loadOrCreateToken(join(root, 'home', 'token'));
    const bridge = await startBridge({ token, validProof: true, inflight: 1 });
    const plugin = await loadV2(bridge.port);
    const fake = makeContext();
    const cleanup = await plugin.setup(fake.ctx);
    cleanups.push(cleanup);

    fake.push({
      type: 'session.created',
      data: { sessionID: 'ses_child', parentID: 'ses_parent', location: { directory: 'C:/project' } },
    });
    await waitFor(() => fake.signal() !== undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const event = { sessionID: 'ses_child', agent: 'build', model: {}, kind: 'primary', headers: {} as Record<string, string> };
    await fake.hooks.get('model.request')?.(event);
    expect(event.headers['x-agy-parent-session-id']).toBe('ses_parent');

    fake.push({
      type: 'session.deleted',
      data: { sessionID: 'ses_child', location: { directory: 'C:/project' } },
    });
    fake.push({
      type: 'session.deleted',
      data: { sessionID: 'ses_other', location: { directory: 'D:/elsewhere' } },
    });
    await waitFor(() => bridge.requests.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.requests).toHaveLength(1);
    const tombstone = bridge.requests[0];
    expect(tombstone.url).toBe('/v1/__session/tombstone');
    expect(tombstone.method).toBe('POST');
    expect(JSON.parse(tombstone.body)).toEqual({ sessionId: 'ses_child' });
    expect(tombstone.headers['x-agy-token']).toBe(token);
  });

  it('aborts the event subscription on cleanup', async () => {
    const token = await loadOrCreateToken(join(root, 'home', 'token'));
    const bridge = await startBridge({ token, validProof: true, inflight: 1 });
    const plugin = await loadV2(bridge.port);
    const fake = makeContext();
    const cleanup = await plugin.setup(fake.ctx);
    await waitFor(() => fake.signal() !== undefined);
    await cleanup();
    expect(fake.signal()?.aborted).toBe(true);
    expect(fake.hooks.size).toBe(0);
  });

  it('survives a missing daemon binary without an unhandled spawn error', async () => {
    process.env.AGY_BRIDGE_SPAWN_POLL_MS = '5';
    process.env.AGY_BRIDGE_SPAWN_ATTEMPTS = '1';
    process.env.AGY_BRIDGE_NODE = join(root, 'no-such-node');
    vi.resetModules();
    const plugin = await loadV2(1);
    const fake = makeContext();
    const cleanup = await plugin.setup(fake.ctx);
    expect(typeof cleanup).toBe('function');
    await cleanup();
  });

  it('never throws when the V2 domains fail during setup', async () => {
    const bridge = await startBridge({ token: null, validProof: false });
    const plugin = await loadV2(bridge.port);
    const broken = {
      location: { directory: 'C:/project' },
      session: {
        hook: async () => {
          throw new Error('hook registration failed');
        },
      },
      provider: {
        transform: async () => {
          throw new Error('transform registration failed');
        },
      },
      event: {
        subscribe: () => {
          throw new Error('subscribe failed');
        },
      },
    };
    const cleanup = await plugin.setup(broken);
    expect(typeof cleanup).toBe('function');
    await cleanup();
  });
});
