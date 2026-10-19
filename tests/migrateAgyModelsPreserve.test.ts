import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'jsonc-parser';
import { migrateConfigText } from '../scripts/migrate-agy-models.mjs';

const wrap = (models: string, indent = '  ') =>
  `{\n${indent}"provider": {\n${indent}${indent}"agy-bridge": {\n${indent}${indent}${indent}"models": {\n${models}\n${indent}${indent}${indent}}\n${indent}${indent}}\n${indent}}\n}\n`;

describe('S14 preservation', () => {
  it('keeps a comment that belongs to a non-legacy model', () => {
    const { text } = migrateConfigText(
      wrap('        "gemini-3.8-flash-low": {},\n        // my model note\n        "my-custom": { "name": "Mine" }'),
    );
    expect(text).toContain('        // my model note');
    expect(text).toContain('"my-custom": { "name": "Mine" }');
    expect(text).not.toContain('gemini-3.8-flash-low');
  });

  it('does not leave a blank line when a removed entry had a comma', () => {
    const { text } = migrateConfigText(
      wrap('        "gemini-3.8-flash-low": {},\n        "keep": {}'),
    );
    expect(text).not.toMatch(/\n[ \t]*\n[ \t]*"keep"/);
    expect(text).toContain('"keep"');
  });

  it('does not reformat a neighbouring inline model', () => {
    const { text } = migrateConfigText(
      wrap('        "my-custom": { "name": "Mine", "limit": { "context": 5, "output": 6 } },\n        "gemini-3.8-flash-low": {}'),
    );
    expect(text).toContain('"my-custom": { "name": "Mine", "limit": { "context": 5, "output": 6 } }');
    expect(text).not.toContain('gemini-3.8-flash-low');
  });

  it('keeps tab indentation', () => {
    const { text } = migrateConfigText(
      wrap('\t\t\t\t"gemini-3.8-flash-low": {},\n\t\t\t\t"keep": {}', '\t'),
    );
    expect(text).not.toMatch(/^ +"/m);
    expect(text).toContain('\t\t\t\t"keep"');
  });

  it('removes duplicate legacy keys in one pass', () => {
    const first = migrateConfigText(
      wrap('        "gemini-3.8-flash-low": { "name": "a" },\n        "gemini-3.8-flash-low": { "name": "b" },\n        "keep": {}'),
    );
    expect(first.text).not.toContain('gemini-3.8-flash-low');
    expect(migrateConfigText(first.text).removed).toBe(0);
  });

  it('migrates duplicate provider blocks (effective last block included)', () => {
    const duplicate = `{
  "provider": { "agy-bridge": { "models": { "gemini-3.8-flash-high": {}, "keep-a": {} } } },
  "provider": { "agy-bridge": { "models": { "gemini-3.8-flash-high": {}, "keep-b": {} } } }
}`;
    const { text, removed } = migrateConfigText(duplicate);
    expect(removed).toBe(2);
    expect(text).not.toContain('gemini-3.8-flash-high');
    expect(text).toContain('keep-a');
    expect(text).toContain('keep-b');
  });

  it('removes the V1 plugin entry from every array form', () => {
    const cases = [
      '{ "plugin": ["engram", "./plugin/agy-bridge.ts"] }',
      '{ "plugin": ["./plugin/agy-bridge.ts", "engram"] }',
      '{ "plugin": ["./plugin/agy-bridge.ts"] }',
      '{ "plugins": ["engram", "./plugin/agy-bridge.ts"] }',
      '{\n  "plugin": [\n    "./plugin/agy-bridge.ts",\n    "engram"\n  ]\n}',
      '{\n  "plugin": [\n    "engram",\n    "./plugin/agy-bridge.ts"\n  ]\n}',
    ];
    for (const source of cases) {
      const result = migrateConfigText(source);
      expect(result.removedPluginEntries).toBe(1);
      expect(result.text).not.toContain('./plugin/agy-bridge.ts');
      expect(() => parse(result.text)).not.toThrow();
    }
  });

  it('keeps a comment that follows the removed plugin entry', () => {
    const source = '{ "plugin": ["engram", "./plugin/agy-bridge.ts"] /* remove me */ }';
    const { text, removedPluginEntries } = migrateConfigText(source);
    expect(removedPluginEntries).toBe(1);
    expect(text).toContain('/* remove me */');
    expect(text).not.toContain('./plugin/agy-bridge.ts');
  });

  it('skips malformed JSONC without changing it', () => {
    const malformed = '{ "provider": { "agy-bridge": { "models": { "gemini-3.8-flash-low": {} } } ';
    const result = migrateConfigText(malformed);
    expect(result.text).toBe(malformed);
    expect(result.removed).toBe(0);
    expect(result.removedPluginEntries).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('CLI: backup equals original, BOM+CRLF kept, unrelated refs/providers untouched, idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-mig-'));
    const file = join(dir, 'opencode.jsonc');
    const src =
      '\uFEFF{\r\n' +
      '  "model": "agy-bridge/gemini-3.8-flash-high",\r\n' +
      '  "plugin": ["engram", "./plugin/agy-bridge.ts"],\r\n' +
      '  "provider": {\r\n' +
      '    "openai": { "models": { "gemini-3.8-flash-low": {} } },\r\n' +
      '    "agy-bridge": { "models": { "gemini-3.8-flash-high": {}, "gemini-3.8-flash": {} } }\r\n' +
      '  }\r\n' +
      '}\r\n';
    writeFileSync(file, src, 'utf8');
    execFileSync(process.execPath, ['scripts/migrate-agy-models.mjs', '--config', file]);
    expect(readFileSync(`${file}.agy-bridge.bak`, 'utf8')).toBe(src);
    const once = readFileSync(file, 'utf8');
    expect(once.startsWith('\uFEFF')).toBe(true);
    expect(once).not.toMatch(/[^\r]\n/);
    expect(once).toContain('"model": "agy-bridge/gemini-3.8-flash-high"');
    expect(once).toContain('"openai": { "models": { "gemini-3.8-flash-low": {} } }');
    expect(once).not.toContain('"gemini-3.8-flash-high": {}');
    expect(once).toContain('"gemini-3.8-flash": {}');
    expect(once).not.toContain('./plugin/agy-bridge.ts');
    expect(once).toContain('"engram"');
    execFileSync(process.execPath, ['scripts/migrate-agy-models.mjs', '--config', file]);
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('CLI: malformed config is not rewritten and gets no backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-mig-'));
    const file = join(dir, 'opencode.json');
    const src = '{ "provider": { "agy-bridge": { "models": { "gemini-3.8-flash-low": {} } } ';
    writeFileSync(file, src, 'utf8');
    const output = execFileSync(process.execPath, ['scripts/migrate-agy-models.mjs', '--config', file], {
      encoding: 'utf8',
    });
    expect(output).toContain('not valid JSONC');
    expect(output).not.toContain('already migrated');
    expect(readFileSync(file, 'utf8')).toBe(src);
    expect(() => readFileSync(`${file}.agy-bridge.bak`, 'utf8')).toThrow();
  });
});
