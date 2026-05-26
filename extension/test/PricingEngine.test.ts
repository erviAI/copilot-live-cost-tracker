import { describe, it, expect } from 'vitest';
import { PricingEngine } from '../src/domain/PricingEngine.js';

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
});
