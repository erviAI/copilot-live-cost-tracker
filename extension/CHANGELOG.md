# Changelog

All notable changes to the **Copilot Live Cost & Token Tracker** extension are
documented in this file, with an emphasis on what changed for you, the user.

## [1.2.0](https://github.com/erviAI/copilot-live-cost-tracker/compare/v1.1.0...v1.2.0) (2026-06-24)


### Features

* Add per-prompt cost breakdown to dashboard activity tab ([#37](https://github.com/erviAI/copilot-live-cost-tracker/issues/37)) ([e538bf1](https://github.com/erviAI/copilot-live-cost-tracker/commit/e538bf17bf7fdc73b385a342e951c85fad39bdaf))
* **dashboard:** surface tool call args/result and model response text ([#41](https://github.com/erviAI/copilot-live-cost-tracker/issues/41)) ([9a91070](https://github.com/erviAI/copilot-live-cost-tracker/commit/9a91070e3fe9c18e5350a7156e467dc94f503785))
* persist daily cost history across agent-traces.db cleanup ([#40](https://github.com/erviAI/copilot-live-cost-tracker/issues/40)) ([2896eb9](https://github.com/erviAI/copilot-live-cost-tracker/commit/2896eb93b2b23615f917036e9f1d7e8beda65624))
* UI improvements — rename display name, collapsible sidebar sections, tool call labels ([#39](https://github.com/erviAI/copilot-live-cost-tracker/issues/39)) ([b760ad9](https://github.com/erviAI/copilot-live-cost-tracker/commit/b760ad9d3ce7e0235979ce96358405eca4bec941))

## [1.1.0](https://github.com/erviAI/cost-research/compare/v1.0.0...v1.1.0) (2026-06-22)


### Features

* add multi-tab Chart.js dashboard panel ([#33](https://github.com/erviAI/cost-research/issues/33)) ([4d8914f](https://github.com/erviAI/cost-research/commit/4d8914fdcbfd1671ffaa1bc1213cdec0b4f2a7fc))
* live context weight + global date-range filter ([#31](https://github.com/erviAI/cost-research/issues/31)) ([ca68679](https://github.com/erviAI/cost-research/commit/ca68679d6f686104e68cf44dd9ba7aad2e168bc8))

## [1.0.0](https://github.com/erviAI/cost-research/compare/v0.5.0...v1.0.0) (2026-06-22)


### ⚠ BREAKING CHANGES

* settings move from copilotCostTracker.* to copilotLiveCostTracker.*

### Features

* rebrand to Copilot Live Cost & Token Tracker ([#27](https://github.com/erviAI/cost-research/issues/27)) ([15b8ab4](https://github.com/erviAI/cost-research/commit/15b8ab4c26d87411ac1603e8fb6fa6a5887bc892))

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
