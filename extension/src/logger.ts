import * as vscode from 'vscode';

let _channel: vscode.LogOutputChannel | undefined;

export function createLogger(): vscode.LogOutputChannel {
  _channel = vscode.window.createOutputChannel('Copilot Cost Tracker', { log: true });
  return _channel;
}

export const logger = {
  info(message: string, ...args: unknown[]): void {
    _channel?.info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    _channel?.warn(message, ...args);
  },
  error(message: string, ...args: unknown[]): void {
    _channel?.error(message, ...args);
  },
  debug(message: string, ...args: unknown[]): void {
    _channel?.debug(message, ...args);
  },
  trace(message: string, ...args: unknown[]): void {
    _channel?.trace(message, ...args);
  },
};
