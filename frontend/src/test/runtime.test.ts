import { describe, it, expect, beforeEach } from 'vitest';
import { getAppRuntime, isGoWebViewRuntime } from '../types/runtime';

describe('runtime detection', () => {
  beforeEach(() => {
    delete window.__DECISION_THEATRE_WEBVIEW__;
  });

  it('detects normal browser runtime by default', () => {
    expect(isGoWebViewRuntime()).toBe(false);
    expect(getAppRuntime()).toBe('browser');
  });

  it('detects go webview runtime when injected marker is present', () => {
    window.__DECISION_THEATRE_WEBVIEW__ = true;
    expect(isGoWebViewRuntime()).toBe(true);
    expect(getAppRuntime()).toBe('webview');
  });
});
