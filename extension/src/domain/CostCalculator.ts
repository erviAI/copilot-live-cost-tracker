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

    const breakdown = this.calculateWithRates(pricing, inputTokens, outputTokens, cachedTokens, cacheWriteTokens);
    if (pricing.estimated) breakdown.estimated = true;
    return breakdown;
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
    // Token counts originate from untrusted DB rows; coerce any NaN/negative/
    // non-finite values to a safe non-negative number so a single bad row
    // cannot poison the total with NaN.
    const input = sanitizeTokens(inputTokens);
    const output = sanitizeTokens(outputTokens);
    const cached = sanitizeTokens(cachedTokens);
    const cacheWrite = sanitizeTokens(cacheWriteTokens);

    // Anthropic models bill input as either cache reads or cache writes — the
    // raw "input" rate is never charged on its own. We detect Anthropic-style
    // pricing by the presence of a cacheWrite rate and zero out fresh input
    // cost so it neither shows in the breakdown nor contributes to the total.
    const isCacheOnlyInput = pricing.cacheWrite !== undefined;

    const freshInputTokens = Math.max(0, input - cached);
    const freshInputCost = isCacheOnlyInput
      ? 0
      : (freshInputTokens / 1_000_000) * pricing.input;
    const cacheReadCost = (cached / 1_000_000) * pricing.cached;
    const cacheWriteCost = pricing.cacheWrite !== undefined
      ? (cacheWrite / 1_000_000) * pricing.cacheWrite
      : 0;
    const outputCost = (output / 1_000_000) * pricing.output;

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
  /** True when these costs were derived from estimated (family-inferred) pricing. */
  estimated?: boolean;
}

/** Coerce an untrusted token count to a finite, non-negative number. */
function sanitizeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
