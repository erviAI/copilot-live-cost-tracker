import * as vscode from 'vscode';
import type { INotifier } from '../services/INotifier.js';

/** Default {@link INotifier} backed by the VS Code notification API. */
export class VsCodeNotifier implements INotifier {
  warn(message: string): void {
    void vscode.window.showWarningMessage(message);
  }

  error(message: string): void {
    void vscode.window.showErrorMessage(message);
  }
}
