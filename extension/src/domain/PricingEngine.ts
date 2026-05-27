import type { ModelPricing } from './models.js';
import { DEFAULT_PRICING } from './pricing-data.js';

/**
 * PricingEngine resolves a model identifier string to its pricing rates.
 * Uses fuzzy matching to handle versioned model names (e.g., "claude-opus-4-5-20251101").
 *
 * Open/Closed Principle: new models are added to pricing data, not to this logic.
 */
export class PricingEngine {
  private readonly pricing: Map<string, ModelPricing>;
  private readonly matchCache = new Map<string, ModelPricing | null>();

  constructor(overrides?: Record<string, ModelPricing>) {
    this.pricing = new Map<string, ModelPricing>();

    // Load defaults
    for (const [key, value] of Object.entries(DEFAULT_PRICING)) {
      this.pricing.set(key, value);
    }

    // Apply user overrides
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) {
        this.pricing.set(key, value);
      }
    }
  }

  /**
   * Look up pricing for a model identifier.
   * Handles model strings like "claude-opus-4-5-20251101" or "gpt-4.1-2025-04-14".
   * Returns null if no matching pricing is found.
   */
  resolve(modelIdentifier: string): ModelPricing | null {
    if (!modelIdentifier) return null;

    // Check cache first
    if (this.matchCache.has(modelIdentifier)) {
      return this.matchCache.get(modelIdentifier)!;
    }

    const normalized = modelIdentifier.toLowerCase().trim();
    // Some data sources use dots between version components
    // (e.g. main.jsonl emits `claude-opus-4.5`) while others use dashes
    // (e.g. agent-traces.db stores `claude-opus-4-5`). Try both shapes.
    const dashed = normalized.replace(/\./g, '-');

    // 1. Exact match
    if (this.pricing.has(normalized)) {
      const result = this.pricing.get(normalized)!;
      this.matchCache.set(modelIdentifier, result);
      return result;
    }
    if (dashed !== normalized && this.pricing.has(dashed)) {
      const result = this.pricing.get(dashed)!;
      this.matchCache.set(modelIdentifier, result);
      return result;
    }

    // 2. Try matching by stripping date suffix (e.g., "-20251101")
    const withoutDate = dashed.replace(/-\d{8}$/, '');
    if (this.pricing.has(withoutDate)) {
      const result = this.pricing.get(withoutDate)!;
      this.matchCache.set(modelIdentifier, result);
      return result;
    }

    // 3. Try matching by stripping full date (e.g., "-2025-04-14")
    const withoutFullDate = dashed.replace(/-\d{4}-\d{2}-\d{2}$/, '');
    if (this.pricing.has(withoutFullDate)) {
      const result = this.pricing.get(withoutFullDate)!;
      this.matchCache.set(modelIdentifier, result);
      return result;
    }

    // 4. Prefix matching — find the longest key that is a prefix of the model.
    // Test both the original and dash-normalized forms so e.g.
    // `claude-opus-4.5-20251101` (date-stripped above to `claude-opus-4-5-20251101`
    // won't match, so we still need prefix here) resolves correctly.
    let bestMatch: ModelPricing | null = null;
    let bestLength = 0;
    for (const [key, pricing] of this.pricing) {
      if ((normalized.startsWith(key) || dashed.startsWith(key)) && key.length > bestLength) {
        bestMatch = pricing;
        bestLength = key.length;
      }
    }

    // 5. Substring matching — find keys contained within the model string
    if (!bestMatch) {
      for (const [key, pricing] of this.pricing) {
        if ((normalized.includes(key) || dashed.includes(key)) && key.length > bestLength) {
          bestMatch = pricing;
          bestLength = key.length;
        }
      }
    }

    this.matchCache.set(modelIdentifier, bestMatch);
    return bestMatch;
  }

  /** Get all known model keys (for diagnostics/settings UI) */
  getKnownModels(): string[] {
    return Array.from(this.pricing.keys());
  }
}
