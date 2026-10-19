import { describe, expect, it } from 'vitest';
import {
  MODELS,
  detectFamily,
  findModel,
  parseEffort,
  toOpenAIModelList,
} from '../src/catalog';

describe('parseEffort', () => {
  it.each([
    ['gemini-3.6-flash-low', 'gemini-3.6-flash', 'low'],
    ['gemini-3.8-flash-medium', 'gemini-3.8-flash', 'medium'],
    ['gemini-3.1-pro-high', 'gemini-3.1-pro', 'high'],
    ['gpt-oss-120b-medium', 'gpt-oss-120b', 'medium'],
  ])('%s -> base %s effort %s', (id, baseModel, effort) => {
    expect(parseEffort(id)).toEqual({ baseModel, effort });
  });

  it('returns null effort for ids without a suffix', () => {
    expect(parseEffort('claude-sonnet-4-6')).toEqual({ baseModel: 'claude-sonnet-4-6', effort: null });
    expect(parseEffort('claude-opus-4-6-thinking')).toEqual({
      baseModel: 'claude-opus-4-6-thinking',
      effort: null,
    });
  });
});

describe('detectFamily', () => {
  it('maps provider families', () => {
    expect(detectFamily('gemini-3.6-flash-low')).toBe('gemini');
    expect(detectFamily('claude-sonnet-4-6')).toBe('claude');
    expect(detectFamily('gpt-oss-120b-medium')).toBe('gpt');
    expect(detectFamily('mystery-1')).toBe('unknown');
  });
});

describe('catalog', () => {
  it('lists one entry per model family (7 entries)', () => {
    expect(MODELS).toHaveLength(7);
    expect(MODELS.map((entry) => entry.id)).toContain('gemini-3.6-flash');
    expect(MODELS.map((entry) => entry.id)).not.toContain('gemini-3.6-flash-low');
  });

  it('declares the efforts each family accepts and its default', () => {
    const flash = findModel('gemini-3.8-flash');
    expect(flash?.efforts).toEqual(['low', 'medium', 'high']);
    expect(flash?.defaultEffort).toBeNull();
    const pro = findModel('gemini-3.1-pro');
    expect(pro?.efforts).toEqual(['low', 'high']);
    const gpt = findModel('gpt-oss-120b');
    expect(gpt?.efforts).toEqual(['medium']);
    expect(gpt?.defaultEffort).toBe('medium');
    const claude = findModel('claude-sonnet-4-6');
    expect(claude?.efforts).toEqual([]);
    expect(claude?.defaultEffort).toBeNull();
  });

  it('declares 1M context for gemini and conservative limits elsewhere', () => {
    const flash = findModel('gemini-3.6-flash-low');
    expect(flash?.contextWindow).toBe(1_000_000);
    const claude = findModel('claude-sonnet-4-6');
    expect(claude?.contextWindow).toBe(200_000);
  });

  it('toOpenAIModelList returns the OpenAI shape with base ids', () => {
    const listing = toOpenAIModelList();
    expect(listing.object).toBe('list');
    expect(listing.data).toHaveLength(7);
    expect(listing.data.map((entry) => entry.id)).toContain('gemini-3.8-flash');
    for (const model of listing.data) {
      expect(model.object).toBe('model');
      expect(typeof model.id).toBe('string');
    }
  });
});
