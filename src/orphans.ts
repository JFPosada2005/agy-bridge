// T13 (Fase 2): orphan reconcile sweep.
//
// Inflight markers are written store-first BEFORE every agy spawn and
// removed on confirmed success. When the daemon dies mid-turn (crash, kill,
// power loss), its markers stay on disk and the agy processes it spawned
// keep running — burning plan quota with nobody to receive their output.
//
// This sweep runs at daemon startup: every marker whose bootId differs from
// the CURRENT boot belongs to a dead daemon instance. Its pid is verified
// against the live process table (image name `agy.exe` + creation time not
// older than the marker) before any kill, so a recycled PID can never be
// murdered. Verified orphans are killed (process tree), the branch is
// marked dirty (the turn never completed; the next request repairs it) and
// the marker is removed. Markers from the current boot are left alone: the
// daemon may legitimately have turns in flight.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  getBootId,
  loadSessionRecord,
  saveSessionRecord,
  sessionsDir,
  type SessionRecord,
} from './sessionStore';
import { markBranchDirty } from './sessionManager';

export interface OrphanReconcileOptions {
  /** Defaults to this process's boot id. */
  currentBootId?: string;
  /** Live agy process table: pid -> creation time (ISO). Injected for tests. */
  listAgyProcesses?: () => Promise<Map<number, string>>;
  /** Kill helper (process tree). Injected for tests. */
  killProcess?: (pid: number) => Promise<void>;
}

export interface OrphanReconcileSummary {
  recordsInspected: number;
  markersInspected: number;
  /** Markers from the current boot: in-flight or ours, never touched. */
  ownBootMarkers: number;
  /** Pids verified as live agy orphans and killed. */
  killed: number[];
  /** Pids recorded but no longer running: nothing to kill. */
  alreadyDead: number[];
  /** Pids present but NOT verified (recycled-PID suspicion): not killed. */
  unverified: number[];
  dirtyBranches: Array<{ sessionID: string; branchID: string }>;
}

function loud(message: string): void {
  try {
    console.error(`agy-bridge orphans: ${message}`);
  } catch {
    // Logging must never break startup.
  }
}

/** Kill a process tree by pid (Windows). Never throws. */
function defaultKillProcess(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
  });
}

/**
 * Live agy processes on Windows: pid -> creation time (ISO). A single
 * PowerShell call per reconcile sweep. Errors yield an EMPTY map (sweep
 * still marks branches dirty and drops markers; it just kills nothing).
 */
async function defaultListAgyProcesses(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  await new Promise<void>((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-Process -Name agy -ErrorAction SilentlyContinue | " +
          "ForEach-Object { \"$($_.Id)|$($_.StartTime.ToUniversalTime().ToString('o'))\" }",
      ],
      (err, stdout) => {
        if (!err && typeof stdout === 'string') {
          for (const line of stdout.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const sep = trimmed.indexOf('|');
            if (sep <= 0) continue;
            const pid = Number(trimmed.slice(0, sep));
            const startedAt = trimmed.slice(sep + 1);
            if (Number.isInteger(pid) && pid > 0 && startedAt) {
              map.set(pid, startedAt);
            }
          }
        }
        resolve();
      },
    );
  });
  return map;
}

/** True when the process creation time is at/after the marker was written. */
export function pidMatchesMarker(
  creationIso: string,
  markerStartedAtIso: string,
): boolean {
  const creation = Date.parse(creationIso);
  const started = Date.parse(markerStartedAtIso);
  if (!Number.isFinite(creation) || !Number.isFinite(started)) {
    return false;
  }
  // Marker is written just BEFORE the spawn, so a legitimate orphan's
  // creation time is >= the marker (small tolerance for timer granularity).
  // Anything created more than ~250ms before the marker cannot be the turn
  // this marker describes — treat it as a recycled PID.
  return creation >= started - 250;
}

// ---------------------------------------------------------------------------
// T15: GC of tombstoned sessions.
//
// A tombstoned record (session.deleted from the plugin) stays on disk with
// a grace period so a late retry or an import on another machine can still
// revive it via ledger authority. After the grace expires the file is
// deleted. agy's own conversation store is NEVER touched — agy conversations
// simply become unreferenced and age out of agy's own retention.
// ---------------------------------------------------------------------------

/** Default grace before a tombstoned record is GC'd: 7 days. */
export const TOMBSTONE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface GcSummary {
  filesInspected: number;
  tombstonesSeen: number;
  deleted: string[];
  keptLive: number;
  keptWithinGrace: number;
}

