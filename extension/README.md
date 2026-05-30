# GitHub Copilot Cost Tracker

Track GitHub Copilot token usage and estimated costs in real-time — directly inside VS Code.

![VS Code](https://img.shields.io/badge/VS%20Code-1.100+-blue) ![License](https://img.shields.io/badge/license-MIT-green)

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

- Reads only local Copilot agent debug logs from VS Code / VS Code Insiders workspace storage
- Cross-platform support: macOS, Windows, and Linux storage paths resolved automatically
- No data leaves your machine — all processing is 100% local

### Accurate Pricing

- Built-in pricing table covering Claude (Opus, Sonnet, Haiku), GPT-4o/4.1, o1, o3, Gemini, and more
- Fuzzy model name matching handles version suffixes and naming variations
- User-configurable pricing overrides for custom or new models

## Requirements

- **VS Code 1.100 or later**, or **VS Code Insiders**
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
| `pricingOverrides` | `{}` | Custom model pricing (per 1M tokens) |
| `costDataSource` | `agent-traces-only` | Data source strategy |
| `history.enabled` | `true` | Persist daily aggregates to disk |
| `history.retentionDays` | `90` | Days to keep history files |

## Data Sources

The extension reads from local Copilot databases stored in VS Code's workspace storage:

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

## Contributing

Contributions are welcome! Please open an issue or pull request on [GitHub](https://github.com/erviAI/cost-research).

```bash
# Clone and set up
git clone https://github.com/erviAI/cost-research.git
cd cost-research/extension
npm install

# Development
npm run watch    # Rebuild on change
npm run test     # Run tests

# Package
npm run package  # Produces .vsix file
```

## License

[MIT](LICENSE) © erviAI
