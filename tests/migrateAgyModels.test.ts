import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { LEGACY_MODEL_IDS, migrateConfigText } from '../scripts/migrate-agy-models.mjs';

const sample = `{
  // keep this comment
  "provider": {
    "agy-bridge": {
      "models": {
        "gemini-3.8-flash-low": {
          "name": "Old low",
          "limit": { "context": 1, "output": 2 }
        },
        "claude-sonnet-4-6": { "name": "Keep" },
        "gemini-3.8-flash": { "name": "Base" }
      }
    }
  },
  "plugin": ["x"]
}`;

describe('migrate-agy-models', () => {
  it('removes legacy entries and keeps comments, other models and unrelated settings', () => {
    const { text, removed } = migrateConfigText(sample);
    expect(removed).toBe(1);
    expect(text).not.toContain('gemini-3.8-flash-low');
    expect(text).toContain('claude-sonnet-4-6');
    expect(text).toContain('gemini-3.8-flash"');
    expect(text).toContain('// keep this comment');
    expect(text).toContain('"plugin"');
    expect(() => parse(text)).not.toThrow();
  });

  it('handles the native V2 providers key', () => {
    const v2 = `{
  "providers": {
    "agy-bridge": {
      "models": {
        "gemini-3.8-flash-high": {},
        "gpt-oss-120b-medium": {},
        "gpt-oss-120b": {}
      }
    }
  }
}`;
    const { text, removed } = migrateConfigText(v2);
    expect(removed).toBe(2);
    expect(text).not.toContain('gemini-3.8-flash-high');
    expect(text).not.toContain('gpt-oss-120b-medium');
    expect(text).toContain('gpt-oss-120b"');
  });

  it('removes every legacy id and is idempotent', () => {
    const all = `{
  "provider": {
    "agy-bridge": {
      "models": {
${LEGACY_MODEL_IDS.map((id) => `        "${id}": {},`).join('\n')}
        "gemini-3.8-flash": {}
      }
    }
  }
}`;
    const first = migrateConfigText(all);
    expect(first.removed).toBe(LEGACY_MODEL_IDS.length);
    expect(first.text).not.toMatch(/gemini-3\.8-flash-high|gpt-oss-120b-medium/);
    expect(first.text).toContain('gemini-3.8-flash"');
    const second = migrateConfigText(first.text);
    expect(second.removed).toBe(0);
    expect(second.text).toBe(first.text);
  });

  it('leaves a config without an agy-bridge provider unchanged', () => {
    const other = '{\n  "provider": { "anthropic": { "models": {} } }\n}';
    const { text, removed } = migrateConfigText(other);
    expect(removed).toBe(0);
    expect(text).toBe(other);
  });
});
