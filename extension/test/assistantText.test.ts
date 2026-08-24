import { describe, it, expect } from 'vitest';
import { extractAssistantText } from '../src/data/assistantText.js';

function encode(messages: unknown): string {
  return JSON.stringify(messages);
}

describe('extractAssistantText', () => {
  it('returns the text content of a single-part assistant message', () => {
    const raw = encode([{ role: 'assistant', parts: [{ type: 'text', content: 'Hello' }] }]);

    expect(extractAssistantText(raw)).toBe('Hello');
  });

  it('joins multiple text parts with a blank line', () => {
    const raw = encode([
      { role: 'assistant', parts: [{ type: 'text', content: 'First' }, { type: 'text', content: 'Second' }] },
    ]);

    expect(extractAssistantText(raw)).toBe('First\n\nSecond');
  });

  it('joins text across several messages', () => {
    const raw = encode([
      { role: 'assistant', parts: [{ type: 'text', content: 'One' }] },
      { role: 'assistant', parts: [{ type: 'text', content: 'Two' }] },
    ]);

    expect(extractAssistantText(raw)).toBe('One\n\nTwo');
  });

  it('skips non-text parts', () => {
    const raw = encode([
      {
        role: 'assistant',
        parts: [
          { type: 'tool_call', content: 'should be dropped' },
          { type: 'text', content: 'kept' },
        ],
      },
    ]);

    expect(extractAssistantText(raw)).toBe('kept');
  });

  it('skips empty text parts', () => {
    const raw = encode([{ role: 'assistant', parts: [{ type: 'text', content: '' }, { type: 'text', content: 'x' }] }]);

    expect(extractAssistantText(raw)).toBe('x');
  });

  it('tolerates messages without a parts array', () => {
    const raw = encode([{ role: 'assistant' }, { role: 'assistant', parts: 'nope' }]);

    expect(extractAssistantText(raw)).toBe('');
  });

  it('returns empty string for malformed JSON', () => {
    expect(extractAssistantText('{not json')).toBe('');
  });

  it('returns empty string for a non-array payload', () => {
    expect(extractAssistantText(encode({ role: 'assistant' }))).toBe('');
  });

  it('returns empty string for non-string or empty input', () => {
    expect(extractAssistantText(undefined)).toBe('');
    expect(extractAssistantText(null)).toBe('');
    expect(extractAssistantText(42)).toBe('');
    expect(extractAssistantText('')).toBe('');
  });

  it('trims surrounding whitespace', () => {
    const raw = encode([{ role: 'assistant', parts: [{ type: 'text', content: '\n  spaced  \n' }] }]);

    expect(extractAssistantText(raw)).toBe('spaced');
  });
});
