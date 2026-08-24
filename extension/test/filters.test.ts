import { describe, it, expect } from 'vitest';
import { isIgnoredAgent, IGNORED_AGENT_NAMES, isCompactionAgent } from '../src/domain/filters.js';
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

describe('isCompactionAgent', () => {
  it('returns false when the agent name is null', () => {
    expect(isCompactionAgent(spanWithAgent(null))).toBe(false);
  });

  it('matches both the plain and the -full compaction agent', () => {
    expect(isCompactionAgent(spanWithAgent('summarizeConversationHistory'))).toBe(true);
    expect(isCompactionAgent(spanWithAgent('summarizeConversationHistory-full'))).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isCompactionAgent(spanWithAgent('SUMMARIZECONVERSATIONHISTORY-FULL'))).toBe(true);
  });

  it('matches retried compaction requests, which Copilot prefixes', () => {
    expect(isCompactionAgent(spanWithAgent('retry-error-summarizeConversationHistory-full'))).toBe(true);
    expect(isCompactionAgent(spanWithAgent('retry-server-error-summarizeConversationHistory'))).toBe(true);
  });

  it('does not match ordinary agents', () => {
    expect(isCompactionAgent(spanWithAgent('panel/editAgent'))).toBe(false);
    expect(isCompactionAgent(spanWithAgent('tool/runSubagent-Explore'))).toBe(false);
    expect(isCompactionAgent(spanWithAgent('title'))).toBe(false);
  });
});
