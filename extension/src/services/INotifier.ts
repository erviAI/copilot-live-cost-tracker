/**
 * Abstraction over user-facing notifications so services can be unit-tested
 * without depending on the `vscode` API. The concrete VS Code implementation
 * lives in the presentation layer (`VsCodeNotifier`).
 */
export interface INotifier {
  warn(message: string): void;
  error(message: string): void;
}
