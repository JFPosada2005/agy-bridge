import { describe, expect, it } from 'vitest';
import {
  canonicalArgs,
  canonicalJson,
  canonicalMessage,
  canonicalMessages,
  isSystemMessage,
  isWildcardToolOutput,
  ledgerDigests,
  ledgerMessages,
  messageDigests,
  normalizeWhitespace,
  provisionalDigestForResponse,
  sha1Hex,
  systemDigest,
} from '../src/digests';

describe('sha1Hex', () => {
  it('returns lowercase hex sha1', () => {
    expect(sha1Hex('abc')).toMatch(/^[0-9a-f]{40}$/);
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('differs for different inputs', () => {
    expect(sha1Hex('a')).not.toBe(sha1Hex('b'));
  });
});

describe('normalizeWhitespace', () => {
  it('collapses runs and trims', () => {
    expect(normalizeWhitespace('  a   b\n\tc  ')).toBe('a b c');
  });
});

describe('canonicalMessage roles', () => {
  it('prefixes roles so user/assistant swaps never collide', () => {
    expect(canonicalMessage({ role: 'user', content: 'hi' })).toBe('user:hi');
    expect(canonicalMessage({ role: 'assistant', content: 'hi' })).toBe('assistant:hi');
    expect(canonicalMessage({ role: 'user', content: 'hi' })).not.toBe(
      canonicalMessage({ role: 'assistant', content: 'hi' }),
    );
  });

  it('digests empty content as role:(empty), never the empty string', () => {
    expect(canonicalMessage({ role: 'user', content: '   ' })).toBe('user:(empty)');
    expect(canonicalMessage({ role: 'user', content: '' })).toBe('user:(empty)');
    expect(canonicalMessage({ role: 'assistant', content: null })).toBe('assistant:(empty)');
  });

  it('defaults a missing role to user', () => {
    expect(canonicalMessage({ content: 'hi' })).toBe('user:hi');
  });

  it('handles non-record messages', () => {
    expect(canonicalMessage(null)).toBe('unknown:(empty)');
    expect(canonicalMessage('hi')).toBe('unknown:(empty)');
  });

  it('flattens array content parts', () => {
    expect(
      canonicalMessage({
        role: 'user',
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      }),
    ).toBe('user:ab');
  });
});

describe('canonicalMessage system handling', () => {
  it('strips system-reminder blocks', () => {
    const withReminder = canonicalMessage({
      role: 'system',
      content: 'Do X.<system-reminder>transient nudge</system-reminder>',
    });
    expect(withReminder).toBe('system:Do X.');
    expect(withReminder).toBe(canonicalMessage({ role: 'system', content: 'Do X.' }));
  });

  it('strips volatile date lines in system messages only', () => {
    const stripped = canonicalMessage({
      role: 'system',
      content: 'Today is Friday\nDo X.',
    });
    expect(stripped).toBe('system:Do X.');
    // User text keeps its date lines: no false prefix match on echo.
    expect(canonicalMessage({ role: 'user', content: 'Today is Friday' })).toBe(
      'user:Today is Friday',
    );
  });

  it('strips *date and current date variants', () => {
    expect(
      canonicalMessage({ role: 'system', content: '* date: 2026-10-08\nKeep.' }),
    ).toBe('system:Keep.');
    expect(
      canonicalMessage({ role: 'system', content: 'Current date is X\nKeep.' }),
    ).toBe('system:Keep.');
  });
});

describe('canonicalMessage tool handling', () => {
  it('digests tool_calls as name + sorted canonical args', () => {
    const first = canonicalMessage({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"b":1,"a":2}' },
        },
      ],
    });
    const reordered = canonicalMessage({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_9',
          type: 'function',
          function: { name: 'read_file', arguments: { a: 2, b: 1 } },
        },
      ],
    });
    expect(first).toBe(reordered);
    expect(first).toContain('read_file');
  });

  it('ignores volatile tool_call ids so echoes confirm', () => {
    const one = canonicalMessage({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_aaa', type: 'function', function: { name: 'x', arguments: '{}' } },
      ],
    });
    const two = canonicalMessage({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_zzz', type: 'function', function: { name: 'x', arguments: '{}' } },
      ],
    });
    expect(one).toBe(two);
  });

  it('treats pruned/empty tool outputs as wildcards (equal to each other)', () => {
    const empty = canonicalMessage({ role: 'tool', name: 'read_file', content: '' });
    const pruned = canonicalMessage({
      role: 'tool',
      name: 'read_file',
      content: '[output pruned by compaction]',
    });
    expect(empty).toBe(pruned);
    expect(isWildcardToolOutput('')).toBe(true);
    expect(isWildcardToolOutput('[output pruned by compaction]')).toBe(true);
    expect(isWildcardToolOutput('real bytes')).toBe(false);
  });

  it('keeps concrete tool outputs distinct from wildcards', () => {
    const concrete = canonicalMessage({ role: 'tool', name: 'read_file', content: 'bytes' });
    const wild = canonicalMessage({ role: 'tool', name: 'read_file', content: '' });
    expect(concrete).not.toBe(wild);
  });
});

