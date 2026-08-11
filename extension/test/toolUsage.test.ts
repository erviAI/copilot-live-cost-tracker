import { describe, it, expect } from 'vitest';
import {
  attributeToolCosts,
  avgDurationMs,
  bindToolsToModelCalls,
  groupToolSpansBySession,
  resolveToolSpanSession,
  sumToolUsage,
  toolUsageFromCalls,
  toolUsageFromSpans,
  totalToolCalls,
  totalToolCost,
} from '../src/domain/toolUsage.js';
import type { ToolCall, ToolCallSpan } from '../src/domain/models.js';

function makeToolSpan(overrides: Partial<ToolCallSpan> = {}): ToolCallSpan {
  return {
    spanId: 'tool-1',
    traceId: 'trace-1',
    parentSpanId: 'agent-1',
    toolName: 'read_file',
    chatSessionId: 'session-1',
    conversationId: 'session-1',
    statusCode: 1,
    startTimeMs: 1_700_000_000_000,
    endTimeMs: 1_700_000_000_100,
    ...overrides,
  };
}

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    spanId: 'span-1',
    traceId: 'trace-1',
    parentSpanId: null,
    toolName: 'read_file',
    operationName: 'execute_tool',
    agentName: null,
    startTimeMs: 1_700_000_000_000,
    durationMs: 100,
    status: 'ok',
    ...overrides,
  };
}

