import { describe, expect, it } from 'vitest';
import { maxPromptCharsFromEnv, trimPromptToBudget } from '../src/server';

describe('trimPromptToBudget', () => {
  it('returns the prompt unchanged when it fits the budget', () => {
    const prompt = 'a'.repeat(1000);
    expect(trimPromptToBudget(prompt, 2000)).toBe(prompt);
  });

  it('drops the middle with a loud omission marker when over budget', () => {
    const head = 'HEAD-MANIFEST-INSTRUCTIONS'.padEnd(500, 'x');
    const middle = 'MIDDLE-HISTORY'.padEnd(5000, 'y');
    const tail = 'TAIL-CURRENT-REQUEST'.padEnd(500, 'z');
    const prompt = head + middle + tail;
    const trimmed = trimPromptToBudget(prompt, 1000);
    expect(trimmed.length).toBeLessThanOrEqual(prompt.length);
    expect(trimmed).toContain(head.slice(0, 100));
    expect(trimmed).toContain(tail.slice(-100));
    expect(trimmed).toContain('agy-bridge dropped');
    expect(trimmed).not.toContain(middle.slice(100, 200));
  });

  it('mentions both budget and original size in the marker', () => {
    const trimmed = trimPromptToBudget('a'.repeat(2000), 1000);
    expect(trimmed).toMatch(/budget 1000 chars, sent 2000/);
  });

  it('reads AGY_MAX_PROMPT_CHARS from the env when set', () => {
    const previous = process.env.AGY_MAX_PROMPT_CHARS;
    process.env.AGY_MAX_PROMPT_CHARS = '1234';
    try {
      expect(maxPromptCharsFromEnv()).toBe(1234);
    } finally {
      if (previous === undefined) {
        delete process.env.AGY_MAX_PROMPT_CHARS;
      } else {
        process.env.AGY_MAX_PROMPT_CHARS = previous;
      }
    }
  });
});
