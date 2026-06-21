import { describe, it, expect } from 'vitest';
import { isIgnoredAgent, IGNORED_AGENT_NAMES } from '../src/domain/filters.js';
import type { Span } from '../src/domain/models.js';

function spanWithAgent(agentName: string | null): Span {
  return {
    spanId: 's',
    traceId: 't',
    parentSpanId: null,
    operationName: 'chat',
    agentName,
    requestModel: null,
    responseModel: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    startTimeMs: 0,
    endTimeMs: 0,
    ttftMs: null,
    chatSessionId: null,
    conversationId: null,
    turnIndex: null,
    statusCode: 1,
    statusMessage: null,
    toolName: null,
  };
}

describe('isIgnoredAgent', () => {
  it('returns false when the agent name is null', () => {
    expect(isIgnoredAgent(spanWithAgent(null))).toBe(false);
  });

  it('returns false for a normal user-facing agent', () => {
    expect(isIgnoredAgent(spanWithAgent('editAgent'))).toBe(false);
  });

  it('returns true for each ignored agent name', () => {
    for (const name of IGNORED_AGENT_NAMES) {
      expect(isIgnoredAgent(spanWithAgent(name))).toBe(true);
    }
  });

  it('matches ignored agents case-insensitively', () => {
    expect(isIgnoredAgent(spanWithAgent('COPILOTLANGUAGEMODELWRAPPER'))).toBe(true);
    expect(isIgnoredAgent(spanWithAgent('CopilotLanguageModelWrapper'))).toBe(true);
  });
});
