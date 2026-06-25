# Copilot Live Cost & Token Tracker

**Know exactly what GitHub Copilot is costing you — every token, every prompt, every tool call — live in your status bar as you work.**

Copilot bills by tokens and credits, but VS Code never shows you *where* it goes. This extension does: a real-time gauge in your status bar, a multi-tab dashboard that breaks spend down by model, by prompt, and by token type, and budget alerts before you blow past your limit. Every figure is computed **100% locally** — no account login, no telemetry, no data ever leaves your machine.

![VS Code](https://img.shields.io/badge/VS%20Code-1.125+-blue) ![License](https://img.shields.io/badge/license-MIT-green) [![CI](https://github.com/erviAI/copilot-live-cost-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/erviAI/copilot-live-cost-tracker/actions/workflows/ci.yml)

## Why you'll want it

- 🔬 **Total token transparency** — fresh input, **cache read**, **cache write**, and output tokens are tracked and priced separately, never lumped into one opaque number.
- 🔍 **Drill all the way down** — from a session, to a single prompt, to the model calls and tool calls inside it.
- 💸 **No more surprise bills** — watch session, daily, and weekly spend update live while you chat.
- 🚦 **Stop before you overspend** — color-coded warnings and notifications at thresholds you set.
- 🔒 **Truly private** — reads only local Copilot data; nothing is uploaded, ever.

## Features

### 🔬 Transparent token & pricing breakdown

Copilot's cost isn't one number — it's different token types billed at very different rates, and this extension keeps them separate:

- **Fresh input**, **cache read**, **cache write**, and **output** tokens are each tracked and priced independently — so you can see how much of your bill is cache-write overhead versus real output.
- All rates are **USD per 1M tokens**, visible and overridable. Nothing is hidden behind a black box, and models we can't price are clearly badged rather than silently dropped.

### 🔍 Drill down from session to tool call

- **Session view** — recent chat sessions, each with its own running cost and turn count.
- **Per-prompt breakdown** — expand a session to see the cost of every individual user prompt.
- **Inside a prompt** — open any prompt to inspect its model calls, **tool calls** (arguments, results, errors), and subagent activity, each with its own token and cost contribution.
- One click on the status bar or a session row jumps straight to the relevant detail.

### 📊 Multi-tab dashboard

A live dashboard in the Activity Bar sidebar (plus a full-window panel), refreshed automatically as you work:

- **Activity tab** — token cards for fresh input / cache read / cache write / output, plus a cost-per-prompt table grouped by session.
- **Cost tab** — KPI cards (Today, This Week, selected range, context weight) and a cost-history **line chart**.
- **Models tab** — a **doughnut chart** and table breaking spend down per model.
- A **7 / 30 / 90-day** range selector drives every card, chart, and table.

### 🧮 Status bar gauge

- Always-visible readout of **session cost**, **today's cost**, and current **context weight**.
- Hover for the full picture: session / daily / weekly spend, model turn counts, today's token split, and optional conversion to your local currency.
- The background turns yellow at your warning threshold and red at your limit.

### 🚦 Budget alerts

- Warning and limit thresholds for **session**, **daily**, and **weekly** spending.
- A VS Code notification fires the moment a threshold is crossed — once per threshold, re-arming only after spend drops back below it.

### 🕑 Session history that survives resets

- Automatically detects your current chat session and summarizes recent ones.
- View the last 7, 30, or 90 days in the dashboard, with daily cost buckets.
- Daily aggregates are saved to disk, so your history survives Copilot database resets — with configurable retention (7–365 days, default 90).

### 🎯 Accurate model pricing

- Built-in pricing for current Claude (Opus, Sonnet, Haiku), the GPT-5 family, Gemini, and more.
- Fuzzy name matching handles version suffixes and brand-new releases automatically, falling back to the closest known sibling. Anything inferred or unknown is badged (see [Reading the dashboard](#reading-the-dashboard)).
- Add your own rates for custom or unlisted models via [pricing overrides](#custom-pricing-overrides).

### 🔒 Private & portable

- Works across VS Code, VS Code Insiders, VSCodium, and portable installs on macOS, Windows, and Linux — the storage location is resolved automatically, with nothing to configure.

## Requirements

- **VS Code 1.125 or later** — including Insiders, VSCodium, and portable installs
- GitHub Copilot Chat extension installed (this is where the usage data comes from)
- **Node.js 24 on your PATH** — the extension reads `agent-traces.db` through a background worker that runs your host's **system Node.js**, *not* the runtime bundled with VS Code. Node 24 (the version the native SQLite binding is built for) must be installed and on `PATH`.
- **OpenTelemetry tracing enabled** in Copilot Chat (`github.copilot.chat.otel.dbSpanExporter.enabled`) — this is what populates the data source. Run **Copilot Live Cost & Token Tracker: Enable OpenTelemetry Tracing**, or accept the prompt the extension shows on first run.

## Installation

### From the Marketplace

1. Open VS Code
2. Go to the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
3. Search for **"Copilot Live Cost & Token Tracker"**
4. Click **Install**

### From VSIX

1. Download the `.vsix` file from [Releases](https://github.com/erviAI/copilot-live-cost-tracker/releases)
2. In VS Code, open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Run **Extensions: Install from VSIX…**
4. Select the downloaded file

## How to Use

1. **Install the extension** — it activates automatically when VS Code starts
2. **Open the sidebar** — click the Copilot Cost icon in the Activity Bar (left side)
3. **Use Copilot as normal** — the dashboard updates every 10 seconds (configurable)
4. **Monitor the status bar** — session and daily cost are always visible at the bottom

### Reading the dashboard

Switch between the **Activity**, **Cost**, and **Models** tabs, and use the **7 / 30 / 90-day** selector to set the range for every card, chart, and table.

To drill down, expand a session to see its individual prompts, then open a prompt to inspect its model calls, tool calls (arguments, results, errors), and subagent activity — each with its own token and cost contribution.

Per-model rows may carry a small badge:

- **estimated** — the model wasn't in the built-in pricing table, so its rate was inferred from a related model family. The cost is approximate.
- **unpriced** — no pricing could be resolved at all, so the model's tokens are shown but contribute `$0` to totals. Add a [custom pricing override](#custom-pricing-overrides) to price it.

### Commands

| Command | Description |
|---------|-------------|
| `Copilot Live Cost & Token Tracker: Refresh Cost Data` | Force an immediate data refresh |
| `Copilot Live Cost & Token Tracker: Reset Session Tracking` | Reset the current session counter and budget alerts |
| `Copilot Live Cost & Token Tracker: Open Dashboard` | Open the full-window dashboard |
| `Copilot Live Cost & Token Tracker: Open Settings` | Jump to extension settings |
| `Copilot Live Cost & Token Tracker: Enable OpenTelemetry Tracing` | Turn on the Copilot setting that populates the data source |

### Configuration

All settings are under `copilotLiveCostTracker.*` in VS Code Settings:

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
"copilotLiveCostTracker.pricingOverrides": {
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
OpenTelemetry tracing is enabled. Run **Copilot Live Cost & Token Tracker: Enable
OpenTelemetry Tracing** (or enable
`github.copilot.chat.otel.dbSpanExporter.enabled` yourself), run a Copilot Chat
session, and restart VS Code if the file still isn't created. Until then, you can
set `copilotLiveCostTracker.costDataSource` to `with-fallback` to estimate from
debug logs (cache-write data will be missing).

**A model shows as `unpriced` or `estimated`.**
This is expected for brand-new or custom models. Add a
[pricing override](#custom-pricing-overrides) to price it accurately.

**Nothing updates / errors in the logs.**
The extension reads the SQLite databases through a background worker that uses
your system Node.js. Check the **"Copilot Live Cost & Token Tracker"** output
channel for details, then use **Copilot Live Cost & Token Tracker: Refresh Cost
Data** to retry.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full
development workflow, build and test scripts, and guidelines.

## License

[MIT](LICENSE) © erviAI
