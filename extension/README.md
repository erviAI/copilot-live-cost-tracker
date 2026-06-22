# GitHub Copilot Cost Tracker

Track GitHub Copilot token usage and estimated costs in real-time — directly inside VS Code.

![VS Code](https://img.shields.io/badge/VS%20Code-1.100+-blue) ![License](https://img.shields.io/badge/license-MIT-green) [![CI](https://github.com/erviAI/cost-research/actions/workflows/ci.yml/badge.svg)](https://github.com/erviAI/cost-research/actions/workflows/ci.yml)

## Features

### Real-Time Cost Dashboard

- **Activity Bar sidebar** with a live-updating dashboard showing token usage and cost breakdowns
- **Status bar indicator** displaying session and daily cost at a glance
- Per-model breakdown: see exactly which models (Claude, GPT-4o, Gemini, etc.) are consuming your budget

### Budget Alerts

- Configurable warning and limit thresholds for **session**, **daily**, and **weekly** spending
- Color-coded status bar: normal → yellow (warning) → red (limit reached)
- VS Code notifications when thresholds are crossed

### Session Tracking

- Automatic detection of the current chat session
- Historical view of recent sessions with cost summaries
- 7-day rolling window with daily cost buckets

### Cost History & Persistence

- Daily cost aggregates saved to disk so data survives database resets
- Configurable retention (7–365 days, default 90)
- Automatic background scraping with minimal I/O

### Privacy & Portability

- Reads only local Copilot telemetry and debug logs from VS Code's user storage
- Works across VS Code, VS Code Insiders, VSCodium, and portable installs — the storage location is resolved automatically from the extension's own storage path
- Cross-platform support: macOS, Windows, and Linux storage paths resolved automatically
- No data leaves your machine — all processing is 100% local

### Accurate Pricing

- Built-in pricing table covering Claude (Opus, Sonnet, Haiku), GPT-4o/4.1, o1, o3, Gemini, and more
- Fuzzy model name matching handles version suffixes and naming variations
- User-configurable pricing overrides for custom or new models

## Requirements

- **VS Code 1.100 or later** — including Insiders, VSCodium, and portable installs
- GitHub Copilot Chat extension installed (this is where the usage data comes from)

## Installation

### From the Marketplace

1. Open VS Code
2. Go to the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **"Copilot Cost Tracker"**
4. Click **Install**

### From VSIX

1. Download the `.vsix` file from [Releases](https://github.com/erviAI/cost-research/releases)
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run **Extensions: Install from VSIX…**
4. Select the downloaded file

## How to Use

1. **Install the extension** — it activates automatically when VS Code starts
2. **Open the sidebar** — click the Copilot Cost icon in the Activity Bar (left side)
3. **Use Copilot as normal** — the dashboard updates every 10 seconds (configurable)
4. **Monitor the status bar** — session and daily cost are always visible at the bottom

### Reading the dashboard

Per-model rows may carry a small badge:

- **estimated** — the model wasn't in the built-in pricing table, so its rate was inferred from a related model family. The cost is approximate.
- **unpriced** — no pricing could be resolved at all, so the model's tokens are shown but contribute `$0` to totals. Add a [custom pricing override](#custom-pricing-overrides) to price it.

### Commands

| Command | Description |
|---------|-------------|
| `Copilot Cost: Refresh Cost Data` | Force an immediate data refresh |
| `Copilot Cost: Reset Session Tracking` | Reset the current session counter |
| `Copilot Cost: Open Dashboard` | Focus the sidebar dashboard |
| `Copilot Cost: Open Settings` | Jump to extension settings |

### Configuration

All settings are under `copilotCostTracker.*` in VS Code Settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `pollingInterval` | `10` | Seconds between data refreshes |
| `budget.session.warning` | `$5` | Session cost yellow threshold |
| `budget.session.limit` | `$8` | Session cost red threshold |
| `budget.daily.warning` | `$20` | Daily cost yellow threshold |
| `budget.daily.limit` | `$50` | Daily cost red threshold |
| `budget.weekly.warning` | `$25` | Weekly cost yellow threshold |
| `budget.weekly.limit` | `$50` | Weekly cost red threshold |
| `pricingOverrides` | `{}` | Custom model pricing (per 1M tokens) — see example below |
| `costDataSource` | `agent-traces-only` | Data source strategy: `agent-traces-only` (recommended) or `with-fallback` (use debug logs when `agent-traces.db` is unavailable; cache-write data is then missing) |
| `history.enabled` | `true` | Persist daily aggregates to disk |
| `history.retentionDays` | `90` | Days to keep history files |
| `history.scrapeInterval` | `30` | Poll cycles between history writes (30 cycles ≈ 5 min at the default 10s polling) |
| `displayCurrency.code` | `""` | ISO currency code to show on hover (e.g. `NOK`, `EUR`). Leave empty to disable |
| `displayCurrency.rate` | `1` | Exchange rate: 1 USD = X units of your display currency |

Numeric settings are clamped to safe ranges, so an out-of-range value falls back to a sensible default rather than breaking polling.

### Custom pricing overrides

Use `pricingOverrides` to price new or custom models. Keys are model-name patterns; rates are **USD per 1 million tokens**. Entries that don't match this shape are ignored.

```jsonc
"copilotCostTracker.pricingOverrides": {
  "my-custom-model": {
    "input": 3.0,      // required: fresh input tokens
    "output": 15.0,    // required: output tokens
    "cached": 0.3,     // required: cache-read tokens
    "cacheWrite": 3.75 // optional: cache-write tokens
  }
}
```

## Data Sources

The extension reads from local Copilot databases in VS Code's user storage. The
location is resolved automatically per product flavour and OS (no path is
hardcoded):

| Source | Data | Notes |
|--------|------|-------|
| `agent-traces.db` | Token counts, model, timing, cache read/write | Primary source (recommended) |
| Debug logs (`main.jsonl`) | Token counts, model, timing | Fallback; no cache-write data |
| `session-store.db` | Session metadata | Names, timestamps, branches |
| `state.vscdb` | Chat session titles | User-visible conversation names |

## Known Limitations

- Cache-write token data is only available from `agent-traces.db` (not debug logs)
- Pricing for very new or custom models may require manual overrides
- Cost figures are estimates based on public API pricing — actual billing may differ

## Troubleshooting

**The dashboard says no data is available.**
Cost tracking reads `agent-traces.db`, which Copilot Chat only writes when its
OpenTelemetry tracing is enabled. Enable
`github.copilot.chat.otel.dbSpanExporter.enabled`, run a Copilot Chat session,
and restart VS Code if the file still isn't created. Until then, you can set
`copilotCostTracker.costDataSource` to `with-fallback` to estimate from debug
logs (cache-write data will be missing).

**A model shows as `unpriced` or `estimated`.**
This is expected for brand-new or custom models. Add a
[pricing override](#custom-pricing-overrides) to price it accurately.

**Nothing updates / errors in the logs.**
The extension reads the SQLite databases through a background worker that uses
your system Node.js. Check the **"Copilot Cost Tracker"** output channel for
details, then use **Copilot Cost: Refresh Cost Data** to retry.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full
workflow and guidelines.

```bash
# Clone and set up
git clone https://github.com/erviAI/cost-research.git
cd cost-research/extension
npm ci

# Development
npm run watch         # Rebuild on change
npm run lint          # Lint with ESLint
npm run typecheck     # Type-check src/ and test/
npm test              # Run tests
npm run test:coverage # Run tests with coverage

# Package
npm run package       # Produces .vsix file
```

## License

[MIT](LICENSE) © erviAI
