import { describe, expect, it } from 'vitest';
import type { Span } from '../src/domain/models.js';
import { extractUserText, shouldIncludeChatSpan } from '../src/data/AgentTracesRepository.js';

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    parentSpanId: null,
    operationName: 'chat',
    agentName: null,
    requestModel: 'gpt-5.4',
    responseModel: 'gpt-5.4-2026-03-05',
    inputTokens: 10_000,
    outputTokens: 1_000,
    cachedTokens: 5_000,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    startTimeMs: Date.now() - 1000,
    endTimeMs: Date.now(),
    ttftMs: 200,
    chatSessionId: 'session-1',
    conversationId: 'session-1',
    turnIndex: 0,
    statusCode: 0,
    statusMessage: null,
    toolName: null,
    ...overrides,
  };
}

describe('shouldIncludeChatSpan', () => {
  it('drops canceled chat spans with no response model and no token usage', () => {
    const canceledEmpty = makeSpan({
      responseModel: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      statusCode: 2,
      statusMessage: 'Canceled',
    });

    expect(shouldIncludeChatSpan(canceledEmpty)).toBe(false);
  });

  it('keeps canceled chat spans when usage was already recorded', () => {
    const canceledWithUsage = makeSpan({
      responseModel: null,
      statusCode: 2,
      statusMessage: 'Canceled',
    });

    expect(shouldIncludeChatSpan(canceledWithUsage)).toBe(true);
  });
});

describe('extractUserText', () => {
  const notification =
    '[Terminal 975cde77-c5dd-4ffc-a317-4eec8a3520e8 notification: command completed with exit code 1. ' +
    'Use send_to_terminal to send another command or kill_terminal to stop it.]\nTerminal output:\nnpm test';

  it('extracts the wrapped user request', () => {
    const raw = JSON.stringify([{ type: 'text', text: '<userRequest>\nFix the failing test\n</userRequest>' }]);
    expect(extractUserText(raw)).toBe('Fix the failing test');
  });

  it('truncates long user requests', () => {
    const raw = JSON.stringify([{ type: 'text', text: '<userRequest>' + 'a'.repeat(80) + '</userRequest>' }]);
    expect(extractUserText(raw)).toBe('a'.repeat(50) + '\u2026');
  });

  it('falls back to a terminal notification when there is no wrapped request', () => {
    const raw = JSON.stringify([
      { type: 'tool_result', text: 'ignored' },
      { type: 'text', text: notification },
    ]);
    // Long enough to keep the status sentence the domain layer parses.
    expect(extractUserText(raw)).toContain('command completed with exit code 1');
  });

  it('prefers the wrapped user request over a replayed notification', () => {
    const raw = JSON.stringify([
      { type: 'text', text: notification },
      { type: 'text', text: '<userRequest>Now fix it</userRequest>' },
    ]);
    expect(extractUserText(raw)).toBe('Now fix it');
  });

  it('returns null for invalid or empty payloads', () => {
    expect(extractUserText('not json')).toBeNull();
    expect(extractUserText(JSON.stringify([{ type: 'tool_result', text: 'ignored' }]))).toBeNull();
  });
});