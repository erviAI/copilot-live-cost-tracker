import type { ModelPricing } from './models.js';

/**
 * Default pricing data from GitHub Copilot's official pricing (May 2026).
 * All rates are per 1 million tokens in USD.
 *
 * Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Anthropic (includes cache write cost)
  'claude-opus-4-5': { input: 5.00, output: 25.00, cached: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5.00, output: 25.00, cached: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5.00, output: 25.00, cached: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-4': { input: 3.00, output: 15.00, cached: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3.00, output: 15.00, cached: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cached: 0.30, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, cached: 0.10, cacheWrite: 1.25 },

  // OpenAI (no cache write cost)
  'gpt-4.1': { input: 2.00, output: 8.00, cached: 0.50 },
  'gpt-5-mini': { input: 0.25, output: 2.00, cached: 0.025 },
  'gpt-5.2': { input: 1.75, output: 14.00, cached: 0.175 },
  'gpt-5.2-codex': { input: 1.75, output: 14.00, cached: 0.175 },
  'gpt-5.3-codex': { input: 1.75, output: 14.00, cached: 0.175 },
  'gpt-5.4': { input: 2.50, output: 15.00, cached: 0.25 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50, cached: 0.075 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25, cached: 0.02 },
  'gpt-5.5': { input: 5.00, output: 30.00, cached: 0.50 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, cached: 0.075 },
  'gpt-4o': { input: 2.50, output: 10.00, cached: 1.25 },
  'o1': { input: 15.00, output: 60.00, cached: 7.50 },
  'o1-mini': { input: 3.00, output: 12.00, cached: 1.50 },
  'o3-mini': { input: 1.10, output: 4.40, cached: 0.55 },

  // Google (no cache write cost)
  'gemini-2.5-pro': { input: 1.25, output: 10.00, cached: 0.125 },
  'gemini-3-flash': { input: 0.50, output: 3.00, cached: 0.05 },
  'gemini-3.1-pro': { input: 2.00, output: 12.00, cached: 0.20 },
  'gemini-3.5-flash': { input: 1.50, output: 9.00, cached: 0.15 },

  // GitHub fine-tuned
  'raptor-mini': { input: 0.25, output: 2.00, cached: 0.025 },
  'goldeneye': { input: 1.25, output: 10.00, cached: 0.125 },
};
