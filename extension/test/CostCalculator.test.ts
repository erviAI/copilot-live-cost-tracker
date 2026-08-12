import { describe, it, expect } from 'vitest';
import { CostCalculator } from '../src/domain/CostCalculator.js';
import { PricingEngine } from '../src/domain/PricingEngine.js';

describe('CostCalculator', () => {
  const engine = new PricingEngine();
  const calculator = new CostCalculator(engine);

  describe('calculate', () => {
    it('calculates cost for Anthropic model with all token types', () => {
      // Claude Opus 4.5: input=$5, output=$25, cached=$0.50, cacheWrite=$6.25
      // `input` includes both the cache reads and the cache writes, so only the
      // remainder is billed at the base input rate.
      const result = calculator.calculate(
        'claude-opus-4-5',
        100_000, // input tokens (includes cache reads and writes)
        10_000,  // output tokens
        60_000,  // cached tokens (reads)
        20_000   // cache write tokens
      );

      expect(result).not.toBeNull();
      const r = result!;

      // Fresh: (100k - 60k - 20k) = 20k × $5/1M = $0.10
      expect(r.freshInputCost).toBeCloseTo(0.1, 4);
      // Cache read: 60k × $0.50/1M = $0.03
      expect(r.cacheReadCost).toBeCloseTo(0.03, 4);
      // Cache write: 20k × $6.25/1M = $0.125
      expect(r.cacheWriteCost).toBeCloseTo(0.125, 4);
      // Output: 10k × $25/1M = $0.25
      expect(r.outputCost).toBeCloseTo(0.25, 4);
      // Total: 0.10 + 0.03 + 0.125 + 0.25 = $0.505
      expect(r.totalCost).toBeCloseTo(0.505, 4);
    });

    it('bills a fully cached Anthropic call without any fresh input', () => {
      // Shape seen in real telemetry: input == cache reads + cache writes.
      const r = calculator.calculate('claude-opus-4-5', 100_000, 0, 80_000, 20_000)!;

      expect(r.freshInputCost).toBe(0);
      expect(r.totalCost).toBeCloseTo(0.04 + 0.125, 4);
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
      // 1M uncached input tokens on Claude Opus 4.5 — nothing was served from or
      // written to cache, so all of it is billed at the base input rate.
      const result = calculator.calculate('claude-opus-4-5', 1_000_000, 0, 0, 0);
      expect(result).not.toBeNull();
      expect(result!.freshInputCost).toBeCloseTo(5.00, 4);
      expect(result!.totalCost).toBeCloseTo(5.00, 4);

      const openai = calculator.calculate('gpt-4.1', 1_000_000, 0, 0, 0);
      expect(openai).not.toBeNull();
      expect(openai!.freshInputCost).toBeCloseTo(2.00, 4);
      expect(openai!.totalCost).toBeCloseTo(2.00, 4);
    });
  });

  describe('calculateWithRates', () => {
    it('uses explicit rates correctly (cache reads and writes excluded from fresh input)', () => {
      const result = calculator.calculateWithRates(
        { input: 10.00, output: 20.00, cached: 1.00, cacheWrite: 5.00 },
        100_000,
        50_000,
        40_000,
        10_000
      );

      // Fresh: (100k - 40k - 10k) = 50k × $10/1M = $0.50
      expect(result.freshInputCost).toBeCloseTo(0.50, 4);
      // Cache read: 40k × $1/1M = $0.04
      expect(result.cacheReadCost).toBeCloseTo(0.04, 4);
      // Cache write: 10k × $5/1M = $0.05
      expect(result.cacheWriteCost).toBeCloseTo(0.05, 4);
      // Output: 50k × $20/1M = $1.00
      expect(result.outputCost).toBeCloseTo(1.00, 4);
      // Total: 0.50 + 0.04 + 0.05 + 1.00 = $1.59
      expect(result.totalCost).toBeCloseTo(1.59, 4);
    });

    it('does not charge a cache-write rate the model has not published', () => {
      const result = calculator.calculateWithRates(
        { input: 10.00, output: 20.00, cached: 1.00 },
        100_000,
        50_000,
        40_000,
        0
      );

      // Fresh: (100k-40k)=60k × $10/1M = $0.60
      expect(result.freshInputCost).toBeCloseTo(0.60, 4);
      expect(result.cacheWriteCost).toBe(0);
      // Total: 0.60 + 0.04 + 0 + 1.00 = $1.64
      expect(result.totalCost).toBeCloseTo(1.64, 4);
    });
  });

  describe('long context tier', () => {
    // GPT-5.6 Sol default: input=$5, output=$30, cached=$0.50, cacheWrite=$6.25
    //          long context (> 272K input): input=$10, output=$45, cached=$1.00, cacheWrite=$12.50
    const EXTENDED_WINDOW = 922_000;

    it('uses default rates when input is below the threshold', () => {
      const r = calculator.calculate('gpt-5.6-sol', 200_000, 1_000, 100_000, 0, EXTENDED_WINDOW)!;

      // Fresh: (200k-100k)=100k × $5/1M = $0.50
      expect(r.freshInputCost).toBeCloseTo(0.5, 4);
      // Cache read: 100k × $0.50/1M = $0.05
      expect(r.cacheReadCost).toBeCloseTo(0.05, 4);
      // Output: 1k × $30/1M = $0.03
      expect(r.outputCost).toBeCloseTo(0.03, 4);
      expect(r.totalCost).toBeCloseTo(0.58, 4);
      expect(r.longContext).toBeUndefined();
    });

    it('uses long-context rates when input exceeds the threshold', () => {
      const r = calculator.calculate('gpt-5.6-sol', 300_000, 1_000, 100_000, 0, EXTENDED_WINDOW)!;

      // Fresh: (300k-100k)=200k × $10/1M = $2.00
      expect(r.freshInputCost).toBeCloseTo(2.0, 4);
      // Cache read: 100k × $1.00/1M = $0.10
      expect(r.cacheReadCost).toBeCloseTo(0.1, 4);
      // Output: 1k × $45/1M = $0.045
      expect(r.outputCost).toBeCloseTo(0.045, 4);
      expect(r.totalCost).toBeCloseTo(2.145, 4);
      expect(r.longContext).toBe(true);
    });

    it('never bills long context when the prompt budget could not reach the threshold', () => {
      // A request issued on the default window cannot legitimately exceed the
      // threshold, so an inflated token count must not price it up.
      const r = calculator.calculate('gpt-5.6-sol', 300_000, 1_000, 100_000, 0, 272_000)!;

      expect(r.totalCost).toBeCloseTo(1.08, 4);
      expect(r.longContext).toBeUndefined();
    });

    it('falls back to the token count when the prompt budget is unknown', () => {
      const r = calculator.calculate('gpt-5.6-sol', 300_000, 1_000, 100_000, 0, null)!;

      expect(r.totalCost).toBeCloseTo(2.145, 4);
      expect(r.longContext).toBe(true);
    });

    it('bills cache writes at the long-context rate too', () => {
      const r = calculator.calculate('gpt-5.6-sol', 300_000, 1_000, 100_000, 50_000, EXTENDED_WINDOW)!;

      // Cache write: 50k × $12.50/1M = $0.625
      expect(r.cacheWriteCost).toBeCloseTo(0.625, 4);
      // Fresh: (300k - 100k - 50k) = 150k × $10/1M = $1.50
      expect(r.freshInputCost).toBeCloseTo(1.5, 4);
      expect(r.longContext).toBe(true);
    });

    it('leaves flat-priced models unaffected above any threshold', () => {
      // Anthropic models have no long-context tier in the published table.
      const r = calculator.calculate('claude-opus-5', 400_000, 1_000, 300_000, 100_000, EXTENDED_WINDOW)!;

      expect(r.longContext).toBeUndefined();
      // Fully accounted for by cache reads and writes, so no fresh input.
      expect(r.freshInputCost).toBe(0);
    });
  });
});
