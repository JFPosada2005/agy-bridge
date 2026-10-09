import { describe, expect, it } from 'vitest';
import {
  AgyConversationMismatchError,
  buildAgyArgs,
  extractConversationId,
  runAgyTurn,
} from '../src/agy';

describe('buildAgyArgs', () => {
  it('builds the stateless argv with no resume flags', () => {
    expect(buildAgyArgs({ model: 'gemini-3.6-flash-low', effort: null })).toEqual([
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3.6-flash-low',
      '--input-format',
      'text',
      '--disable-slash-commands',
    ]);
  });

  it('adds --effort when set', () => {
    const args = buildAgyArgs({ model: 'm', effort: 'low' });
    expect(args).toContain('--effort');
    expect(args).toContain('low');
  });

  it('appends --conversation for resume and never --continue', () => {
    const args = buildAgyArgs({ model: 'm', effort: null, conversationId: 'conv-123' });
    expect(args).toContain('--conversation');
    expect(args).toContain('conv-123');
    expect(args).not.toContain('--continue');
  });
});

describe('extractConversationId', () => {
  it('reads top-level and nested ids', () => {
    expect(extractConversationId({ type: 'init', conversation_id: 'c1' })).toBe('c1');
    expect(extractConversationId({ type: 'init', init: { conversationId: 'c2' } })).toBe('c2');
    expect(extractConversationId({ type: 'step_update' })).toBeNull();
  });
});

describe('AgyConversationMismatchError', () => {
  it('names both ids', () => {
    const err = new AgyConversationMismatchError('conv-expected', 'conv-actual');
    expect(err.message).toContain('conv-expected');
    expect(err.message).toContain('conv-actual');
    expect(err.expectedId).toBe('conv-expected');
    expect(err.actualId).toBe('conv-actual');
  });
});

function nodeEval(script: string): { cmd: string; args: string[] } {
  return { cmd: process.execPath, args: ['-e', script] };
}

describe('runAgyTurn init gate (fake commands only, zero live agy)', () => {
  it('captures the init conversation id and calls onInit before output', async () => {
    const seen: string[] = [];
    const result = await runAgyTurn({
      model: 'fake-model',
      effort: null,
      prompt: 'hello',
      binaryPath: process.execPath,
      commandOverride: nodeEval(
        `console.log(JSON.stringify({type:'init',conversation_id:'conv-1'}));` +
          `console.log(JSON.stringify({type:'result',result:{response:'hi'}}));`,
      ),
      onInit: (id) => {
        seen.push(id);
        return 'continue';
      },
    });
    expect(seen).toEqual(['conv-1']);
    expect(result.conversationId).toBe('conv-1');
    expect(result.text).toBe('hi');
  });

  it('kills on mismatch and rejects with both ids (slow sleeper dies fast)', async () => {
    const start = Date.now();
    await expect(
      runAgyTurn({
        model: 'fake-model',
        effort: null,
        prompt: 'hello',
        binaryPath: process.execPath,
        timeoutMs: 20_000,
        conversationId: 'conv-expected',
        commandOverride: nodeEval(
          `console.log(JSON.stringify({type:'init',conversation_id:'conv-hijacked'}));` +
            `setTimeout(()=>{}, 30000);`,
        ),
        onInit: () => 'kill',
      }),
    ).rejects.toMatchObject({
      name: 'AgyConversationMismatchError',
      expectedId: 'conv-expected',
      actualId: 'conv-hijacked',
    });
    expect(Date.now() - start).toBeLessThan(15_000);
  });

  it('treats a throwing onInit as continue with a loud warning', async () => {
    const result = await runAgyTurn({
      model: 'fake-model',
      effort: null,
      prompt: 'hello',
      binaryPath: process.execPath,
      commandOverride: nodeEval(
        `console.log(JSON.stringify({type:'init',conversation_id:'conv-9'}));` +
          `console.log(JSON.stringify({type:'result',result:{response:'ok'}}));`,
      ),
      onInit: () => {
        throw new Error('callback boom');
      },
    });
    expect(result.text).toBe('ok');
    expect(result.conversationId).toBe('conv-9');
    expect(result.warnings.some((warning) => warning.includes('onInit'))).toBe(true);
  });

  it('leaves conversationId undefined when agy sends no init event', async () => {
    const result = await runAgyTurn({
      model: 'fake-model',
      effort: null,
      prompt: 'hello',
      binaryPath: process.execPath,
      commandOverride: nodeEval(
        `console.log(JSON.stringify({type:'result',result:{response:'no-init'}}));`,
      ),
    });
    expect(result.text).toBe('no-init');
    expect(result.conversationId).toBeUndefined();
  });
});
