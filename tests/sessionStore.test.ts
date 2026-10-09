import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  agyBridgeHome,
  ensureWorkspaceDir,
  freshSessionRecord,
  getBootId,
  loadSessionRecord,
  saveSessionRecord,
  sessionsDir,
  withSessionLock,
} from '../src/sessionStore';

let dir = '';
const previousHome = process.env.AGY_BRIDGE_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-bridge-store-'));
  process.env.AGY_BRIDGE_HOME = dir;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.AGY_BRIDGE_HOME;
  } else {
    process.env.AGY_BRIDGE_HOME = previousHome;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
});

describe('agyBridgeHome', () => {
  it('honors the AGY_BRIDGE_HOME override', () => {
    expect(agyBridgeHome()).toBe(dir);
    expect(sessionsDir()).toBe(join(dir, 'sessions'));
  });
});

describe('save/load roundtrip', () => {
  it('persists and reloads a record as UTF-8 JSON', () => {
    const record = freshSessionRecord('ses-1', 'ses-parent');
    saveSessionRecord(record);
    const loaded = loadSessionRecord('ses-1');
    expect(loaded.sessionID).toBe('ses-1');
    expect(loaded.parentSessionID).toBe('ses-parent');
    expect(loaded.branches).toEqual([]);
    const raw = readFileSync(join(dir, 'sessions', 'ses-1.json'), 'utf8');
    expect(raw).toContain('"sessionID": "ses-1"');
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('leaves no temp files behind (atomic write)', () => {
    saveSessionRecord(freshSessionRecord('ses-tmp'));
    const files = readdirSync(join(dir, 'sessions'));
    expect(files).toEqual(['ses-tmp.json']);
  });

  it('returns a fresh record for a missing file', () => {
    const loaded = loadSessionRecord('ses-absent');
    expect(loaded.sessionID).toBe('ses-absent');
    expect(loaded.branches).toEqual([]);
  });
});

describe('corrupt quarantine', () => {
  it('quarantines unparsable files and returns a fresh record', () => {
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'sessions', 'ses-bad.json'), '{not json!!!', 'utf8');
    const loaded = loadSessionRecord('ses-bad');
    expect(loaded.sessionID).toBe('ses-bad');
    expect(loaded.branches).toEqual([]);
    const files = readdirSync(join(dir, 'sessions'));
    expect(files.some((name) => name.startsWith('ses-bad.json.corrupt-'))).toBe(true);
    expect(files).not.toContain('ses-bad.json');
  });

  it('rejects shape mismatches (valid JSON, wrong shape)', () => {
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    writeFileSync(join(dir, 'sessions', 'ses-shape.json'), '{"nope": true}', 'utf8');
    const loaded = loadSessionRecord('ses-shape');
    expect(loaded.branches).toEqual([]);
    const files = readdirSync(join(dir, 'sessions'));
    expect(files.some((name) => name.startsWith('ses-shape.json.corrupt-'))).toBe(true);
  });
});

describe('ensureWorkspaceDir', () => {
  it('creates the dedicated workspace dir on demand', () => {
    const created = ensureWorkspaceDir('br_abc123');
    expect(created).toBe(join(dir, 'workspace', 'br_abc123'));
    // Idempotent second call.
    expect(ensureWorkspaceDir('br_abc123')).toBe(created);
  });

  it('sanitizes unsafe keys', () => {
    const created = ensureWorkspaceDir('../../evil!');
    expect(created).toBe(join(dir, 'workspace', '______evil_'));
  });
});

describe('withSessionLock', () => {
  it('serializes work per session id', async () => {
    const order: string[] = [];
    const slow = withSessionLock('ses-x', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push('first');
    });
    const fast = withSessionLock('ses-x', async () => {
      order.push('second');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);
  });

  it('releases the lock when work throws', async () => {
    await expect(
      withSessionLock('ses-y', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await withSessionLock('ses-y', async () => 'ok');
    expect(after).toBe('ok');
  });
});

describe('getBootId', () => {
  it('is stable per process and boot-prefixed', () => {
    expect(getBootId()).toBe(getBootId());
    expect(getBootId().startsWith('boot_')).toBe(true);
  });
});