describe('toolUsage', () => {
  describe('toolUsageFromSpans', () => {
    it('merges spans for the same tool and sums attributed cost', () => {
      const spans = [
        makeToolSpan({ spanId: 'a', startTimeMs: 0, endTimeMs: 200 }),
        makeToolSpan({ spanId: 'b', startTimeMs: 0, endTimeMs: 300, statusCode: 2 }),
      ];
      const costs = new Map([['a', 0.5], ['b', 0.25]]);

      const result = toolUsageFromSpans(spans, costs);

      expect(result).toEqual([
        { toolName: 'read_file', calls: 2, errors: 1, totalDurationMs: 500, totalCost: 0.75 },
      ]);
    });

    it('treats unattributed tool calls as zero cost', () => {
      expect(toolUsageFromSpans([makeToolSpan()], new Map())[0].totalCost).toBe(0);
    });

    it('sorts by call count descending, tie-breaking alphabetically', () => {
      const result = toolUsageFromSpans([
        makeToolSpan({ spanId: '1', toolName: 'grep' }),
        makeToolSpan({ spanId: '2', toolName: 'edit' }),
        makeToolSpan({ spanId: '3', toolName: 'edit' }),
      ], new Map());

      expect(result.map(r => r.toolName)).toEqual(['edit', 'grep']);
    });
  });

  describe('bindToolsToModelCalls', () => {
    it('binds each tool to the most recent preceding call in the same agent', () => {
      const calls = [
        { spanId: 'chat-A', parentSpanId: 'agent-1', startTimeMs: 0 },
        { spanId: 'chat-B', parentSpanId: 'agent-1', startTimeMs: 1000 },
      ];
      const tools = [
        makeToolSpan({ spanId: 't1', startTimeMs: 200 }),
        makeToolSpan({ spanId: 't2', startTimeMs: 1200 }),
      ];

      const { bound, unbound } = bindToolsToModelCalls(calls, tools);

      expect(bound.get('chat-A')?.map(t => t.spanId)).toEqual(['t1']);
      expect(bound.get('chat-B')?.map(t => t.spanId)).toEqual(['t2']);
      expect(unbound).toEqual([]);
    });

    it('never binds across agents and reports tools with no preceding call', () => {
      const calls = [
        { spanId: 'chat-X', parentSpanId: 'agent-X', startTimeMs: 0 },
        { spanId: 'chat-Y', parentSpanId: 'agent-Y', startTimeMs: 100 },
      ];
      const tools = [
        makeToolSpan({ spanId: 'tX', parentSpanId: 'agent-X', startTimeMs: 200 }),
        makeToolSpan({ spanId: 'orphan', parentSpanId: 'agent-Z', startTimeMs: 300 }),
      ];

      const { bound, unbound } = bindToolsToModelCalls(calls, tools);

      expect(bound.get('chat-X')?.map(t => t.spanId)).toEqual(['tX']);
      expect(bound.has('chat-Y')).toBe(false);
      expect(unbound.map(t => t.spanId)).toEqual(['orphan']);
    });
  });

  describe('attributeToolCosts', () => {
    it('splits one model call cost evenly across the tools it requested', () => {
      const calls = [{ spanId: 'chat-A', parentSpanId: 'agent-1', startTimeMs: 0 }];
      const tools = [
        makeToolSpan({ spanId: 't1', startTimeMs: 10 }),
        makeToolSpan({ spanId: 't2', startTimeMs: 20 }),
        makeToolSpan({ spanId: 't3', startTimeMs: 30 }),
      ];

      const costs = attributeToolCosts(calls, tools, () => 0.9);

      expect(costs.get('t1')).toBeCloseTo(0.3);
      expect(costs.get('t2')).toBeCloseTo(0.3);
      expect(costs.get('t3')).toBeCloseTo(0.3);
    });

    it('gives the full call cost to a lone tool and nothing to unbound tools', () => {
      const calls = [{ spanId: 'chat-A', parentSpanId: 'agent-1', startTimeMs: 100 }];
      const tools = [
        makeToolSpan({ spanId: 'bound', startTimeMs: 200 }),
        makeToolSpan({ spanId: 'before', startTimeMs: 0 }),
      ];

      const costs = attributeToolCosts(calls, tools, () => 0.4);

      expect(costs.get('bound')).toBeCloseTo(0.4);
      expect(costs.has('before')).toBe(false);
    });
  });

  describe('resolveToolSpanSession', () => {
    it('keeps a real session id as-is', () => {
      expect(resolveToolSpanSession(makeToolSpan({ chatSessionId: 'real' }), new Map())).toBe('real');
    });

    it('maps a subagent tool call back to its parent session via trace id', () => {
      const span = makeToolSpan({ chatSessionId: 'toolu_abc', conversationId: 'toolu_abc', traceId: 't9' });
      expect(resolveToolSpanSession(span, new Map([['t9', 'parent']]))).toBe('parent');
    });

    it('returns null when a subagent call cannot be attributed', () => {
      const span = makeToolSpan({ chatSessionId: 'call_xyz', conversationId: 'call_xyz' });
      expect(resolveToolSpanSession(span, new Map())).toBeNull();
    });
  });

  describe('groupToolSpansBySession', () => {
    it('groups by resolved session and drops unattributable spans', () => {
      const spans = [
        makeToolSpan({ spanId: '1', chatSessionId: 'a', traceId: 't1' }),
        makeToolSpan({ spanId: '2', chatSessionId: 'toolu_1', conversationId: 'toolu_1', traceId: 't1' }),
        makeToolSpan({ spanId: '3', chatSessionId: 'b', traceId: 't2' }),
        makeToolSpan({ spanId: '4', chatSessionId: 'call_orphan', conversationId: 'call_orphan', traceId: 't99' }),
      ];

      const grouped = groupToolSpansBySession(spans, new Map([['t1', 'a'], ['t2', 'b']]));

      expect(grouped.get('a')).toHaveLength(2);
      expect(grouped.get('b')).toHaveLength(1);
      expect(grouped.has('call_orphan')).toBe(false);
    });
  });

  describe('toolUsageFromCalls', () => {
    it('counts errors, sums cost and clamps negative durations', () => {
      const result = toolUsageFromCalls([
        [makeCall({ durationMs: 50, cost: 0.2 }), makeCall({ status: 'error', durationMs: -5, cost: 0.2 })],
        [makeCall({ toolName: 'grep', durationMs: 20 })],
      ]);

      expect(result.find(r => r.toolName === 'read_file')).toMatchObject({
        calls: 2, errors: 1, totalDurationMs: 50,
      });
      expect(result.find(r => r.toolName === 'read_file')?.totalCost).toBeCloseTo(0.4);
      expect(result.find(r => r.toolName === 'grep')?.totalCost).toBe(0);
    });

    it('ignores undefined lists', () => {
      expect(toolUsageFromCalls([undefined, undefined])).toEqual([]);
    });
  });

  describe('sumToolUsage', () => {
    it('adds distributions without mutating the inputs', () => {
      const a = [{ toolName: 'edit', calls: 1, errors: 0, totalDurationMs: 10, totalCost: 0.1 }];
      const b = [{ toolName: 'edit', calls: 2, errors: 1, totalDurationMs: 20, totalCost: 0.2 }];

      const result = sumToolUsage([a, b, undefined]);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ toolName: 'edit', calls: 3, errors: 1, totalDurationMs: 30 });
      expect(result[0].totalCost).toBeCloseTo(0.3);
      expect(a[0].calls).toBe(1);
    });
  });

  it('avgDurationMs returns 0 for a tool with no calls', () => {
    expect(avgDurationMs({ toolName: 'x', calls: 0, errors: 0, totalDurationMs: 0, totalCost: 0 })).toBe(0);
    expect(avgDurationMs({ toolName: 'x', calls: 4, errors: 0, totalDurationMs: 100, totalCost: 0 })).toBe(25);
  });

  it('totals handle an absent distribution', () => {
    const stats = [{ toolName: 'x', calls: 2, errors: 0, totalDurationMs: 0, totalCost: 0.5 }];
    expect(totalToolCalls(undefined)).toBe(0);
    expect(totalToolCost(undefined)).toBe(0);
    expect(totalToolCalls(stats)).toBe(2);
    expect(totalToolCost(stats)).toBe(0.5);
  });
});
