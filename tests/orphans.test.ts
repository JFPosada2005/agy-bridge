import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gcTombstones,
  reconcileOrphanMarkers,
  pidMatchesMarker,
  TOMBSTONE_GRACE_MS,
} from '../src/orphans';
import { freshSessionRecord, saveSessionRecord, loadSessionRecord, sessionsDir } from '../src/sessionStore';

const MY_BOOT = 'boot_current';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agy-bridge-orphans-'));
  process.env.AGY_BRIDGE_HOME = dir;
});

afterEach(() => {
  delete process.env.AGY_BRIDGE_HOME;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup.
  }
});

function seed(sessionID: string, markers: unknown[]): void {
  const record = freshSessionRecord(sessionID);
  record.activeBranchID = 'br_a';
  record.branches = [
    {
      branchID: 'br_a',
      agyConversationID: 'conv-1',
      agyVersion: null,
      modelFamily: 'gemini',
      effort: 'low',
      epoch: 0,
      origin: 'initial',
      ledger: [],
      updatedAt: new Date().toISOString(),
    },
  ];
  record.inflightMarkers = markers as typeof record.inflightMarkers;
  saveSessionRecord(record);
}

describe('reconcileOrphanMarkers (injected process table, zero live agy)', () => {
  it('kills a verified live orphan and marks the branch dirty', async () => {
    seed('ses-1', [
      { bootId: 'boot_dead', branchID: 'br_a', deltaDigest: 'd1', pid: 4242, startedAt: '2026-10-08T10:00:00Z' },
    ]);
    const killed: number[] = [];
    const summary = await reconcileOrphanMarkers({
      currentBootId: MY_BOOT,
      listAgyProcesses: async () => new Map([[4242, '2026-10-08T10:00:02Z']]),
      killProcess: async (pid) => {
        killed.push(pid);
      },
    });
    expect(summary.killed).toEqual([4242]);
    expect(summary.dirtyBranches).toEqual([{ sessionID: 'ses-1', branchID: 'br_a' }]);
    const record = loadSessionRecord('ses-1');
    expect(record.inflightMarkers).toHaveLength(0);
    expect(record.branches[0]?.dirty).toBe(true);
    await expect(killed).toEqual([4242]);
  });

  it('records an already-dead orphan pid without killing anything', async () => {
    seed('ses-2', [
      { bootId: 'boot_dead', branchID: 'br_a', deltaDigest: 'd1', pid: 1111, startedAt: '2026-10-08T10:00:00Z' },
    ]);
    let killCalls = 0;
    const summary = await reconcileOrphanMarkers({
      currentBootId: MY_BOOT,
      listAgyProcesses: async () => new Map(), // no agy running
      killProcess: async () => {
        killCalls += 1;
      },
    });
    expect(summary.alreadyDead).toEqual([1111]);
    expect(killCalls).toBe(0);
    expect(loadSessionRecord('ses-2').inflightMarkers).toHaveLength(0);
  });

  it('refuses to kill a pid whose creation predates the marker (recycled-PID guard)', async () => {
    seed('ses-3', [
      { bootId: 'boot_dead', branchID: 'br_a', deltaDigest: 'd1', pid: 5555, startedAt: '2026-10-08T10:00:00Z' },
    ]);
    let killCalls = 0;
    const summary = await reconcileOrphanMarkers({
      currentBootId: MY_BOOT,
      // Process exists but was created BEFORE the marker: cannot be our orphan.
      listAgyProcesses: async () => new Map([[5555, '2026-10-08T09:00:00Z']]),
      killProcess: async () => {
        killCalls += 1;
      },
    });
    expect(summary.unverified).toEqual([5555]);
    expect(summary.killed).toEqual([]);
    expect(killCalls).toBe(0);
    expect(loadSessionRecord('ses-3').inflightMarkers).toHaveLength(0);
    expect(loadSessionRecord('ses-3').branches[0]?.dirty).toBe(true);
  });

  it('leaves current-boot markers alone (daemon may have turns in flight)', async () => {
    seed('ses-4', [
      { bootId: MY_BOOT, branchID: 'br_a', deltaDigest: 'd1', pid: 9999, startedAt: '2026-10-08T10:00:00Z' },
    ]);
    let killCalls = 0;
    const summary = await reconcileOrphanMarkers({
      currentBootId: MY_BOOT,
      listAgyProcesses: async () => new Map([[9999, '2026-10-08T10:00:01Z']]),
      killProcess: async () => {
        killCalls += 1;
      },
    });
    expect(summary.ownBootMarkers).toBe(1);
    expect(summary.killed).toEqual([]);
    expect(killCalls).toBe(0);
    const record = loadSessionRecord('ses-4');
    expect(record.inflightMarkers).toHaveLength(1); // untouched
    expect(record.branches[0]?.dirty).toBeFalsy();
  });

  it('marks the branch dirty and drops a foreign marker without pid', async () => {
    seed('ses-5', [{ bootId: 'boot_dead', branchID: 'br_a', deltaDigest: 'd1' }]);
    const summary = await reconcileOrphanMarkers({
      currentBootId: MY_BOOT,
      listAgyProcesses: async () => new Map(),
      killProcess: async () => {},
    });
    expect(summary.killed).toEqual([]);
    expect(loadSessionRecord('ses-5').inflightMarkers).toHaveLength(0);
    expect(loadSessionRecord('ses-5').branches[0]?.dirty).toBe(true);
  });

  it('returns a clean empty summary when the registry is empty', async () => {
    const summary = await reconcileOrphanMarkers({
      currentBootId: MY_BOOT,
      listAgyProcesses: async () => new Map(),
      killProcess: async () => {},
    });
    expect(summary.recordsInspected).toBe(0);
    expect(summary.markersInspected).toBe(0);
  });
});

