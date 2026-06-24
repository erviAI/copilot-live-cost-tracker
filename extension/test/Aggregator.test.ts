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

      expect(result.modelTurns).toBe(1);
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

      expect(result.modelTurns).toBe(3);
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
      expect(result.modelTurns).toBe(0);
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

      expect(dashboard.today.modelTurns).toBe(2);
      expect(dashboard.thisWeek.modelTurns).toBe(2);
      expect(dashboard.currentSession.modelTurns).toBe(2);
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
      expect(dashboard.today.modelTurns).toBe(1);
      expect(dashboard.thisWeek.modelTurns).toBe(1);
    });

    it('handles null currentSessionId', () => {
      const spans = [makeSpan()];
      const dashboard = aggregator.buildDashboard(spans, new Map(), null);

      expect(dashboard.currentSession.modelTurns).toBe(0);
      expect(dashboard.currentSession.sessionId).toBeNull();
    });

    it('computes context weight from the latest turn of the active session', () => {
      const now = Date.now();
      const spans = [
        // Older turn (trace-old): smaller prompt
        makeSpan({ spanId: 's1', traceId: 'trace-old', startTimeMs: now - 5000, inputTokens: 8_000, cachedTokens: 2_000 }),
        // Latest turn (trace-new): main call + a tool call sharing the trace
        makeSpan({ spanId: 's2', traceId: 'trace-new', startTimeMs: now - 1000, inputTokens: 30_000, cachedTokens: 20_000 }),
        makeSpan({ spanId: 's3', traceId: 'trace-new', startTimeMs: now - 900, inputTokens: 1_000, cachedTokens: 0 }),
      ];

      const dashboard = aggregator.buildDashboard(spans, new Map(), 'session-1');

      // Latest turn's largest prompt = 30k fresh + 20k cached = 50k
      expect(dashboard.currentSession.contextWeightTokens).toBe(50_000);
    });

    it('reports zero context weight when there is no active session', () => {
      const spans = [makeSpan()];
      const dashboard = aggregator.buildDashboard(spans, new Map(), null);
      expect(dashboard.currentSession.contextWeightTokens).toBe(0);
    });

    it('builds 7-day chart with correct structure', () => {
      const spans = [makeSpan()];
      const dashboard = aggregator.buildDashboard(spans, new Map(), null);

      expect(dashboard.last7Days).toHaveLength(7);
      for (const bucket of dashboard.last7Days) {
        expect(bucket.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(bucket.dayLabel).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
        expect(typeof bucket.totalCost).toBe('number');
        expect(typeof bucket.modelTurns).toBe('number');
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
      expect(dashboard.recentSessions[0].modelTurns).toBe(3);
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
      expect(dashboard.recentSessions[0].modelTurns).toBe(3);
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
      expect(myProject.modelTurns).toBe(2);
      expect(myProject.sessionCount).toBe(1);
      expect(myProject.totalCost).toBeGreaterThan(0);
      expect(otherProject.modelTurns).toBe(1);
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
      expect(unknown!.modelTurns).toBe(1);
    });

    it('attributes subagent spans to the parent session workspace', () => {
      const now = Date.now();
      const parentSessionId = 'parent-session';
      const toolCallId = 'toolu_bdrk_workspace_child';
      const sharedTraceId = 'workspace-trace';
      const spans = [
        makeSpan({
          spanId: 'parent',
          traceId: sharedTraceId,
          chatSessionId: parentSessionId,
          conversationId: parentSessionId,
          startTimeMs: now - 2000,
          endTimeMs: now - 1500,
        }),
        makeSpan({
          spanId: 'subagent',
          traceId: sharedTraceId,
          chatSessionId: toolCallId,
          conversationId: 'subagent-conversation',
          agentName: 'tool/runSubagent-Explore',
          startTimeMs: now - 1000,
          endTimeMs: now - 500,
        }),
      ];
      const workspaces = new Map<string, string | null>([[parentSessionId, 'parent-workspace']]);

      const dashboard = aggregator.buildDashboard(spans, new Map(), parentSessionId, workspaces);

      expect(dashboard.today.byWorkspace).toHaveLength(1);
      expect(dashboard.today.byWorkspace[0].workspace).toBe('parent-workspace');
      expect(dashboard.today.byWorkspace[0].modelTurns).toBe(2);
      expect(dashboard.today.byWorkspace[0].sessionCount).toBe(1);
      expect(dashboard.today.byWorkspace.find(w => w.workspace === 'Unknown')).toBeUndefined();
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
      expect(dashboard.currentSession.modelTurns).toBe(3);
      expect(dashboard.currentSession.spanCount).toBe(3);
      expect(dashboard.currentSession.sessionId).toBe(parentSessionId);
      expect(dashboard.currentSession.byModel).toHaveLength(2);
    });
  });

  describe('aggregateSessionDetail tool-call binding', () => {
    it('binds each tool call to the most recent preceding model call in the same agent', () => {
      const t0 = 1_000_000;
      const chatA = makeSpan({ spanId: 'chat-A', traceId: 'tr', parentSpanId: 'agent-1', startTimeMs: t0, endTimeMs: t0 + 100 });
      const chatB = makeSpan({ spanId: 'chat-B', traceId: 'tr', parentSpanId: 'agent-1', startTimeMs: t0 + 1000, endTimeMs: t0 + 1100 });
      const tool1 = makeSpan({ spanId: 'tool-1', traceId: 'tr', parentSpanId: 'agent-1', operationName: 'execute_tool', toolName: 'read_file', startTimeMs: t0 + 200, endTimeMs: t0 + 250 });
      const tool2 = makeSpan({ spanId: 'tool-2', traceId: 'tr', parentSpanId: 'agent-1', operationName: 'execute_tool', toolName: 'grep_search', startTimeMs: t0 + 1200, endTimeMs: t0 + 1250 });

      const detail = aggregator.aggregateSessionDetail('tr', [chatA, chatB], undefined, [tool1, tool2]);

      expect(detail.turns).toHaveLength(1);
      const turn = detail.turns[0];
      const a = turn.spans.find(s => s.spanId === 'chat-A')!;
      const b = turn.spans.find(s => s.spanId === 'chat-B')!;
      expect(a.toolCalls?.map(t => t.toolName)).toEqual(['read_file']);
      expect(b.toolCalls?.map(t => t.toolName)).toEqual(['grep_search']);
      expect(turn.toolCalls).toBeUndefined();
    });

    it('isolates parallel agents so a tool never binds across agents', () => {
      const t0 = 2_000_000;
      // Two agents whose calls interleave in wall-clock time.
      const chatX = makeSpan({ spanId: 'chat-X', traceId: 'tr', parentSpanId: 'agent-X', startTimeMs: t0, endTimeMs: t0 + 50 });
      const chatY = makeSpan({ spanId: 'chat-Y', traceId: 'tr', parentSpanId: 'agent-Y', startTimeMs: t0 + 100, endTimeMs: t0 + 150 });
      // Tool for agent X starts AFTER agent Y's chat, but must still bind to chat-X.
      const toolX = makeSpan({ spanId: 'tool-X', traceId: 'tr', parentSpanId: 'agent-X', operationName: 'execute_tool', toolName: 'read_file', startTimeMs: t0 + 200, endTimeMs: t0 + 220 });

      const detail = aggregator.aggregateSessionDetail('tr', [chatX, chatY], undefined, [toolX]);
      const x = detail.turns[0].spans.find(s => s.spanId === 'chat-X')!;
      const y = detail.turns[0].spans.find(s => s.spanId === 'chat-Y')!;
      expect(x.toolCalls?.map(t => t.toolName)).toEqual(['read_file']);
      expect(y.toolCalls).toBeUndefined();
    });

    it('keeps tool calls with no preceding model call as unbound at the turn level', () => {
      const t0 = 3_000_000;
      const chat = makeSpan({ spanId: 'chat-1', traceId: 'tr', parentSpanId: 'agent-1', startTimeMs: t0 + 1000, endTimeMs: t0 + 1100 });
      // Tool starts before the chat span → cannot be attributed to it.
      const orphan = makeSpan({ spanId: 'tool-orphan', traceId: 'tr', parentSpanId: 'agent-1', operationName: 'execute_tool', toolName: 'manage_todo_list', startTimeMs: t0, endTimeMs: t0 + 10 });

      const detail = aggregator.aggregateSessionDetail('tr', [chat], undefined, [orphan]);
      const turn = detail.turns[0];
      expect(turn.spans[0].toolCalls).toBeUndefined();
      expect(turn.toolCalls?.map(t => t.toolName)).toEqual(['manage_todo_list']);
    });

    it('attaches tool args/result/statusMessage and per-turn prompt/response text', () => {
      const t0 = 4_000_000;
      const chat = makeSpan({ spanId: 'chat-1', traceId: 'tr', parentSpanId: 'agent-1', turnIndex: 0, startTimeMs: t0, endTimeMs: t0 + 100 });
      const tool = makeSpan({
        spanId: 'tool-1', traceId: 'tr', parentSpanId: 'agent-1', operationName: 'execute_tool',
        toolName: 'read_file', startTimeMs: t0 + 200, endTimeMs: t0 + 250,
        statusCode: 2, statusMessage: 'file not found',
        toolArgs: '{"filePath":"a.ts","startLine":1,"endLine":40}', toolResult: 'contents…',
      });
      const turnTexts = new Map([[0, { userMessage: 'Full prompt text', assistantResponse: 'Full response text' }]]);

      const detail = aggregator.aggregateSessionDetail('tr', [chat], undefined, [tool], turnTexts);
      const turn = detail.turns[0];
      expect(turn.promptText).toBe('Full prompt text');
      expect(turn.responseText).toBe('Full response text');
      const tc = turn.spans[0].toolCalls?.[0];
      expect(tc?.args).toBe('{"filePath":"a.ts","startLine":1,"endLine":40}');
      expect(tc?.result).toBe('contents…');
      expect(tc?.status).toBe('error');
      expect(tc?.statusMessage).toBe('file not found');
    });
  });
});

