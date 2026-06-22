import { describe, it, expect } from 'vitest';
import { isSubagentSessionId, SUBAGENT_SESSION_ID_PREFIXES } from '../src/domain/sessionIds.js';

describe('isSubagentSessionId', () => {
  it('returns false for null/undefined/empty', () => {
    expect(isSubagentSessionId(null)).toBe(false);
    expect(isSubagentSessionId(undefined)).toBe(false);
    expect(isSubagentSessionId('')).toBe(false);
  });

  it('returns true for ids using any subagent prefix', () => {
    for (const prefix of SUBAGENT_SESSION_ID_PREFIXES) {
      expect(isSubagentSessionId(`${prefix}abc123`)).toBe(true);
    }
  });

  it('returns false for a real chat session id (UUID-like)', () => {
    expect(isSubagentSessionId('b1e2c3d4-5678-90ab-cdef-1234567890ab')).toBe(false);
  });

  it('does not match when the prefix appears mid-string', () => {
    expect(isSubagentSessionId('session-toolu_123')).toBe(false);
    expect(isSubagentSessionId('x-call_456')).toBe(false);
  });
});
