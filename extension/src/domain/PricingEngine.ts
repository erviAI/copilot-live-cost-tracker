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

    // 6. Family fallback — a brand-new model version (e.g. "claude-opus-4-8")
    // not yet in the pricing table inherits rates from the closest known
    // sibling in the same family. The result is flagged `estimated` so callers
    // can surface it as tentative until exact pricing is published.
    if (!bestMatch) {
      bestMatch = this.resolveFamilyFallback(dashed);
    }

    this.matchCache.set(modelIdentifier, bestMatch);
    return bestMatch;
  }

  /**
   * Find the closest known model in the same family and return a copy of its
   * pricing marked `estimated`. Matching requires at least two shared leading
   * dash-delimited segments (e.g. "claude-opus") to avoid pricing unrelated
   * models off a coincidental provider prefix. Among the candidates sharing the
   * longest prefix, the highest version is chosen.
   */
  private resolveFamilyFallback(dashed: string): ModelPricing | null {
    const targetSegments = dashed.split('-');
    const MIN_SHARED_SEGMENTS = 2;

    let bestSharedSegments = 0;
    let bestKeySegments: string[] = [];
    let bestPricing: ModelPricing | null = null;

    for (const [key, pricing] of this.pricing) {
      const keySegments = key.split('-');
      const shared = sharedPrefixLength(targetSegments, keySegments);
      if (shared < MIN_SHARED_SEGMENTS) continue;

      if (
        shared > bestSharedSegments ||
        (shared === bestSharedSegments && compareVersionSegments(keySegments, bestKeySegments) > 0)
      ) {
        bestSharedSegments = shared;
        bestKeySegments = keySegments;
        bestPricing = pricing;
      }
    }

    if (!bestPricing) return null;
    return { ...bestPricing, estimated: true };
  }


  /** Get all known model keys (for diagnostics/settings UI) */
  getKnownModels(): string[] {
    return Array.from(this.pricing.keys());
  }
}

/** Count how many leading dash-delimited segments two models share. */
function sharedPrefixLength(a: string[], b: string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/**
 * Compare two segment arrays as version tuples. Numeric segments compare
 * numerically, others lexicographically. Returns >0 if `a` is the higher
 * (later) version, <0 if lower, 0 if equal.
 */
function compareVersionSegments(a: string[], b: string[]): number {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const an = Number(av);
    const bn = Number(bv);
    const bothNumeric = !Number.isNaN(an) && !Number.isNaN(bn);
    if (bothNumeric) {
      if (an !== bn) return an - bn;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}
