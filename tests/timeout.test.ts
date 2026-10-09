import { describe, expect, it } from 'vitest';
import { AgyAbortedError, AgyTimeoutError, resolveAgyBinary, runAgyTurn } from '../src/agy';

describe('resolveAgyBinary', () => {
  it('honors the AGY_BIN override', () => {
    const previous = process.env.AGY_BIN;
    process.env.AGY_BIN = 'C:\\custom\\agy.exe';
    try {
      expect(resolveAgyBinary()).toBe('C:\\custom\\agy.exe');
    } finally {
      if (previous === undefined) {
        delete process.env.AGY_BIN;
      } else {
        process.env.AGY_BIN = previous;
      }
    }
  });

  it('defaults to the official install location', () => {
    const previous = process.env.AGY_BIN;
    delete process.env.AGY_BIN;
    try {
      expect(resolveAgyBinary().toLowerCase()).toContain('agy');
    } finally {
      if (previous !== undefined) {
        process.env.AGY_BIN = previous;
      }
    }
  });
});

describe('runAgyTurn timeout', () => {
  it('kills a long-running command after the timeout (no real agy call)', async () => {
    const sleepMs = 30_000;
    await expect(
      runAgyTurn({
        model: 'fake-model',
        effort: null,
        prompt: 'hello',
        timeoutMs: 400,
        binaryPath: process.execPath,
        commandOverride: { cmd: process.execPath, args: ['-e', `setTimeout(()=>{}, ${sleepMs})`] },
      }),
    ).rejects.toBeInstanceOf(AgyTimeoutError);
  }, 15_000);

  it('kills the command when the client signal aborts (user interrupt / disconnect)', async () => {
    const sleepMs = 30_000;
    const controller = new AbortController();
    const pending = runAgyTurn({
      model: 'fake-model',
      effort: null,
      prompt: 'hello',
      binaryPath: process.execPath,
      signal: controller.signal,
      commandOverride: { cmd: process.execPath, args: ['-e', `setTimeout(()=>{}, ${sleepMs})`] },
    });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toBeInstanceOf(AgyAbortedError);
  }, 15_000);

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgyTurn({
        model: 'fake-model',
        effort: null,
        prompt: 'hello',
        binaryPath: process.execPath,
        signal: controller.signal,
        commandOverride: { cmd: process.execPath, args: ['-e', 'setTimeout(()=>{}, 30000)'] },
      }),
    ).rejects.toBeInstanceOf(AgyAbortedError);
  }, 15_000);
});
