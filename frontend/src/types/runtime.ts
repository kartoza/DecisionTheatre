export type AppRuntime = 'browser' | 'webview';

export function isGoWebViewRuntime(): boolean {
  return typeof window !== 'undefined' && window.__DECISION_THEATRE_WEBVIEW__ === true;
}

export function getAppRuntime(): AppRuntime {
  return isGoWebViewRuntime() ? 'webview' : 'browser';
}
