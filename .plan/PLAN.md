# Plan: GitHub Copilot Cost Tracker Extension

## TL;DR
A marketplace-ready VS Code extension that tracks GitHub Copilot token usage in real-time, calculates costs using the official per-token pricing model, and displays them via a sidebar webview (dashboard) and status bar item. Uses `@vscode/sqlite3` for reading agent-traces.db (primary, WAL-aware) and session-store.db (metadata). Follows SOLID with clear separation into data, domain, and presentation layers.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│  Presentation Layer                                      │
│  ├── StatusBarController (status bar item)              │
│  ├── SidebarWebviewProvider (webview panels)            │
│  └── WebviewPanels (Today, ByModel, Session, History, Chart) │
├─────────────────────────────────────────────────────────┤
│  Application Layer                                       │
│  ├── CostTrackingService (orchestrates polling + events)│
│  └── BudgetAlertService (threshold checks + warnings)   │
├─────────────────────────────────────────────────────────┤
│  Domain Layer                                            │
│  ├── PricingEngine (model → rate lookup + calculation)  │
│  ├── CostCalculator (tokens × rates → cost)            │
│  └── Aggregator (group by session/model/day/week)       │
├─────────────────────────────────────────────────────────┤
│  Data Layer                                              │
│  ├── AgentTracesRepository (spans, token data)          │
│  ├── SessionStoreRepository (session metadata)          │
│  └── StateRepository (session titles from state.vscdb)  │
└─────────────────────────────────────────────────────────┘
```

## Steps

### Phase 1: Project Scaffold

1. **Initialize extension project** in `extension/` folder within this workspace
   - `package.json` with VS Code engine, activation events, contributes (viewContainer, views, commands, configuration)
   - `tsconfig.json` targeting ES2022, strict mode
   - ESLint + Prettier config
   - esbuild bundler config (external native modules)

2. **Define extension contributions** in package.json:
   - Activity bar icon + sidebar view container (`copilot-cost-tracker`)
   - Status bar item (left-aligned, priority)
   - Configuration settings: polling interval, budget thresholds (session/daily/weekly warning + limit), pricing overrides
   - Commands: refresh, reset session, open dashboard, open settings

### Phase 2: Data Layer

3. **Create `ISessionDataSource` interface** — abstracts DB access
   - `getSpansForSession(sessionId): Promise<Span[]>`
   - `getSpansSince(timestampMs): Promise<Span[]>`
   - `getActiveSessions(): Promise<SessionSummary[]>`
   - `getRecentSessions(limit): Promise<SessionInfo[]>`

4. **Implement `AgentTracesRepository`** using `@vscode/sqlite3`
   - Opens `%APPDATA%/Code/User/globalStorage/github.copilot-chat/agent-traces.db` read-only
   - Queries `spans` table joined with `span_attributes` for cache writes
   - Groups by `response_model` for per-model breakdowns
   - Handles WAL mode (native SQLite reads WAL automatically)
   - Key query: aggregate tokens by session, by model, by time range

5. **Implement `SessionStoreRepository`**
   - Opens `session-store.db` read-only
   - Provides session metadata (summary, agent_name, timestamps, cwd)
   - Provides turn data for session names

6. **Implement `StateRepository`**
   - Opens workspace `state.vscdb` read-only
   - Extracts session titles from `chat.ChatSessionStore.index` JSON blob
   - Used for display names in the session list

### Phase 3: Domain Layer

7. **Create `PricingEngine`**
   - Data structure: `Map<modelPattern, { input, cached, cacheWrite?, output }>`  (rates per 1M tokens)
   - Built-in defaults from GitHub's official pricing (May 2026):
     - Anthropic: Claude Opus 4.5/4.6/4.7 ($5.00 input, $0.50 cached, $6.25 cache write, $25.00 output)
     - Claude Sonnet 4/4.5/4.6 ($3.00 / $0.30 / $3.75 / $15.00)
     - Claude Haiku 4.5 ($1.00 / $0.10 / $1.25 / $5.00)
     - OpenAI: GPT-4.1 ($2.00 / $0.50 / — / $8.00)
     - GPT-5 mini ($0.25 / $0.025 / — / $2.00)
     - Google: Gemini 2.5 Pro ($1.25 / $0.125 / — / $10.00)
     - etc.
   - Model name fuzzy matching (response_model strings like `claude-opus-4-5-20251101` → pricing entry)
   - Extensible via user configuration (settings.json overrides)
   - Open/Closed: new models added to config without changing calculation logic

8. **Create `CostCalculator`**
   - Input: token counts (input, output, cached_read, cache_write) + model identifier
   - Uses PricingEngine to look up rates
   - Formula:
     - `freshInputCost = (inputTokens - cachedTokens) × inputRate / 1_000_000`
     - `cacheReadCost = cachedTokens × cachedRate / 1_000_000`
     - `cacheWriteCost = cacheWriteTokens × cacheWriteRate / 1_000_000`
     - `outputCost = outputTokens × outputRate / 1_000_000`
     - `totalCost = freshInputCost + cacheReadCost + cacheWriteCost + outputCost`

9. **Create `Aggregator`**
   - Aggregates costs by: current session, today, this week, per-model, per-session history
   - Time bucketing for the "Last 7 Days" chart
   - Returns typed DTOs consumed by the presentation layer

### Phase 4: Presentation Layer

10. **Create `StatusBarController`**
    - Displays: `$(pulse) Session: $0.42 | Today: $12.88`
    - Color coding: green (under warning), yellow (warning threshold), red (over limit)
    - Click action: opens sidebar / dashboard
    - Updates on polling interval

11. **Create `SidebarWebviewProvider`** implementing `vscode.WebviewViewProvider`
    - Renders HTML/CSS dashboard in the sidebar activity bar view
    - Independent panels that render separately:
      - **Today card**: total cost, requests, input/output/cached token counts
      - **This Week card**: total cost, request count
      - **Today by Model**: breakdown table (model → cost)
      - **Current Session card**: cost, requests, tokens
      - **Last 7 Days chart**: simple bar chart (CSS-only or lightweight SVG)
      - **Recent Sessions list**: session name, model, time ago, cost
    - Message passing: extension ↔ webview via `postMessage`/`onDidReceiveMessage`
    - Dark theme aware (uses VS Code CSS variables)

12. **Create webview HTML/CSS/JS assets**
    - Minimal, no heavy frameworks (vanilla JS or Preact for reactivity)
    - CSS uses `--vscode-*` variables for native theme integration
    - Responsive layout for sidebar width constraints

### Phase 5: Application & Infrastructure

13. **Create `CostTrackingService`** (orchestrator)
    - Polls agent-traces.db on configurable interval (default: 10 seconds)
    - Detects current active session (most recent session with recent activity)
    - Emits events when data changes (EventEmitter pattern)
    - Caches last-known state to avoid redundant recalculations
    - Determines "today" and "this week" boundaries (midnight-based)

14. **Create `BudgetAlertService`**
    - Subscribes to CostTrackingService events
    - Checks against configured thresholds (session/daily/weekly)
    - Two levels: **warning** (yellow notification) and **limit** (red notification + optional disable)
    - Uses `vscode.window.showWarningMessage` / `showErrorMessage`
    - Debounces alerts (don't spam for the same threshold breach)
    - Updates status bar color state

15. **Extension activation & lifecycle** (`extension.ts`)
    - Activates on VS Code startup (or on first Copilot chat activity)
    - Initializes all services with dependency injection (constructor params, no DI framework)
    - Registers disposables for clean teardown
    - Handles missing databases gracefully (show "waiting for data" state)

### Phase 6: Packaging & Publishing

16. **Build configuration**
    - esbuild for bundling TypeScript → JS (external: `@vscode/sqlite3`)
    - `@vscode/vsce` for packaging .vsix
    - Platform-specific builds if needed for native module
    - `.vscodeignore` to exclude source, tests, dev deps

17. **Testing**
    - Unit tests: PricingEngine, CostCalculator, Aggregator (pure logic, no DB)
    - Integration tests: Repository classes against test fixture databases
    - Use vitest or mocha (standard for VS Code extensions)

18. **CI/CD**
    - GitHub Actions workflow: lint, test, build, package
    - Multi-platform matrix (win, mac, linux) for native module compatibility
    - Auto-publish to marketplace on release tag

## Relevant Files

- `extension/package.json` — Extension manifest with contributions, dependencies, activation
- `extension/src/extension.ts` — Entry point, service wiring
- `extension/src/data/AgentTracesRepository.ts` — Primary data source (spans + attributes)
- `extension/src/data/SessionStoreRepository.ts` — Session metadata
- `extension/src/data/StateRepository.ts` — Session titles
- `extension/src/data/interfaces.ts` — `ISessionDataSource`, `ISessionMetadata` interfaces
- `extension/src/domain/PricingEngine.ts` — Model → rate mapping + lookup
- `extension/src/domain/CostCalculator.ts` — Token × rate → cost math
- `extension/src/domain/Aggregator.ts` — Time-bucketed aggregation
- `extension/src/domain/models.ts` — Domain types (Span, SessionCost, ModelCost, etc.)
- `extension/src/services/CostTrackingService.ts` — Polling orchestrator
- `extension/src/services/BudgetAlertService.ts` — Threshold monitoring + alerts
- `extension/src/presentation/StatusBarController.ts` — Status bar rendering
- `extension/src/presentation/SidebarWebviewProvider.ts` — Webview provider
- `extension/src/presentation/webview/` — HTML, CSS, JS assets for the sidebar
- `extension/src/config.ts` — Configuration schema + defaults
- `extension/.github/workflows/ci.yml` — Build/test/publish pipeline
- `extension/esbuild.config.mjs` — Build script

## Verification

1. **Unit tests pass**: `npm test` — PricingEngine correctly maps model names, CostCalculator produces accurate costs for known token counts, Aggregator groups correctly by time period
2. **Integration test**: Create a test fixture `agent-traces.db` with known data, verify repository returns expected results
3. **Manual verification**: Install extension locally (`F5` debug), verify sidebar shows data matching `node tools/agent-traces/inspect-session.js` output
4. **Cross-check cost**: Compare extension's calculated cost for a session against manually computed cost using the pricing table
5. **Budget alerts fire**: Set a low threshold ($0.01), trigger a chat, verify warning notification appears
6. **Multi-platform**: Build .vsix for win/mac/linux, verify installs and reads DB on each

## Decisions

- **Primary data source**: `agent-traces.db` via `@vscode/sqlite3` (WAL-aware, complete token data including cache writes). Supplement with `session-store.db` for metadata and `state.vscdb` for titles.
- **No main.jsonl dependency**: Avoids requiring debug logging to be enabled. Falls back gracefully if DBs unavailable.
- **SQLite package**: Start with `@vscode/sqlite3` (Microsoft's maintained fork with prebuilt binaries for VS Code). If issues arise, fall back to `better-sqlite3`.
- **No heavy UI framework**: Vanilla JS + CSS variables in webview for minimal bundle size and fast rendering.
- **Polling over file-watching**: SQLite WAL changes don't reliably trigger file system events; polling is more robust.
- **Extension location**: `extension/` subdirectory within the `cost-research` workspace.

## Further Considerations

1. **Pricing data freshness**: Embed pricing as a JSON file that can be updated independently. Consider fetching from a remote source (GitHub raw file) for updates without extension releases — but default to bundled data for offline use.
2. **Active session detection**: The "current session" is determined by the most recent activity in agent-traces.db. Should we also try to detect the active VS Code Chat panel's session ID? (Recommendation: start with "most recent activity" heuristic, refine later.)
3. **Native module alternative**: If `@vscode/sqlite3` proves problematic for cross-platform packaging, consider shipping a thin native helper process that the extension communicates with via IPC, isolating the native dependency.
