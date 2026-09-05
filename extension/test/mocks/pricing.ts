import type { ModelPricing } from '../../src/domain/models.js';

export const TEST_PRICING: Record<string, ModelPricing> = {
  'test-flat': { input: 5, output: 25, cached: 0.5, cacheWrite: 6.25 },
  'test-readonly': { input: 2, output: 8, cached: 0.5 },
  'test-tiered': {
    input: 2, output: 10, cached: 0.2, cacheWrite: 2.5,
    longContext: { thresholdTokens: 272_000, input: 4, output: 15, cached: 0.4, cacheWrite: 5 },
  },
};