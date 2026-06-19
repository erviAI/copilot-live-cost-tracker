#!/usr/bin/env node
// @ts-check
/**
 * Regenerates extension/src/domain/pricing-data.ts from GitHub's published
 * Copilot pricing table.
 *
 * Source of truth (machine-readable):
 *   https://github.com/github/docs → data/tables/copilot/models-and-pricing.yml
 *
 * That YAML is the same data the docs site renders at
 *   https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 *
 * Usage:
 *   node generate.mjs            # fetch from GitHub, rewrite pricing-data.ts
 *   node generate.mjs --check    # exit 1 if pricing-data.ts is out of date
 *   PRICING_YML=./local.yml node generate.mjs   # use a local file instead
 *
 * Key derivation preserves the existing per-provider convention:
 *   - all providers: lowercase, strip "[^n]" footnotes, spaces → "-"
 *   - Anthropic only: also convert "." → "-" (e.g. "Claude Opus 4.5" → claude-opus-4-5)
 *   - others keep dots (e.g. "GPT-5.4 mini" → gpt-5.4-mini, "Gemini 2.5 Pro" → gemini-2.5-pro)
 * PricingEngine.resolve() normalizes dots to dashes at lookup time, so either
 * shape still matches telemetry identifiers.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { load as parseYaml } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

const YAML_URL =
  'https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml';
const OUTPUT_PATH = resolve(__dirname, '../../extension/src/domain/pricing-data.ts');
const EXTRAS_PATH = resolve(__dirname, 'extra-models.json');

/** Display label + ordering for each provider group. */
const PROVIDER_GROUPS = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'anthropic', label: 'Anthropic (includes cache write cost)' },
  { id: 'google', label: 'Google' },
  { id: 'xai', label: 'xAI' },
  { id: 'github', label: 'GitHub fine-tuned' },
];

/** @param {string} model @param {string} provider */
function toKey(model, provider) {
  let key = String(model).toLowerCase();
  key = key.replace(/\[\^[^\]]*\]/g, ''); // strip footnote markers like [^1]
  key = key.trim().replace(/\s+/g, '-');
  if (provider === 'anthropic') key = key.replace(/\./g, '-');
  return key;
}

/**
 * Turn a "$5.00" price string into a JS numeric literal string, preserving the
 * source decimals so the generated file matches GitHub's published precision.
 * @param {unknown} raw
 * @returns {string | null}
 */
function priceLiteral(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (cleaned === '' || Number.isNaN(Number(cleaned))) return null;
  return cleaned;
}

/** @param {number} n */
function numberLiteral(n) {
  // Preserve at least 2 decimal places to match the published table's style
  // (e.g. 2.5 → "2.50", 10 → "10.00"), without truncating finer precision
  // (e.g. 0.075 stays "0.075").
  const decimals = (String(n).split('.')[1] || '').length;
  return n.toFixed(Math.max(2, decimals));
}

async function loadYamlText() {
  const localPath = process.env.PRICING_YML;
  if (localPath) {
    return readFile(resolve(process.cwd(), localPath), 'utf8');
  }
  const res = await fetch(YAML_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch pricing YAML: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

function renderEntry(key, fields) {
  const parts = [`input: ${fields.input}`, `output: ${fields.output}`, `cached: ${fields.cached}`];
  if (fields.cacheWrite !== undefined && fields.cacheWrite !== null) {
    parts.push(`cacheWrite: ${fields.cacheWrite}`);
  }
  return `  '${key}': { ${parts.join(', ')} },`;
}

async function build() {
  const yamlText = await loadYamlText();
  const entries = parseYaml(yamlText);
  if (!Array.isArray(entries)) {
    throw new Error('Unexpected YAML shape: expected a top-level array of models.');
  }

  const extrasRaw = JSON.parse(await readFile(EXTRAS_PATH, 'utf8'));

  const seenKeys = new Set();
  const byProvider = new Map();
  for (const entry of entries) {
    const provider = String(entry.provider || '').toLowerCase();
    const key = toKey(entry.model, provider);
    const input = priceLiteral(entry.input);
    const output = priceLiteral(entry.output);
    const cached = priceLiteral(entry.cached_input);
    const cacheWrite = priceLiteral(entry.cache_write);

    if (input === null || output === null || cached === null) {
      throw new Error(`Missing price for model "${entry.model}" (provider ${provider}).`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate key generated: "${key}".`);
    }
    seenKeys.add(key);

    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push({ key, input, output, cached, cacheWrite });
  }

  const lines = [];
  lines.push("import type { ModelPricing } from './models.js';");
  lines.push('');
  lines.push('/**');
  lines.push(' * GitHub Copilot model pricing. All rates are per 1 million tokens in USD.');
  lines.push(' *');
  lines.push(' * AUTO-GENERATED by tools/update-pricing/generate.mjs — do not edit by hand.');
  lines.push(' * Source: https://github.com/github/docs/blob/main/data/tables/copilot/models-and-pricing.yml');
  lines.push(' * To change legacy/extra models, edit tools/update-pricing/extra-models.json.');
  lines.push(' */');
  lines.push('export const DEFAULT_PRICING: Record<string, ModelPricing> = {');

  let firstGroup = true;
  for (const group of PROVIDER_GROUPS) {
    const rows = byProvider.get(group.id);
    if (!rows || rows.length === 0) continue;
    if (!firstGroup) lines.push('');
    firstGroup = false;
    lines.push(`  // ${group.label}`);
    for (const row of rows) {
      lines.push(renderEntry(row.key, row));
    }
  }

  // Any providers not in PROVIDER_GROUPS (future-proofing).
  for (const [provider, rows] of byProvider) {
    if (PROVIDER_GROUPS.some((g) => g.id === provider)) continue;
    lines.push('');
    lines.push(`  // ${provider}`);
    for (const row of rows) lines.push(renderEntry(row.key, row));
  }

  // Extra / legacy models not present in the published table.
  const extras = extrasRaw.models || {};
  const extraKeys = Object.keys(extras).filter((k) => !seenKeys.has(k));
  if (extraKeys.length > 0) {
    lines.push('');
    lines.push('  // Additional models not in the official pricing table (see extra-models.json)');
    for (const key of extraKeys) {
      const m = extras[key];
      lines.push(
        renderEntry(key, {
          input: numberLiteral(m.input),
          output: numberLiteral(m.output),
          cached: numberLiteral(m.cached),
          cacheWrite: m.cacheWrite === undefined ? undefined : numberLiteral(m.cacheWrite),
        }),
      );
    }
  }

  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const content = await build();
  const check = process.argv.includes('--check');

  if (check) {
    let current = '';
    try {
      current = await readFile(OUTPUT_PATH, 'utf8');
    } catch {
      // file missing → out of date
    }
    if (current.replace(/\r\n/g, '\n') !== content) {
      console.error('pricing-data.ts is out of date. Run: node tools/update-pricing/generate.mjs');
      process.exit(1);
    }
    console.log('pricing-data.ts is up to date.');
    return;
  }

  await writeFile(OUTPUT_PATH, content, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
