import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Telemetry hygiene for the vitest suite: the daemon defaults its request log
// to <agy-bridge-home>/bridge.log when AGY_BRIDGE_LOG is unset, and several
// test files fire logged requests without caring about the file target.
// Route every suite's stray file writes to a per-process temp file so nothing
// ever touches the real ~/.agy-bridge/bridge.log. The one-off temp dir is
// intentionally not cleaned in afterAll: setup files run before every test
// file, so cleanup would strand later files mid-write.
process.env.AGY_BRIDGE_LOG = join(
  mkdtempSync(join(tmpdir(), 'agy-bridge-test-log-')),
  'bridge.log',
);

// Debug routes are opt-in in production (security audit 2026-10-09); the
// existing E1/T17 tests exercise them, so the suite enables them globally.
// tests/security.test.ts flips this off where it checks the default.
process.env.AGY_BRIDGE_DEBUG = '1';
