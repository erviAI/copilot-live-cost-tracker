import { describe, it, expect } from 'vitest';
import { CostCalculator, CostBreakdown } from '../src/domain/CostCalculator.js';
import { PricingEngine } from '../src/domain/PricingEngine.js';

describe('CostCalculator', () => {
  const engine = new PricingEngine();
  const calculator = new CostCalculator(engine);

  describe('calculate', () => {
    it('calculates cost for Anthropic model with all token types', () => {
      // Claude Opus 4.5: input=$5, output=$25, cached=$0.50, cacheWrite=$6.25
      const result = calculator.calculate(
        'claude-opus-4-5',
        100_000, // input tokens (includes cached)
        10_000,  // output tokens
        60_000,  // cached tokens (reads)
        20_000   // cache write tokens
      );

      expect(result).not.toBeNull();
      const r = result!;

      // Fresh input: (100k - 60k) = 40k tokens × $5/1M = $0.20
      expect(r.freshInputCost).toBeCloseTo(0.20, 4);
      // Cache read: 60k × $0.50/1M = $0.03
      expect(r.cacheReadCost).toBeCloseTo(0.03, 4);
      // Cache write: 20k × $6.25/1M = $0.125
      expect(r.cacheWriteCost).toBeCloseTo(0.125, 4);
      // Output: 10k × $25/1M = $0.25
      expect(r.outputCost).toBeCloseTo(0.25, 4);
      // Total: 0.20 + 0.03 + 0.125 + 0.25 = $0.605
      expect(r.totalCost).toBeCloseTo(0.605, 4);
    });

    it('calculates cost for OpenAI model (no cache write)', () => {
      // GPT-4.1: input=$2, output=$8, cached=$0.50
      const result = calculator.calculate(
        'gpt-4.1',
        50_000,  // input
        5_000,   // output
        30_000,  // cached
        0        // no cache write for OpenAI
      );

      expect(result).not.toBeNull();
      const r = result!;

      // Fresh input: (50k - 30k) = 20k × $2/1M = $0.04
      expect(r.freshInputCost).toBeCloseTo(0.04, 4);
      // Cache read: 30k × $0.50/1M = $0.015
      expect(r.cacheReadCost).toBeCloseTo(0.015, 4);
      // Cache write: 0
      expect(r.cacheWriteCost).toBe(0);
      // Output: 5k × $8/1M = $0.04
      expect(r.outputCost).toBeCloseTo(0.04, 4);
      // Total: 0.04 + 0.015 + 0 + 0.04 = $0.095
      expect(r.totalCost).toBeCloseTo(0.095, 4);
    });

    it('handles zero tokens gracefully', () => {
      const result = calculator.calculate('claude-opus-4-5', 0, 0, 0, 0);
      expect(result).not.toBeNull();
      expect(result!.totalCost).toBe(0);
    });

    it('handles cached > input gracefully (clamps fresh to 0)', () => {
      // Edge case: cachedTokens reported higher than inputTokens
      const result = calculator.calculate('gpt-4.1', 1000, 500, 2000, 0);
      expect(result).not.toBeNull();
      expect(result!.freshInputCost).toBe(0); // Clamped via Math.max(0, ...)
    });

    it('returns null for unknown model', () => {
      const result = calculator.calculate('unknown-model', 1000, 500, 0, 0);
      expect(result).toBeNull();
    });

    it('handles large token counts (1M+) correctly', () => {
      // 1M input tokens on Claude Opus 4.5 = exactly $5.00 fresh input
      const result = calculator.calculate('claude-opus-4-5', 1_000_000, 0, 0, 0);
      expect(result).not.toBeNull();
      expect(result!.freshInputCost).toBeCloseTo(5.00, 4);
      expect(result!.totalCost).toBeCloseTo(5.00, 4);
    });
  });

  describe('calculateWithRates', () => {
    it('uses explicit rates correctly', () => {
      const result = calculator.calculateWithRates(
        { input: 10.00, output: 20.00, cached: 1.00, cacheWrite: 5.00 },
        100_000,
        50_000,
        40_000,
        10_000
      );

      // Fresh: (100k-40k)=60k × $10/1M = $0.60
      expect(result.freshInputCost).toBeCloseTo(0.60, 4);
      // Cache read: 40k × $1/1M = $0.04
      expect(result.cacheReadCost).toBeCloseTo(0.04, 4);
      // Cache write: 10k × $5/1M = $0.05
      expect(result.cacheWriteCost).toBeCloseTo(0.05, 4);
      // Output: 50k × $20/1M = $1.00
      expect(result.outputCost).toBeCloseTo(1.00, 4);
      // Total: 0.60 + 0.04 + 0.05 + 1.00 = $1.69
      expect(result.totalCost).toBeCloseTo(1.69, 4);
    });
  });
});
