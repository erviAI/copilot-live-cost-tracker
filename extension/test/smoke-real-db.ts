/**
 * Quick smoke test: read the real agent-traces.db and print a cost summary.
 * Run with: node --loader ts-node/esm test/smoke-real-db.ts
 * Or:       npx tsx test/smoke-real-db.ts
 */
import * as path from 'path';
import * as os from 'os';
import { AgentTracesRepository } from '../src/data/AgentTracesRepository.js';
import { PricingEngine } from '../src/domain/PricingEngine.js';
import { CostCalculator } from '../src/domain/CostCalculator.js';
import { Aggregator } from '../src/domain/Aggregator.js';

async function main() {
  const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
  console.log(`Using APPDATA: ${appData}`);

  const repo = new AgentTracesRepository(appData);
  const available = await repo.isAvailable();
  console.log(`Database available: ${available}`);

  if (!available) {
    console.error('agent-traces.db not found. Is GitHub Copilot Chat installed?');
    process.exit(1);
  }

  const engine = new PricingEngine();
  const calculator = new CostCalculator(engine);
  const aggregator = new Aggregator(calculator);

  // Get last 7 days of spans
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const spans = await repo.getSpansSince(sevenDaysAgo);
  console.log(`\nSpans in last 7 days: ${spans.length}`);

  if (spans.length === 0) {
    console.log('No spans found.');
    repo.dispose();
    return;
  }

  // Build dashboard
  const dashboard = aggregator.buildDashboard(spans, new Map(), null);

  console.log('\n=== TODAY ===');
  console.log(`  Cost:     $${dashboard.today.totalCost.toFixed(4)}`);
  console.log(`  Requests: ${dashboard.today.requests}`);
  console.log(`  Input:    ${(dashboard.today.inputTokens / 1000).toFixed(1)}K tokens`);
  console.log(`  Output:   ${(dashboard.today.outputTokens / 1000).toFixed(1)}K tokens`);
  console.log(`  Cached:   ${(dashboard.today.cachedTokens / 1000).toFixed(1)}K tokens`);

  console.log('\n=== THIS WEEK ===');
  console.log(`  Cost:     $${dashboard.thisWeek.totalCost.toFixed(4)}`);
  console.log(`  Requests: ${dashboard.thisWeek.requests}`);

  console.log('\n=== TODAY BY MODEL ===');
  for (const m of dashboard.today.byModel) {
    console.log(`  ${m.model}: $${m.totalCost.toFixed(4)} (${m.calls} calls)`);
  }

  console.log('\n=== LAST 7 DAYS ===');
  for (const d of dashboard.last7Days) {
    const bar = '█'.repeat(Math.ceil(d.totalCost * 2));
    console.log(`  ${d.dayLabel} ${d.date}: $${d.totalCost.toFixed(2)} ${bar}`);
  }

  console.log('\n=== RECENT SESSIONS (top 5) ===');
  for (const s of dashboard.recentSessions.slice(0, 5)) {
    const ago = Math.round((Date.now() - s.endedAt) / 60000);
    console.log(`  ${s.title} — $${s.totalCost.toFixed(4)} (${ago} min ago)`);
  }

  repo.dispose();
}

main().catch(console.error);
