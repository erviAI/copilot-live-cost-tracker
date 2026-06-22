# Changelog

All notable changes to the **Copilot Live Cost & Token Tracker** extension are
documented in this file, with an emphasis on what changed for you, the user.

## 0.6.0 (2026-06-22)

**New name:** the extension is now **Copilot Live Cost & Token Tracker**
(previously "GitHub Copilot Cost Tracker"). The rebrand makes its purpose clearer
and gives it a unique Marketplace identity.

- ✨ Refreshed name, description, and Marketplace listing focused on *live*
  visibility into your Copilot spend — tokens, cost, and credits.
- 🧹 Settings, commands, and the activity-bar view now use the new
  `copilotLiveCostTracker.*` identifiers. If you had customised settings under
  the old `copilotCostTracker.*` keys, re-apply them under the new names.
- No change to how your data is read or stored — everything still runs 100%
  locally.

## 0.5.0 (2026-06-22)

- 💱 **Display currency** — see costs converted to your local currency (NOK, EUR,
  GBP, …) on hover.
- 💾 **Persistent cost history** — daily totals are saved to disk so your spend
  history survives Copilot database resets.
- 🗂️ **Workspace-aware sessions** — recent sessions now show which workspace they
  belong to.
- 🤖 **Smarter session tracking** — subagent (tool-call) activity is attributed to
  the right session, with prompt labels for context.
- 🎯 **Better pricing** — estimated pricing for unknown models, accurate
  Anthropic cache-aware cost calculation, and a `costDataSource` setting to choose
  your data source.
- 🧭 Clearer terminology ("model turns" instead of "requests") and a polished
  status bar and dashboard.

## 0.4.0

- Baseline release prior to automated versioning.
