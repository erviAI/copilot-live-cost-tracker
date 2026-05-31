import { describe, it, expect } from 'vitest';
import { Aggregator } from '../src/domain/Aggregator.js';
import { CostCalculator } from '../src/domain/CostCalculator.js';
import { PricingEngine } from '../src/domain/PricingEngine.js';
import type { Span } from '../src/domain/models.js';

function makeSpan(overrides: Partial<Span> = {}): Span {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    parentSpanId: null,
    operationName: 'chat',
    agentName: null,
    requestModel: null,
    responseModel: 'claude-opus-4-5',
    inputTokens: 10_000,
    outputTokens: 1_000,
    cachedTokens: 5_000,
    cacheWriteTokens: 2_000,
    reasoningTokens: 0,
    startTimeMs: Date.now() - 60_000, // 1 minute ago
    endTimeMs: Date.now() - 55_000,
    ttftMs: 200,
    chatSessionId: 'session-1',
    conversationId: 'session-1',
    turnIndex: 0,
    statusCode: 1,
    statusMessage: null,
    toolName: null,
    ...overrides,
  };
}

describe('Aggregator', () => {
  const engine = new PricingEngine();
  const calculator = new CostCalculator(engine);
  const aggregator = new Aggregator(calculator);

  describe('aggregatePeriod', () => {
    it('aggregates a single span correctly', () => {
      const span = makeSpan();
      const result = aggregator.aggregatePeriod([span]);

      expect(result.requests).toBe(1);
      expect(result.inputTokens).toBe(10_000);
      expect(result.outputTokens).toBe(1_000);
      expect(result.cachedTokens).toBe(5_000);
      expect(result.totalCost).toBeGreaterThan(0);
      expect(result.byModel).toHaveLength(1);
      expect(result.byModel[0].model).toBe('claude-opus-4-5');
    });

    it('groups multiple models separately', () => {
      const spans = [
        makeSpan({ spanId: 's1', responseModel: 'claude-opus-4-5' }),
        makeSpan({ spanId: 's2', responseModel: 'gpt-4.1' }),
        makeSpan({ spanId: 's3', responseModel: 'claude-opus-4-5' }),
      ];

      const result = aggregator.aggregatePeriod(spans);

      expect(result.requests).toBe(3);
      expect(result.byModel).toHaveLength(2);
      // Should be sorted by cost descending
      const modelNames = result.byModel.map(m => m.model);
      expect(modelNames).toContain('claude-opus-4-5');
      expect(modelNames).toContain('gpt-4.1');

      // Claude model should have 2 calls
      const claude = result.byModel.find(m => m.model === 'claude-opus-4-5')!;
      expect(claude.calls).toBe(2);
    });

    it('returns zero cost for empty spans', () => {
      const result = aggregator.aggregatePeriod([]);
      expect(result.requests).toBe(0);
      expect(result.totalCost).toBe(0);
      expect(result.byModel).toHaveLength(0);
    });
  });

  describe('buildDashboard', () => {
    it('produces a complete dashboard from spans', () => {
      const now = Date.now();
      const spans = [
        makeSpan({ spanId: 's1', startTimeMs: now - 1000, endTimeMs: now - 500 }),
        makeSpan({ spanId: 's2', startTimeMs: now - 2000, endTimeMs: now - 1500 }),
      ];

      const titles = new Map([['session-1', 'Test Session']]);
      const dashboard = aggregator.buildDashboard(spans, titles, 'session-1');

      expect(dashboard.today.requests).toBe(2);
      expect(dashboard.thisWeek.requests).toBe(2);
      expect(dashboard.currentSession.requests).toBe(2);
      expect(dashboard.currentSession.sessionId).toBe('session-1');
      expect(dashboard.last7Days).toHaveLength(7);
      expect(dashboard.recentSessions).toHaveLength(1);
      expect(dashboard.recentSessions[0].title).toBe('Test Session');
      expect(dashboard.updatedAt).toBeDefined();
    });

    it('filters today vs week correctly', () => {
      const now = Date.now();
      // Use a span from 8 days ago (guaranteed to be outside this week)
      const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;

      const spans = [
        makeSpan({ spanId: 's1', startTimeMs: now - 1000, endTimeMs: now - 500 }),
        makeSpan({ spanId: 's2', startTimeMs: eightDaysAgo, endTimeMs: eightDaysAgo + 500 }),
      ];

      const dashboard = aggregator.buildDashboard(spans, new Map(), null);

      // Today should have 1, this week should also have 1 (8 days ago is outside the week)
      expect(dashboard.today.requests).toBe(1);
      expect(dashboard.thisWeek.requests).toBe(1);
    });

    it('handles null currentSessionId', () => {
      const spans = [makeSpan()];
      const dashboard = aggregator.buildDashboard(spans, new Map(), null);

      expect(dashboard.currentSession.requests).toBe(0);
      expect(dashboard.currentSession.sessionId).toBeNull();
    });

    it('builds 7-day chart with correct structure', () => {
      const spans = [makeSpan()];
      const dashboard = aggregator.buildDashboard(spans, new Map(), null);

      expect(dashboard.last7Days).toHaveLength(7);
      for (const bucket of dashboard.last7Days) {
        expect(bucket.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(bucket.dayLabel).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
        expect(typeof bucket.totalCost).toBe('number');
        expect(typeof bucket.requests).toBe('number');
      }
    });

    it('merges subagent spans into parent session', () => {
      const now = Date.now();
      const parentSessionId = 'b786a4c9-6af6-454f-94e4-5432f62d021e';
      const toolCallId = 'toolu_bdrk_01P1yrDZPcbHw8mFrDwube52';
      const sharedTraceId = '7276de1aba9403486de97d4a52d9e50b';

      // Parent session spans (chatSessionId = real session, same traceId)
      const parentSpan = makeSpan({
        spanId: 'parent-1',
        traceId: sharedTraceId,
        parentSpanId: 'root-invoke-agent',
        chatSessionId: parentSessionId,
        conversationId: parentSessionId,
        responseModel: 'claude-opus-4-6',
        startTimeMs: now - 5000,
        endTimeMs: now - 4000,
      });

      // Subagent spans (chatSessionId = tool call ID, same traceId as parent)
      const subagentSpan1 = makeSpan({
        spanId: 'sub-1',
        traceId: sharedTraceId,
        parentSpanId: 'invoke-agent-span-id',
        chatSessionId: toolCallId,
        conversationId: 'per-subagent-conv-id',
        responseModel: 'claude-haiku-4-5-20251001',
        agentName: 'tool/runSubagent-Explore',
        startTimeMs: now - 3000,
        endTimeMs: now - 2000,
      });

      const subagentSpan2 = makeSpan({
        spanId: 'sub-2',
        traceId: sharedTraceId,
        parentSpanId: 'invoke-agent-span-id',
        chatSessionId: toolCallId,
        conversationId: 'per-subagent-conv-id',
        responseModel: 'claude-haiku-4-5-20251001',
        agentName: 'tool/runSubagent-Explore',
        startTimeMs: now - 2000,
        endTimeMs: now - 1000,
      });

      const spans = [parentSpan, subagentSpan1, subagentSpan2];
      const titles = new Map([[parentSessionId, 'My Session']]);
      const dashboard = aggregator.buildDashboard(spans, titles, parentSessionId);

      // Should produce ONE session, not two
      expect(dashboard.recentSessions).toHaveLength(1);
      expect(dashboard.recentSessions[0].sessionId).toBe(parentSessionId);
      expect(dashboard.recentSessions[0].title).toBe('My Session');
      // All 3 spans should be in that single session
      expect(dashboard.recentSessions[0].requests).toBe(3);
    });

    it('does not create separate session for subagent tool-call IDs (toolu_ prefix)', () => {
      const now = Date.now();
      const parentSessionId = 'real-session-uuid';
      const toolCallId = 'toolu_bdrk_abc123';
      const sharedTraceId = 'shared-trace-id';

      const spans = [
        // Parent span with real session ID (provides trace_id → session mapping)
        makeSpan({
          spanId: 'parent-1',
          traceId: sharedTraceId,
          parentSpanId: null,
          chatSessionId: parentSessionId,
          conversationId: parentSessionId,
          startTimeMs: now - 2000,
          endTimeMs: now - 1500,
        }),
        // Subagent span sharing same trace_id
        makeSpan({
          spanId: 'sub-only',
          traceId: sharedTraceId,
          parentSpanId: 'some-parent',
          chatSessionId: toolCallId,
          conversationId: 'subagent-conv-id',
          startTimeMs: now - 1000,
          endTimeMs: now - 500,
        }),
      ];

      const dashboard = aggregator.buildDashboard(spans, new Map(), null);

      // Should group under real session, not tool call ID
      expect(dashboard.recentSessions).toHaveLength(1);
      expect(dashboard.recentSessions[0].sessionId).toBe(parentSessionId);
    });

    it('does not create separate session for subagent tool-call IDs (call_ prefix)', () => {
      const now = Date.now();
      const parentSessionId = '3b4fbfad-fc77-42e2-8be7-2de7f7590d75';
      const toolCallId = 'call_BDL2EEZHtuCw1Q6cZJA2mXaF';
      const sharedTraceId = 'shared-trace-id-2';

      const spans = [
        makeSpan({
          spanId: 'parent-1',
          traceId: sharedTraceId,
          parentSpanId: null,
          chatSessionId: parentSessionId,
          conversationId: parentSessionId,
          startTimeMs: now - 3000,
          endTimeMs: now - 2500,
        }),
        makeSpan({
          spanId: 'sub-1',
          traceId: sharedTraceId,
          parentSpanId: 'some-parent',
          chatSessionId: toolCallId,
          conversationId: 'subagent-conv',
          agentName: 'tool/runSubagent-Explore',
          startTimeMs: now - 2000,
          endTimeMs: now - 1500,
        }),
        makeSpan({
          spanId: 'sub-2',
          traceId: sharedTraceId,
          parentSpanId: 'some-parent',
          chatSessionId: toolCallId,
          conversationId: 'subagent-conv',
          agentName: 'tool/runSubagent-Explore',
          startTimeMs: now - 1000,
          endTimeMs: now - 500,
        }),
      ];

      const dashboard = aggregator.buildDashboard(spans, new Map(), null);

      expect(dashboard.recentSessions).toHaveLength(1);
      expect(dashboard.recentSessions[0].sessionId).toBe(parentSessionId);
      expect(dashboard.recentSessions[0].requests).toBe(3);
    });

    it('populates byWorkspace in today and thisWeek when sessionWorkspaces provided', () => {
      const now = Date.now();
      const spans = [
        makeSpan({ spanId: 's1', chatSessionId: 'sess-a', conversationId: 'sess-a', startTimeMs: now - 1000, endTimeMs: now - 500 }),
        makeSpan({ spanId: 's2', chatSessionId: 'sess-a', conversationId: 'sess-a', startTimeMs: now - 2000, endTimeMs: now - 1500 }),
        makeSpan({ spanId: 's3', chatSessionId: 'sess-b', conversationId: 'sess-b', startTimeMs: now - 3000, endTimeMs: now - 2500 }),
      ];

      const workspaces = new Map<string, string | null>([
        ['sess-a', 'my-project'],
        ['sess-b', 'other-project'],
      ]);

      const dashboard = aggregator.buildDashboard(spans, new Map(), null, workspaces);

      expect(dashboard.today.byWorkspace).toHaveLength(2);
      const myProject = dashboard.today.byWorkspace.find(w => w.workspace === 'my-project')!;
      const otherProject = dashboard.today.byWorkspace.find(w => w.workspace === 'other-project')!;
      expect(myProject.requests).toBe(2);
      expect(myProject.sessionCount).toBe(1);
      expect(myProject.totalCost).toBeGreaterThan(0);
      expect(otherProject.requests).toBe(1);
      expect(otherProject.sessionCount).toBe(1);
    });

    it('groups spans with unknown workspace under "Unknown"', () => {
      const now = Date.now();
      const spans = [
        makeSpan({ spanId: 's1', chatSessionId: 'sess-known', startTimeMs: now - 1000, endTimeMs: now - 500 }),
        makeSpan({ spanId: 's2', chatSessionId: 'sess-unknown', startTimeMs: now - 2000, endTimeMs: now - 1500 }),
      ];

      const workspaces = new Map<string, string | null>([
        ['sess-known', 'my-project'],
        // sess-unknown not in map
      ]);

      const dashboard = aggregator.buildDashboard(spans, new Map(), null, workspaces);

      const unknown = dashboard.today.byWorkspace.find(w => w.workspace === 'Unknown');
      expect(unknown).toBeDefined();
      expect(unknown!.requests).toBe(1);
    });

    it('returns empty byWorkspace when no sessionWorkspaces provided', () => {
      const now = Date.now();
      const spans = [makeSpan({ startTimeMs: now - 1000, endTimeMs: now - 500 })];
      const dashboard = aggregator.buildDashboard(spans, new Map(), null);

      expect(dashboard.today.byWorkspace).toEqual([]);
      expect(dashboard.thisWeek.byWorkspace).toEqual([]);
    });

    it('includes sub-agent spans in currentSession via traceId resolution', () => {
      const now = Date.now();
      const parentSessionId = 'f58cf158-1234-5678-9abc-def012345678';
      const toolCallId = 'toolu_bdrk_01ABC123XYZ';
      const sharedTraceId = 'trace-turn-1';

      const spans = [
        // Parent span with real session UUID
        makeSpan({
          spanId: 'parent-1',
          traceId: sharedTraceId,
          chatSessionId: parentSessionId,
          conversationId: parentSessionId,
          responseModel: 'claude-opus-4-6',
          startTimeMs: now - 5000,
          endTimeMs: now - 4000,
        }),
        // Sub-agent spans with tool-call chatSessionId but same traceId
        makeSpan({
          spanId: 'sub-1',
          traceId: sharedTraceId,
          chatSessionId: toolCallId,
          conversationId: 'sub-conv',
          responseModel: 'claude-haiku-4-5',
          agentName: 'tool/runSubagent-Explore',
          startTimeMs: now - 3000,
          endTimeMs: now - 2500,
        }),
        makeSpan({
          spanId: 'sub-2',
          traceId: sharedTraceId,
          chatSessionId: toolCallId,
          conversationId: 'sub-conv',
          responseModel: 'claude-haiku-4-5',
          agentName: 'tool/runSubagent-Explore',
          startTimeMs: now - 2000,
          endTimeMs: now - 1500,
        }),
      ];

      const titles = new Map([[parentSessionId, 'Get span id on hover']]);
      const dashboard = aggregator.buildDashboard(spans, titles, parentSessionId);

      // All 3 spans (1 parent + 2 sub-agent) should be in currentSession
      expect(dashboard.currentSession.requests).toBe(3);
      expect(dashboard.currentSession.spanCount).toBe(3);
      expect(dashboard.currentSession.sessionId).toBe(parentSessionId);
      expect(dashboard.currentSession.byModel).toHaveLength(2);
    });
  });
});
