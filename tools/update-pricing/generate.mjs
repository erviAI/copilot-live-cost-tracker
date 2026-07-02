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

import { readFile, writeFile, appendFile } from 'node:fs/promises';
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
 * Detect the "Long context" overflow tier of a tiered-pricing model. GitHub
 * lists these as a second row sharing the same model name, with a threshold
 * like "> 272K" and a tier label such as "Long context".
 * @param {{ threshold?: unknown, tier?: unknown }} entry
 */
function isLongContextTier(entry) {
  const threshold = String(entry.threshold ?? '').trim();
  const tier = String(entry.tier ?? '').trim().toLowerCase();
  return threshold.startsWith('>') || tier === 'long context';
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

/**
 * Join model keys for display, truncating long lists so PR titles stay readable.
 * @param {string[]} keys @param {number} [max]
 */
function formatNames(keys, max = 4) {
  if (keys.length <= max) return keys.join(', ');
  return `${keys.slice(0, max).join(', ')} +${keys.length - max} more`;
}

/**
 * Build a Conventional Commits-style title describing this run's model
 * additions/removals, so the PR title (and commit message) reflect the actual
 * diff instead of a generic message. Falls back to a generic description when
 * only rates changed for already-known models.
 * @param {string[]} addedKeys @param {string[]} removedKeys
 */
function buildPrTitle(addedKeys, removedKeys) {
  const clauses = [];
  if (addedKeys.length > 0) clauses.push(`add ${formatNames(addedKeys)}`);
  if (removedKeys.length > 0) clauses.push(`drop ${formatNames(removedKeys)}`);
  if (clauses.length === 0) return 'fix(models): update Copilot model pricing';
  return `fix(models): ${clauses.join('; ')}`;
}

/**
 * Build a markdown fragment summarizing model additions/removals for the PR
 * body. Unlike the title, names are never truncated here.
 * @param {string[]} addedKeys @param {string[]} removedKeys
 */
function buildModelChangesBody(addedKeys, removedKeys) {
  if (addedKeys.length === 0 && removedKeys.length === 0) {
    return '_No models added or removed this run — existing rates were refreshed._';
  }
  const lines = ['**Model changes this run:**'];
  if (addedKeys.length > 0) lines.push(`- Added: ${addedKeys.join(', ')}`);
  if (removedKeys.length > 0) lines.push(`- Dropped (moved to deprecated): ${removedKeys.join(', ')}`);
  return lines.join('\n');
}

/**
 * Parse a previously generated pricing-data.ts into a Map of key -> numeric
 * rates. Used to capture the last-known rates of a model at the moment it is
 * dropped from the published table, so it can be migrated into extra-models.json.
 * @param {string} content
 * @returns {Map<string, { input: number, output: number, cached: number, cacheWrite?: number }>}
 */
function parseGeneratedPricing(content) {
  /** @type {Map<string, any>} */
  const map = new Map();
  if (!content) return map;
  const lineRe = /^\s*'([^']+)':\s*\{\s*(.+?)\s*\},?\s*$/;
  for (const line of content.split(/\r?\n/)) {
    const m = lineRe.exec(line);
    if (!m) continue;
    /** @type {Record<string, number>} */
    const fields = {};
    for (const pair of m[2].split(',')) {
      const [name, value] = pair.split(':').map((s) => s.trim());
      if (name && value !== undefined && !Number.isNaN(Number(value))) {
        fields[name] = Number(value);
      }
    }
    if (fields.input !== undefined && fields.output !== undefined && fields.cached !== undefined) {
      map.set(m[1], fields);
    }
  }
  return map;
}

/**
 * Serialize the extras object back to extra-models.json, preserving the
 * compact one-line-per-model style (each model object on a single line).
 * @param {{ _comment?: string, models: Record<string, any> }} extrasObj
 */
