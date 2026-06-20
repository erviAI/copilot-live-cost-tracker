/**
 * Minimal stub of the VS Code extension API for unit tests.
 *
 * Several modules under src/ do `import * as vscode from 'vscode'`, which has
 * no resolvable package outside the VS Code extension host. vitest aliases the
 * `vscode` import to this file (see vitest.config.ts) so those modules can be
 * imported in a plain Node environment. Only the surface actually touched by
 * the unit-tested code paths is implemented; everything else is a no-op.
 */

const noop = (): void => {};

const outputChannel = {
  name: 'mock',
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  append: noop,
  appendLine: noop,
  replace: noop,
  clear: noop,
  show: noop,
  hide: noop,
  dispose: noop,
};

export const window = {
  createOutputChannel: () => outputChannel,
  showInformationMessage: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
};

const configuration = {
  get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  has: () => false,
  inspect: () => undefined,
  update: () => Promise.resolve(),
};

export const workspace = {
  getConfiguration: () => configuration,
  onDidChangeConfiguration: () => ({ dispose: noop }),
};

export class EventEmitter<T = unknown> {
  private listeners: Array<(e: T) => void> = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T): void {
    for (const listener of this.listeners) listener(data);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export const Uri = {
  file: (fsPath: string) => ({ fsPath, path: fsPath, scheme: 'file' }),
  joinPath: (base: { fsPath: string }, ...parts: string[]) => {
    const joined = [base.fsPath, ...parts].join('/');
    return { fsPath: joined, path: joined, scheme: 'file' };
  },
};

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}
