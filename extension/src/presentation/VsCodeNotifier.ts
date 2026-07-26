import * as vscode from 'vscode';
import { areBudgetNotificationsEnabled } from '../config.js';
import type { INotifier } from '../services/INotifier.js';

/**
 * Default {@link INotifier} backed by the VS Code notification API.
 *
 * Popups are opt-in: `isEnabled` is consulted on every call (rather than
 * captured once) so toggling the setting takes effect without a reload.
 */
export class VsCodeNotifier implements INotifier {
  constructor(private readonly isEnabled: () => boolean = areBudgetNotificationsEnabled) {}

  warn(message: string): void {
    if (!this.isEnabled()) return;
    void vscode.window.showWarningMessage(message);
  }

  error(message: string): void {
    if (!this.isEnabled()) return;
    void vscode.window.showErrorMessage(message);
  }
}