function serializeExtras(extrasObj) {
  const fieldOrder = ['input', 'output', 'cached', 'cacheWrite', 'deprecated'];
  const models = extrasObj.models || {};
  const modelLines = Object.entries(models).map(([key, m]) => {
    const fields = fieldOrder
      .filter((f) => m[f] !== undefined)
      .map((f) => `"${f}": ${JSON.stringify(m[f])}`)
      .join(', ');
    return `    ${JSON.stringify(key)}: { ${fields} }`;
  });
  const head = extrasObj._comment !== undefined ? `  "_comment": ${JSON.stringify(extrasObj._comment)},\n` : '';
  return `{\n${head}  "models": {\n${modelLines.join(',\n')}\n  }\n}\n`;
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
      // GitHub publishes tiered pricing as multiple rows sharing the same model
      // name (a "Default" tier plus a "Long context" overflow tier for inputs
      // above a threshold). Telemetry does not distinguish tiers, so we keep the
      // headline Default tier (first row) and skip the long-context overflow row.
      if (isLongContextTier(entry)) continue;
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

  // Extra / legacy models not present in the published table, curated in
  // extra-models.json. When a model is dropped from the published table, its
  // last-known rates are migrated here (flagged "deprecated": true) so old
  // telemetry keeps resolving instead of silently losing its pricing.
  const extras = extrasRaw.models || {};

  // Auto-capture: models that were in the previously generated file but are no
  // longer in the published table and not already tracked in extras. Migrate
  // them into extras with their last-known rates and a deprecated flag.
  let previousContent = '';
  try {
    previousContent = await readFile(OUTPUT_PATH, 'utf8');
  } catch {
    // No prior file → nothing to migrate.
  }
  const previous = parseGeneratedPricing(previousContent);
  let extrasChanged = false;
  /** Keys dropped from the published table this run (migrated to deprecated). */
  const removedKeys = [];
  for (const [key, rates] of previous) {
    if (seenKeys.has(key)) continue; // still published
    if (Object.prototype.hasOwnProperty.call(extras, key)) continue; // already tracked
    extras[key] = {
      input: rates.input,
      output: rates.output,
      cached: rates.cached,
      ...(rates.cacheWrite !== undefined ? { cacheWrite: rates.cacheWrite } : {}),
      deprecated: true,
    };
    extrasChanged = true;
    removedKeys.push(key);
  }
  removedKeys.sort();
  /** Keys published this run that weren't present in the previously generated file at all. */
  const addedKeys = [...seenKeys].filter((k) => !previous.has(k)).sort();

  /** @param {string} key @param {any} m */
  const renderExtra = (key, m) =>
    renderEntry(key, {
      input: numberLiteral(m.input),
      output: numberLiteral(m.output),
      cached: numberLiteral(m.cached),
      cacheWrite: m.cacheWrite === undefined ? undefined : numberLiteral(m.cacheWrite),
    });

  const additionalKeys = Object.keys(extras).filter((k) => !seenKeys.has(k) && !extras[k].deprecated);
  if (additionalKeys.length > 0) {
    lines.push('');
    lines.push('  // Additional models not in the official pricing table (see extra-models.json)');
    for (const key of additionalKeys) lines.push(renderExtra(key, extras[key]));
  }

  const deprecatedKeys = Object.keys(extras).filter((k) => !seenKeys.has(k) && extras[k].deprecated);
  if (deprecatedKeys.length > 0) {
    lines.push('');
    lines.push('  // Deprecated models retained for historical telemetry (see extra-models.json)');
    for (const key of deprecatedKeys) lines.push(renderExtra(key, extras[key]));
  }

  lines.push('};');
  lines.push('');
  return { content: lines.join('\n'), extras: extrasRaw, extrasChanged, addedKeys, removedKeys };
}

async function main() {
  const { content, extras, extrasChanged, addedKeys, removedKeys } = await build();
  const check = process.argv.includes('--check');
  const extrasText = serializeExtras(extras);

  if (check) {
    let currentPricing = '';
    let currentExtras = '';
    try {
      currentPricing = await readFile(OUTPUT_PATH, 'utf8');
    } catch {
      // file missing → out of date
    }
    try {
      currentExtras = await readFile(EXTRAS_PATH, 'utf8');
    } catch {
      // file missing → out of date
    }
    const stale =
      currentPricing.replace(/\r\n/g, '\n') !== content ||
      currentExtras.replace(/\r\n/g, '\n') !== extrasText;
    if (stale) {
      console.error('pricing data is out of date. Run: node tools/update-pricing/generate.mjs');
      process.exit(1);
    }
    console.log('pricing data is up to date.');
    return;
  }

  let currentExtrasOnDisk = '';
  try {
    currentExtrasOnDisk = await readFile(EXTRAS_PATH, 'utf8');
  } catch {
    // file missing → will be written
  }
  if (currentExtrasOnDisk.replace(/\r\n/g, '\n') !== extrasText) {
    await writeFile(EXTRAS_PATH, extrasText, 'utf8');
    console.log(extrasChanged ? `Updated ${EXTRAS_PATH} (migrated deprecated models)` : `Updated ${EXTRAS_PATH}`);
  }
  await writeFile(OUTPUT_PATH, content, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}`);

  const prTitle = buildPrTitle(addedKeys, removedKeys);
  const modelChangesBody = buildModelChangesBody(addedKeys, removedKeys);
  console.log(prTitle);

  if (process.env.GITHUB_OUTPUT) {
    const delimiter = `ghadelim_${Math.random().toString(36).slice(2)}`;
    const outputLines = [
      `pr_title=${prTitle}`,
      `model_changes_body<<${delimiter}`,
      modelChangesBody,
      delimiter,
      '',
    ];
    await appendFile(process.env.GITHUB_OUTPUT, outputLines.join('\n'), 'utf8');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