describe('pidMatchesMarker', () => {
  it('accepts creation at/after the marker with tiny clock tolerance', () => {
    // Creation 1s BEFORE the marker: recycled PID, rejected.
    expect(pidMatchesMarker('2026-10-08T10:00:00Z', '2026-10-08T10:00:01Z')).toBe(false);
    // Creation 100ms BEFORE the marker: within tolerance.
    expect(pidMatchesMarker('2026-10-08T09:59:59.900Z', '2026-10-08T10:00:00Z')).toBe(true);
    expect(pidMatchesMarker('2026-10-08T10:00:02Z', '2026-10-08T10:00:00Z')).toBe(true);
  });

  it('rejects unparsable timestamps', () => {
    expect(pidMatchesMarker('not-a-date', '2026-10-08T10:00:00Z')).toBe(false);
    expect(pidMatchesMarker('2026-10-08T10:00:00Z', 'garbage')).toBe(false);
  });
});

describe('gcTombstones (T15)', () => {
  it('deletes only tombstoned records older than the grace period', () => {
    const now = new Date('2026-10-08T12:00:00Z');
    const old = new Date(now.getTime() - TOMBSTONE_GRACE_MS - 1000).toISOString();
    const recent = new Date(now.getTime() - 60_000).toISOString();

    const live = freshSessionRecord('ses-live');
    saveSessionRecord(live);
    const tombOld = freshSessionRecord('ses-old');
    tombOld.tombstonedAt = old;
    saveSessionRecord(tombOld);
    const tombRecent = freshSessionRecord('ses-recent');
    tombRecent.tombstonedAt = recent;
    saveSessionRecord(tombRecent);

    const summary = gcTombstones({ now });
    expect(summary.deleted.sort()).toEqual(['ses-old.json']);
    expect(summary.tombstonesSeen).toBe(2);
    expect(summary.keptWithinGrace).toBe(1);
    expect(summary.keptLive).toBe(1);
    expect(existsSync(join(sessionsDir(), 'ses-old.json'))).toBe(false);
    expect(existsSync(join(sessionsDir(), 'ses-recent.json'))).toBe(true);
    expect(existsSync(join(sessionsDir(), 'ses-live.json'))).toBe(true);
  });

  it('keeps unparsable files (storage guard owns quarantine, not GC)', () => {
    mkdirSync(sessionsDir(), { recursive: true });
    writeFileSync(join(sessionsDir(), 'ses-bad.json'), '{not json', 'utf8');
    const summary = gcTombstones({ now: new Date('2026-10-08T12:00:00Z') });
    expect(summary.keptLive).toBe(1);
    expect(summary.deleted).toEqual([]);
  });
});
