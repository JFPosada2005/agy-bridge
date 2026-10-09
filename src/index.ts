// Bridge entrypoint: start the Fastify app on 127.0.0.1 and report status.

import { getAgyStatus } from './agy';
import { buildApp, DEFAULT_PORT } from './server';

async function main(): Promise<void> {
  const port = Number(process.env.AGY_BRIDGE_PORT ?? DEFAULT_PORT) || DEFAULT_PORT;
  const host = '127.0.0.1';
  const app = buildApp();

  const shutdown = async (): Promise<void> => {
    // T18: warm lanes must not outlive the daemon.
    try {
      const { destroyAllWarmLanes } = await import('./server');
      destroyAllWarmLanes();
    } catch {
      // Defensive: shutdown must never block on lane cleanup.
    }
    try {
      await app.close();
    } catch {
      // Best effort; the process is exiting anyway.
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    await app.listen({ host, port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EADDRINUSE') {
      // Another (already-healthy) daemon is serving the port: plugin-spawned
      // duplicates and manual double-starts must bow out, not crash-loop.
      console.error(
        `agy-bridge: port ${port} is already in use; assume an existing bridge is serving it. Exiting without error.`,
      );
      process.exit(0);
    }
    console.error(`agy-bridge: failed to listen on ${host}:${port}: ${(err as Error).message}`);
    process.exit(1);
  }

  const status = getAgyStatus();
  console.log(`agy-bridge listening on http://${host}:${port}`);
  console.log(`agy-bridge: agy binary: ${status.binaryPath}`);
  if (status.reachable) {
    console.log(
      `agy-bridge: agy reachable${status.version ? ` (version: ${status.version})` : ''}${status.warning ? `; note: ${status.warning}` : ''}`,
    );
  } else {
    console.log(`agy-bridge: WARNING: ${status.warning ?? 'agy is not reachable yet'}`);
  }

  // T13: reconcile orphan inflight markers left by a dead daemon instance
  // (kill its agy processes, dirty their branches). Runs AFTER listen so a
  // healthy daemon is already serving while the sweep works; never blocks.
  try {
    const { reconcileOrphanMarkers } = await import('./orphans');
    const summary = await reconcileOrphanMarkers();
    if (
      summary.markersInspected > 0 &&
      (summary.killed.length > 0 || summary.alreadyDead.length > 0 || summary.dirtyBranches.length > 0)
    ) {
      console.log(
        `agy-bridge: orphan reconcile: ${summary.markersInspected} markers, ` +
          `killed [${summary.killed.join(', ') || '-'}], dead [${summary.alreadyDead.join(', ') || '-'}], ` +
          `dirty branches ${summary.dirtyBranches.length}`,
      );
    }
  } catch (err) {
    console.error(`agy-bridge: orphan reconcile failed: ${(err as Error).message}`);
  }

  // T15: GC tombstoned session records older than the grace period.
  try {
    const { gcTombstones } = await import('./orphans');
    const gc = gcTombstones();
    if (gc.deleted.length > 0) {
      console.log(`agy-bridge: gc tombstones: deleted ${gc.deleted.join(', ')}`);
    }
  } catch (err) {
    console.error(`agy-bridge: gc tombstones failed: ${(err as Error).message}`);
  }
}

void main();
