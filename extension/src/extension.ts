import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

import { AgentTracesRepository } from './data/AgentTracesRepository.js';
import { DebugLogsRepository } from './data/DebugLogsRepository.js';
import { SessionStoreRepository } from './data/SessionStoreRepository.js';
import { StateRepository } from './data/StateRepository.js';
import { disposeWorker } from './data/sqlite.js';
import { PricingEngine } from './domain/PricingEngine.js';
import { CostCalculator } from './domain/CostCalculator.js';
import { Aggregator } from './domain/Aggregator.js';
import { CostTrackingService } from './services/CostTrackingService.js';
import { BudgetAlertService } from './services/BudgetAlertService.js';
import { StatusBarController } from './presentation/StatusBarController.js';
import { SidebarWebviewProvider } from './presentation/SidebarWebviewProvider.js';
import { getPollingInterval, getBudgetThresholds, getPricingOverrides, getCostDataSource } from './config.js';

export function activate(context: vscode.ExtensionContext): void {
  const appDataPath = getAppDataPath();

  // --- Data Layer ---
  const spanRepo = new AgentTracesRepository(appDataPath);
  const debugLogsRepo = new DebugLogsRepository(appDataPath);
  const sessionStoreRepo = new SessionStoreRepository(appDataPath);
  // Resolve title sources from the same appData base as other Copilot DBs.
  const workspaceStorageRoot = path.join(appDataPath, 'Code', 'User', 'workspaceStorage');
  const stateRepo = new StateRepository(workspaceStorageRoot, appDataPath);

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
    getCostDataSource
  );

  const budgetService = new BudgetAlertService(getBudgetThresholds);

  // --- Presentation ---
  const statusBar = new StatusBarController();
  const sidebarProvider = new SidebarWebviewProvider(context.extensionUri);
  sidebarProvider.setSessionDetailHandler((sessionId) => trackingService.getSessionDetail(sessionId));

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
  });

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('copilotCostTracker.refresh', () => {
      trackingService.refresh();
    }),
    vscode.commands.registerCommand('copilotCostTracker.resetSession', () => {
      trackingService.resetSession();
      budgetService.resetAlerts();
    }),
    vscode.commands.registerCommand('copilotCostTracker.openDashboard', () => {
      vscode.commands.executeCommand('copilotCostTracker.dashboard.focus');
    }),
    vscode.commands.registerCommand('copilotCostTracker.openSettings', () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'copilotCostTracker'
      );
    })
  );

  // --- Configuration change listener ---
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copilotCostTracker')) {
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
    spanRepo as any,
    sessionStoreRepo as any,
    stateRepo as any
  );
}

export function deactivate(): void {
  disposeWorker();
}

function getAppDataPath(): string {
  switch (process.platform) {
    case 'win32':
      return process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support');
    case 'linux':
      return process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
    default:
      return path.join(os.homedir(), '.config');
  }
}
