import { describe, it, expect } from 'vitest';
import { PricingEngine } from '../src/domain/PricingEngine.js';
import { TEST_PRICING } from './mocks/pricing.js';

describe('PricingEngine', () => {
  const engine = new PricingEngine();

  describe('exact match', () => {
    it('resolves claude-opus-4-5 exactly', () => {
      const pricing = engine.resolve('claude-opus-4-5');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(5.00);
      expect(pricing!.output).toBe(25.00);
      expect(pricing!.cached).toBe(0.50);
      expect(pricing!.cacheWrite).toBe(6.25);
    });

    it('resolves gpt-4.1 exactly', () => {
      const pricing = engine.resolve('gpt-4.1');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(2.00);
      expect(pricing!.output).toBe(8.00);
      expect(pricing!.cached).toBe(0.50);
      expect(pricing!.cacheWrite).toBeUndefined();
    });

    it('resolves gemini-2.5-pro exactly', () => {
      const pricing = engine.resolve('gemini-2.5-pro');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(1.25);
      expect(pricing!.output).toBe(10.00);
    });
  });

  describe('date suffix stripping', () => {
    it('resolves claude-opus-4-5-20251101', () => {
      const pricing = engine.resolve('claude-opus-4-5-20251101');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(5.00);
    });

    it('resolves gpt-4.1-2025-04-14', () => {
      const pricing = engine.resolve('gpt-4.1-2025-04-14');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(2.00);
    });

    it('resolves claude-sonnet-4-6-20260401', () => {
      const pricing = engine.resolve('claude-sonnet-4-6-20260401');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(3.00);
      expect(pricing!.output).toBe(15.00);
    });
  });

  describe('prefix matching', () => {
    it('resolves claude-opus-4-5-preview as claude-opus-4-5', () => {
      const pricing = engine.resolve('claude-opus-4-5-preview');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(5.00);
    });
  });

  describe('case insensitivity', () => {
    it('resolves Claude-Opus-4-5 (mixed case)', () => {
      const pricing = engine.resolve('Claude-Opus-4-5');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(5.00);
    });
  });

  describe('unknown models', () => {
    it('returns null for completely unknown model', () => {
      const pricing = engine.resolve('totally-unknown-model-xyz');
      expect(pricing).toBeNull();
    });

    it('returns null for empty string', () => {
      const pricing = engine.resolve('');
      expect(pricing).toBeNull();
    });
  });

  describe('family fallback (estimated pricing)', () => {
    const engine = new PricingEngine({
      'test-family-2': { input: 3, output: 15, cached: 0.3, cacheWrite: 3.75 },
      'test-family-10': { input: 5, output: 25, cached: 0.5, cacheWrite: 6.25 },
      'test-family-99-(fast-mode)': { input: 10, output: 50, cached: 1, cacheWrite: 12.5 },
      'test-other-20': { input: 2, output: 8, cached: 0.5 },
    });

    it('prices an unknown version from the latest known family member', () => {
      const pricing = engine.resolve('test-family-50-1');
      expect(pricing).not.toBeNull();
      expect(pricing!.estimated).toBe(true);
      expect(pricing!.input).toBe(5.00);
      expect(pricing!.output).toBe(25.00);
      expect(pricing!.cached).toBe(0.50);
      expect(pricing!.cacheWrite).toBe(6.25);
    });

    it('accepts dotted version numbers too', () => {
      const pricing = engine.resolve('test-family-50.1');
      expect(pricing).not.toBeNull();
      expect(pricing!.estimated).toBe(true);
      expect(pricing!.output).toBe(25.00);
    });

    it('picks the highest known version within the family', () => {
      const pricing = engine.resolve('test-family-50');
      expect(pricing).toEqual({
        input: 5, output: 25, cached: 0.5, cacheWrite: 6.25, estimated: true,
      });
    });

    it('does not flag exact matches as estimated', () => {
      const pricing = engine.resolve('test-family-2');
      expect(pricing!.estimated).toBeUndefined();
    });

    it('does not fall back across unrelated families sharing only a provider', () => {
      const pricing = engine.resolve('test-unrelated-2');
      expect(pricing).toBeNull();
    });
  });

  describe('user overrides', () => {
    it('overrides existing model pricing', () => {
      const custom = new PricingEngine({
        'claude-opus-4-5': { input: 99.99, output: 99.99, cached: 9.99, cacheWrite: 19.99 },
      });
      const pricing = custom.resolve('claude-opus-4-5');
      expect(pricing!.input).toBe(99.99);
    });

    it('adds new model pricing', () => {
      const custom = new PricingEngine({
        'my-custom-model': { input: 1.00, output: 2.00, cached: 0.10 },
      });
      const pricing = custom.resolve('my-custom-model');
      expect(pricing).not.toBeNull();
      expect(pricing!.input).toBe(1.00);
    });
  });

  describe('getKnownModels', () => {
    it('returns all model keys', () => {
      const models = engine.getKnownModels();
      expect(models).toContain('claude-opus-4-5');
      expect(models).toContain('gpt-4.1');
      expect(models).toContain('gemini-2.5-pro');
      expect(models.length).toBeGreaterThan(10);
    });
  });

  describe('long context tier', () => {
    const engine = new PricingEngine(TEST_PRICING);

    it('exposes the configured overflow tier for tiered models', () => {
      const pricing = engine.resolve('test-tiered')!;
      expect(pricing.longContext).toEqual({
        thresholdTokens: 272_000,
        input: 4.0,
        output: 15.0,
        cached: 0.4,
        cacheWrite: 5.0,
      });
    });

    it('omits the tier for flat-priced models', () => {
      expect(engine.resolve('test-flat')!.longContext).toBeUndefined();
      expect(engine.resolve('test-readonly')!.longContext).toBeUndefined();
    });

    it('preserves the tier through fuzzy version matching', () => {
      const pricing = engine.resolve('test-tiered-20260101')!;
      expect(pricing.input).toBe(2.0);
      expect(pricing.longContext?.thresholdTokens).toBe(272_000);
    });
  });
});
