import type { ModelPricing } from './models.js';
import { PricingEngine } from './PricingEngine.js';

/**
 * CostCalculator computes the dollar cost of token usage.
 * Single Responsibility: pure math, no side effects or data fetching.
 */
export class CostCalculator {
  constructor(private readonly pricingEngine: PricingEngine) {}

  /**
   * Calculate the cost of a single LLM call.
   * @param model The response_model identifier from the span
   * @param inputTokens Total input tokens (includes cached)
   * @param outputTokens Total output tokens
   * @param cachedTokens Tokens served from cache (cache reads)
   * @param cacheWriteTokens Tokens written to cache
   * @returns Itemized cost breakdown, or null if model pricing is unknown
   */
  calculate(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
    cacheWriteTokens: number
  ): CostBreakdown | null {
    const pricing = this.pricingEngine.resolve(model);
    if (!pricing) return null;

    return this.calculateWithRates(pricing, inputTokens, outputTokens, cachedTokens, cacheWriteTokens);
  }

  /**
   * Calculate cost using explicit rates (for testing or override scenarios).
   */
  calculateWithRates(
    pricing: ModelPricing,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
    cacheWriteTokens: number
  ): CostBreakdown {
    const freshInputTokens = Math.max(0, inputTokens - cachedTokens);
    const freshInputCost = (freshInputTokens / 1_000_000) * pricing.input;
    const cacheReadCost = (cachedTokens / 1_000_000) * pricing.cached;
    const cacheWriteCost = pricing.cacheWrite
      ? (cacheWriteTokens / 1_000_000) * pricing.cacheWrite
      : 0;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return {
      freshInputCost,
      cacheReadCost,
      cacheWriteCost,
      outputCost,
      totalCost: freshInputCost + cacheReadCost + cacheWriteCost + outputCost,
    };
  }
}

export interface CostBreakdown {
  freshInputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  outputCost: number;
  totalCost: number;
}