/** Delete tombstoned session record files older than the grace period. */
export function gcTombstones(options: {
  now?: Date;
  graceMs?: number;
  deleteFile?: (path: string) => void;
} = {}): GcSummary {
  const now = options.now ?? new Date();
  const graceMs = options.graceMs ?? TOMBSTONE_GRACE_MS;
  const deleteFile = options.deleteFile ?? ((p: string) => fs.rmSync(p, { force: true }));
  const summary: GcSummary = {
    filesInspected: 0,
    tombstonesSeen: 0,
    deleted: [],
    keptLive: 0,
    keptWithinGrace: 0,
  };

  let recordFiles: string[] = [];
  try {
    recordFiles = fs
      .readdirSync(sessionsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(sessionsDir(), f));
  } catch {
    return summary; // No sessions dir yet.
  }

  for (const file of recordFiles) {
    summary.filesInspected += 1;
    let tombstonedAt: string | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      if (typeof raw['tombstonedAt'] === 'string') {
        tombstonedAt = raw['tombstonedAt'];
      }
    } catch {
      summary.keptLive += 1; // Unparsable: storage guard owns quarantine, not GC.
      continue;
    }
    if (!tombstonedAt) {
      summary.keptLive += 1;
      continue;
    }
    summary.tombstonesSeen += 1;
    const age = now.getTime() - (Date.parse(tombstonedAt) || 0);
    if (age >= graceMs) {
      try {
        deleteFile(file);
        summary.deleted.push(path.basename(file));
      } catch (err) {
        loud(`cannot GC ${file}: ${(err as Error).message}`);
        summary.keptWithinGrace += 1;
      }
    } else {
      summary.keptWithinGrace += 1;
    }
  }
  return summary;
}

/** Reconcile every foreign-boot inflight marker across the registry. */
export async function reconcileOrphanMarkers(
  options: OrphanReconcileOptions = {},
): Promise<OrphanReconcileSummary> {
  const currentBootId = options.currentBootId ?? getBootId();
  const listAgyProcesses = options.listAgyProcesses ?? defaultListAgyProcesses;
  const killProcess = options.killProcess ?? defaultKillProcess;

  const summary: OrphanReconcileSummary = {
    recordsInspected: 0,
    markersInspected: 0,
    ownBootMarkers: 0,
    killed: [],
    alreadyDead: [],
    unverified: [],
    dirtyBranches: [],
  };

  let recordFiles: string[] = [];
  try {
    recordFiles = fs
      .readdirSync(sessionsDir())
      .filter((f) => f.endsWith('.json'));
  } catch {
    return summary; // No sessions dir yet: nothing to reconcile.
  }

  for (const file of recordFiles) {
    const sessionID = path.basename(file, '.json');
    let record: SessionRecord;
    try {
      record = loadSessionRecord(sessionID);
    } catch {
      continue; // Quarantined/corrupt: storage guard already logged loud.
    }
    summary.recordsInspected += 1;
    if (record.inflightMarkers.length === 0) {
      continue;
    }

    const live = await listAgyProcesses();
    const remaining: typeof record.inflightMarkers = [];
    for (const marker of record.inflightMarkers) {
      summary.markersInspected += 1;
      if (marker.bootId === currentBootId) {
        summary.ownBootMarkers += 1;
        remaining.push(marker);
        continue;
      }

      // Foreign boot: this turn never completed. Branch is dirty either way.
      const branch = record.branches.find((b) => b.branchID === marker.branchID);
      if (branch && !branch.dirty) {
        markBranchDirty(branch);
        summary.dirtyBranches.push({ sessionID, branchID: marker.branchID });
      }

      const pid = marker.pid;
      if (typeof pid !== 'number' || pid <= 0) {
        loud(`session ${sessionID} marker without pid; branch ${marker.branchID} marked dirty`);
        continue; // Marker dropped (not re-added).
      }
      const creation = live.get(pid);
      if (creation === undefined) {
        summary.alreadyDead.push(pid);
        continue; // Process gone; marker dropped.
      }
      if (!pidMatchesMarker(creation, marker.startedAt)) {
        summary.unverified.push(pid);
        loud(
          `session ${sessionID} pid ${pid} exists but predates its marker ` +
            `(${creation} < ${marker.startedAt}); NOT killing (recycled-PID guard)`,
        );
        continue; // Marker dropped; the unverified process is left alone.
      }
      await killProcess(pid);
      summary.killed.push(pid);
      loud(`killed orphan agy pid ${pid} (session ${sessionID}, branch ${marker.branchID})`);
    }

    if (remaining.length !== record.inflightMarkers.length) {
      record.inflightMarkers = remaining;
      saveSessionRecord(record);
    }
  }
  return summary;
}
