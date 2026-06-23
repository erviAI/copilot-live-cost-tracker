import * as vscode from 'vscode';
import * as path from 'path';

import { AgentTracesRepository } from './data/AgentTracesRepository.js';
import { DebugLogsRepository } from './data/DebugLogsRepository.js';
import { StateRepository } from './data/StateRepository.js';
import { disposeWorker } from './data/sqlite.js';
import { PricingEngine } from './domain/PricingEngine.js';
import { CostCalculator } from './domain/CostCalculator.js';
import { Aggregator } from './domain/Aggregator.js';
import { CostTrackingService } from './services/CostTrackingService.js';
import { CostHistoryService } from './services/CostHistoryService.js';
import { BudgetAlertService } from './services/BudgetAlertService.js';
import { StatusBarController } from './presentation/StatusBarController.js';
import { SidebarWebviewProvider } from './presentation/SidebarWebviewProvider.js';
import { DashboardPanel } from './presentation/DashboardPanel.js';
import { VsCodeNotifier } from './presentation/VsCodeNotifier.js';
import { getPollingInterval, getBudgetThresholds, getPricingOverrides, getCostDataSource, getHistoryEnabled, getHistoryRetentionDays, getHistoryScrapeInterval, isOtelDbSpanExporterEnabled, OTEL_DB_SPAN_EXPORTER_SETTING } from './config.js';
import { createLogger } from './logger.js';

let _trackingService: CostTrackingService | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger();
  context.subscriptions.push(log);

  // Derive VS Code's `User` directory from this extension's global storage path
  // (`<User>/globalStorage/<ext-id>`). This works regardless of product flavour
  // (Stable/Insiders/VSCodium) and portable installs, rather than assuming `Code`.
  const userDir = path.dirname(path.dirname(context.globalStorageUri.fsPath));

  // --- Data Layer ---
  const spanRepo = new AgentTracesRepository(userDir);
  const debugLogsRepo = new DebugLogsRepository(userDir);
  // Resolve title sources from the same User directory as the other Copilot DBs.
  const workspaceStorageRoot = path.join(userDir, 'workspaceStorage');
  const stateRepo = new StateRepository(workspaceStorageRoot, userDir);

  // --- Domain Layer ---
  const pricingEngine = new PricingEngine(getPricingOverrides());
  const costCalculator = new CostCalculator(pricingEngine);
  const aggregator = new Aggregator(costCalculator);

  // --- Services ---
  const trackingService = new CostTrackingService(
    spanRepo,
    stateRepo,
    aggregator,
    getPollingInterval,
    debugLogsRepo,
    getCostDataSource,
    spanRepo, // AgentTracesRepository also provides per-turn labels
    spanRepo // ...and tool/function call spans
  );
  _trackingService = trackingService;

  const budgetService = new BudgetAlertService(getBudgetThresholds, new VsCodeNotifier());

  // --- Cost History (file-based persistence) ---
  if (getHistoryEnabled()) {
    const historyService = new CostHistoryService(
      context.globalStorageUri.fsPath,
      getHistoryRetentionDays
    );
    trackingService.setHistoryService(historyService, getHistoryScrapeInterval());
    // Check if a day rollover happened while extension was inactive
    historyService.checkRollup();
    // Prune old history files on activation
    historyService.prune();
  }

  // --- Presentation ---
  const statusBar = new StatusBarController();
  const sidebarProvider = new SidebarWebviewProvider(context.extensionUri);
  sidebarProvider.setSessionDetailHandler((sessionId) => trackingService.getSessionDetail(sessionId));
  sidebarProvider.setRangeSummaryHandler((preset) => trackingService.getRangeSummary(preset));

  // Register the webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarWebviewProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // --- Wiring: tracking → budget → UI updates ---
  trackingService.onDidUpdate((data) => {
    const budgetState = budgetService.evaluate(data);
    statusBar.update(data, budgetState);
    sidebarProvider.updateData(data, budgetState);
    DashboardPanel.updateIfOpen(data, budgetState);
  });

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotLiveCostTracker.refresh', () => {
      trackingService.refresh();
    }),
    vscode.commands.registerCommand('copilotLiveCostTracker.resetSession', () => {
      trackingService.resetSession();
      budgetService.resetAlerts();
    }),
    vscode.commands.registerCommand('copilotLiveCostTracker.openDashboard', () => {
      const panel = DashboardPanel.createOrShow(context.extensionUri);
      panel.setRangeSummaryHandler((preset) => trackingService.getRangeSummary(preset));
      panel.setRecentTurnsHandler(() => trackingService.getRecentTurns());
      const data = trackingService.getLastData();
      if (data) {
        panel.update(data, budgetService.evaluate(data));
      }
    }),
    vscode.commands.registerCommand('copilotLiveCostTracker.openSettings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'copilotLiveCostTracker'
      );
    }),
    vscode.commands.registerCommand('copilotLiveCostTracker.enableOtel', () => {
      void enableOtelDbSpanExporter();
    })
  );

  // --- OpenTelemetry prerequisite check ---
  // `agent-traces.db` is only written when Copilot Chat's OTel DB span exporter
  // is enabled. Without it there is no data source, so prompt the user once.
  void ensureOtelDbSpanExporterEnabled();

  // --- Configuration change listener ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copilotLiveCostTracker')) {
        pricingEngine.setOverrides(getPricingOverrides());
        trackingService.setScrapeInterval(getHistoryScrapeInterval());
        trackingService.onConfigurationChanged();
      }
    })
  );

  // --- Start polling ---
  trackingService.start();

  // --- Disposables ---
  context.subscriptions.push(
    trackingService,
    budgetService,
    statusBar,
    sidebarProvider,
    spanRepo,
    debugLogsRepo,
    stateRepo
  );
}

/**
 * On activation, verify the Copilot Chat OTel DB span exporter is enabled. If
 * not, surface a notification linking to the setting so the user can turn it on.
 */
async function ensureOtelDbSpanExporterEnabled(): Promise<void> {
  if (isOtelDbSpanExporterEnabled()) return;

  const enable = 'Enable';
  const openSetting = 'Open Setting';
  const choice = await vscode.window.showWarningMessage(
    'Copilot Live Cost & Token Tracker needs OpenTelemetry tracing to read token usage. ' +
      `Enable the setting "${OTEL_DB_SPAN_EXPORTER_SETTING}" so Copilot Chat writes agent-traces.db.`,
    enable,
    openSetting
  );

  if (choice === enable) {
    await enableOtelDbSpanExporter();
  } else if (choice === openSetting) {
    void vscode.commands.executeCommand('workbench.action.openSettings', OTEL_DB_SPAN_EXPORTER_SETTING);
  }
}

/** Enable the OTel DB span exporter setting globally and confirm to the user. */
async function enableOtelDbSpanExporter(): Promise<void> {
  await vscode.workspace
    .getConfiguration()
    .update(OTEL_DB_SPAN_EXPORTER_SETTING, true, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    'OpenTelemetry tracing enabled. Run a Copilot Chat session to start capturing token usage.'
  );
}

export async function deactivate(): Promise<void> {
  // Flush history before shutdown
  if (_trackingService) {
    await _trackingService.flushHistory();
  }
  disposeWorker();
}
