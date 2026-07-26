import { describe, it, expect, vi, afterEach } from 'vitest';
import { VsCodeNotifier } from '../src/presentation/VsCodeNotifier.js';
import { window } from './mocks/vscode.js';

describe('VsCodeNotifier', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses notifications when disabled', () => {
    const warnSpy = vi.spyOn(window, 'showWarningMessage');
    const errorSpy = vi.spyOn(window, 'showErrorMessage');
    const notifier = new VsCodeNotifier(() => false);

    notifier.warn('warning');
    notifier.error('limit');

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('shows notifications when enabled', () => {
    const warnSpy = vi.spyOn(window, 'showWarningMessage');
    const errorSpy = vi.spyOn(window, 'showErrorMessage');
    const notifier = new VsCodeNotifier(() => true);

    notifier.warn('warning');
    notifier.error('limit');

    expect(warnSpy).toHaveBeenCalledWith('warning');
    expect(errorSpy).toHaveBeenCalledWith('limit');
  });

  it('re-reads the enabled state on every call', () => {
    const warnSpy = vi.spyOn(window, 'showWarningMessage');
    let enabled = false;
    const notifier = new VsCodeNotifier(() => enabled);

    notifier.warn('first');
    enabled = true;
    notifier.warn('second');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('second');
  });
});
