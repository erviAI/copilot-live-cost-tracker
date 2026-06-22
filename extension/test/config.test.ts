import { describe, it, expect, beforeEach } from 'vitest';
import { getBudgetThresholds } from '../src/config.js';
import { __resetMockConfiguration, __setMockConfiguration } from './mocks/vscode.js';

describe('config', () => {
  beforeEach(() => {
    __resetMockConfiguration();
  });

  describe('getBudgetThresholds', () => {
    it('uses configured budget thresholds when valid', () => {
      __setMockConfiguration({
        'budget.session.warning': 1,
        'budget.session.limit': 2,
        'budget.daily.warning': 3,
        'budget.daily.limit': 4,
        'budget.weekly.warning': 5,
        'budget.weekly.limit': 6,
      });

      expect(getBudgetThresholds()).toEqual({
        session: { warning: 1, limit: 2 },
        daily: { warning: 3, limit: 4 },
        weekly: { warning: 5, limit: 6 },
      });
    });

    it('falls back for negative, non-finite, and inverted threshold values', () => {
      __setMockConfiguration({
        'budget.session.warning': -1,
        'budget.session.limit': 2,
        'budget.daily.warning': 9,
        'budget.daily.limit': 3,
        'budget.weekly.warning': Number.NaN,
        'budget.weekly.limit': 2_000_000,
      });

      expect(getBudgetThresholds()).toEqual({
        session: { warning: 5, limit: 8 },
        daily: { warning: 20, limit: 50 },
        weekly: { warning: 25, limit: 1_000_000 },
      });
    });
  });
});