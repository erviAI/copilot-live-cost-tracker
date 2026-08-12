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
   * @param inputTokens Total input tokens (includes cache reads and writes)
   * @param outputTokens Total output tokens
   * @param cachedTokens Tokens served from cache (cache reads)
   * @param cacheWriteTokens Tokens written to cache
   * @param maxPromptTokens Prompt-token budget the request was issued with, when known
   * @returns Itemized cost breakdown, or null if model pricing is unknown
   */
  calculate(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
    cacheWriteTokens: number,
    maxPromptTokens?: number | null
  ): CostBreakdown | null {
    const pricing = this.pricingEngine.resolve(model);
    if (!pricing) return null;

    const rates = selectTierRates(pricing, inputTokens, maxPromptTokens);
    const breakdown = this.calculateWithRates(rates, inputTokens, outputTokens, cachedTokens, cacheWriteTokens);
    if (pricing.estimated) breakdown.estimated = true;
    if (rates !== pricing) breakdown.longContext = true;
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

    // `input` counts every prompt token, including the ones served from cache
    // and the ones written to it (verified against agent-traces telemetry:
    // input_tokens ~= cached_tokens + cache_creation tokens for Claude calls).
    // Subtracting both leaves the genuinely fresh tokens billed at the base rate.
    const freshInputTokens = Math.max(0, input - cached - cacheWrite);
    const freshInputCost = (freshInputTokens / 1_000_000) * pricing.input;
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
  /** True when the request was billed at the model's long-context tier rates. */
  longContext?: boolean;
}

/**
 * Pick the rate set a request is billed at.
 *
 * GitHub prices some models in two tiers separated by an input-token threshold
 * ("≤ 272K" vs "> 272K"); a request that crosses it bills entirely at the
 * higher rates. The tier cannot be read off the model identifier — the picker's
 * default and extended-context entries report the same name — so it is derived
 * from the request's own input size.
 *
 * `maxPromptTokens` (the prompt budget the request was issued with) acts as a
 * guard: a request that could not physically hold more than the threshold was
 * never on the extended context window, so it cannot be long-context billed no
 * matter what its token counts say. That keeps aggregate or malformed rows from
 * being priced up. When the value is unknown the token count decides alone.
 */
function selectTierRates(
  pricing: ModelPricing,
  inputTokens: number,
  maxPromptTokens?: number | null
): ModelPricing {
  const tier = pricing.longContext;
  if (!tier) return pricing;
  if (!(inputTokens > tier.thresholdTokens)) return pricing;
  if (typeof maxPromptTokens === 'number' && Number.isFinite(maxPromptTokens)
    && maxPromptTokens <= tier.thresholdTokens) {
    return pricing;
  }
  return {
    input: tier.input,
    output: tier.output,
    cached: tier.cached,
    // Keep the default cache-write rate when the tier does not publish its own.
    cacheWrite: tier.cacheWrite ?? pricing.cacheWrite,
  };
}

/** Coerce an untrusted token count to a finite, non-negative number. */
function sanitizeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