describe('canonicalMessages + messageDigests', () => {
  it('maps each message to one sha1 in order', () => {
    const digests = messageDigests([
      { role: 'user', content: 'one' },
      { role: 'user', content: 'two' },
    ]);
    expect(digests).toHaveLength(2);
    for (const digest of digests) {
      expect(digest).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(digests[0]).not.toBe(digests[1]);
  });

  it('is deterministic across calls', () => {
    const messages = [{ role: 'user', content: 'same' }];
    expect(messageDigests(messages)).toEqual(messageDigests(messages));
  });

  it('canonicalMessages exposes the canonical forms', () => {
    expect(canonicalMessages([{ role: 'user', content: '  hi  ' }])).toEqual(['user:hi']);
  });
});

describe('ledger view (system excluded)', () => {
  it('drops system messages so their edits never break the prefix', () => {
    const messages = [
      { role: 'system', content: 'System v1.' },
      { role: 'user', content: 'q1' },
    ];
    expect(ledgerMessages(messages)).toEqual([{ role: 'user', content: 'q1' }]);
    expect(isSystemMessage({ role: 'system', content: 'x' })).toBe(true);
    expect(isSystemMessage({ role: 'user', content: 'x' })).toBe(false);
    expect(ledgerDigests(messages)).toEqual(messageDigests([{ role: 'user', content: 'q1' }]));
  });
});

describe('systemDigest', () => {  it('covers system messages only', () => {
    const base = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U1' },
    ];
    const changedUser = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'U2' },
    ];
    const changedSystem = [
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'U1' },
    ];
    expect(systemDigest(changedUser)).toBe(systemDigest(base));
    expect(systemDigest(changedSystem)).not.toBe(systemDigest(base));
  });
});

describe('canonicalJson + canonicalArgs', () => {
  it('sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('parses JSON strings before sorting', () => {
    expect(canonicalArgs('{"b":1,"a":2}')).toBe('{"a":2,"b":1}');
    expect(canonicalArgs('')).toBe('{}');
    expect(canonicalArgs(undefined)).toBe('{}');
  });

  it('keeps unparsable strings verbatim', () => {
    expect(canonicalArgs('{oops')).toBe('{oops');
  });
});

describe('provisionalDigestForResponse', () => {
  it('matches the echoed assistant text digest', () => {
    const text = 'Hello there.';
    const echoed = messageDigests([{ role: 'assistant', content: text }])[0];
    expect(provisionalDigestForResponse(text)).toBe(echoed);
  });

  it('matches the echoed assistant tool_calls form for marker turns', () => {
    const text = 'TOOL_CALL: {"name": "read_file", "arguments": {"path": "a.txt"}}';
    const echoed = messageDigests([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_zzz',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
          },
        ],
      },
    ])[0];
    expect(provisionalDigestForResponse(text)).toBe(echoed);
  });

  it('matches the canonical digest for the shorthand marker (Gemini form)', () => {
    const shorthand = 'TOOL_CALL: skill {"id": "docx"}';
    const canonical = 'TOOL_CALL: {"name": "skill", "arguments": {"id": "docx"}}';
    const echoed = messageDigests([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_zzz',
            type: 'function',
            function: { name: 'skill', arguments: '{"id":"docx"}' },
          },
        ],
      },
    ])[0];
    expect(provisionalDigestForResponse(shorthand, ['skill'])).toBe(echoed);
    expect(provisionalDigestForResponse(canonical, ['skill'])).toBe(echoed);
  });
});
