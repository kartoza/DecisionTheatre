import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// index.html installed global handlers that injected a fixed red block holding
// the full stack trace into the live page — internal file paths and frame details
// shown to whoever was using the application — and loaded Google Analytics
// unconditionally, three lines below a comment saying nothing in the file may
// fetch from a third party.

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

describe('the page shell', () => {
  it('does not inject error details into the page', () => {
    expect(html).not.toMatch(/window\.onerror/);
    expect(html).not.toMatch(/error\.stack/);
    // The give-away of the old banner: a fixed, full-width red overlay.
    expect(html).not.toMatch(/background:red/);
    expect(html).not.toMatch(/background:darkred/);
  });

  it('loads analytics only outside the desktop build', () => {
    const analytics = html.slice(html.indexOf('googletagmanager'));
    expect(html).toMatch(/__DECISION_THEATRE_WEBVIEW__/);

    // The guard must come before the script is created, or it guards nothing.
    const guard = html.indexOf('__DECISION_THEATRE_WEBVIEW__');
    const load = html.indexOf('googletagmanager');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(load);
    expect(analytics.length).toBeGreaterThan(0);
  });

  it('has no unconditional third-party script tag', () => {
    // A bare <script src="https://..."> executes before any guard can run. The
    // file's own comment says nothing here may fetch from a third party.
    const unconditional = html.match(/<script[^>]*\ssrc="https?:\/\/[^"]+"/g) ?? [];
    expect(unconditional).toEqual([]);
  });
});
