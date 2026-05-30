import { describe, expect, it } from 'vitest';
import type { Span } from '../src/domain/models.js';
import { shouldIncludeChatSpan } from '../src/data/AgentTracesRepository.js';

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