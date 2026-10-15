// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

#!/usr/bin/env node
// Measure the map's load sequence in a real browser via the Chrome DevTools
// Protocol. Zero dependencies: Node 22's global WebSocket + system chromium.
//
// Usage: node map-load-timeline.mjs <appUrl> <outDir> [durationSec] [zoomClicks]
//
// Boots the app straight into the explore-mode map, records every network
// request (including MapLibre's web-worker tile fetches, via auto-attach),
// captures console output, screenshots every 2 s, then (optionally) clicks the
// zoom-in control to walk the map into catchment zoom range like a user
// opening a site. Writes timeline.json and prints a classified summary.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const appUrl = process.argv[2] ?? 'http://127.0.0.1:8123/';
const outDir = process.argv[3] ?? './map-load-out';
const durationSec = Number(process.argv[4] ?? 40);
const zoomClicks = Number(process.argv[5] ?? 0);
// Throttle to this many kbit/s (0 = off) starting one click BEFORE the last
// zoom click, so the final zoom step — the first one on the tile path —
// happens on a slow link, simulating the remote-satellite desktop setup.
const throttleKbps = Number(process.argv[6] ?? 0);
const debugPort = 9333;
const workerSessions = new Set();
let throttleOn = false;

mkdirSync(outDir, { recursive: true });

const chrome = spawn('chromium', [
  `--remote-debugging-port=${debugPort}`,
  '--headless=new',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--enable-unsafe-swiftshader',
  '--use-angle=swiftshader',
  '--window-size=1600,1000',
  `--user-data-dir=${outDir}/chrome-profile`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });

async function getTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`chromium debug port never answered. stderr:\n${chromeErr}`);
}

const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error('websocket failed'));
});

let msgId = 0;
const pending = new Map();
const events = [];           // console + lifecycle events
const requests = new Map();  // "<sessionId>:<requestId>" -> record
const marks = [];            // named wall-clock marks (nav, zoom clicks)

function send(method, params = {}, sessionId = undefined) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

// One clock for everything: CDP network timestamps are monotonic seconds and
// consoleAPICalled timestamps are epoch ms, so anchor both to the first
// network event / navigation wall-clock respectively.
let t0mono = null;
let t0wall = null;
const relMono = (ts) => (t0mono === null ? null : Math.round((ts - t0mono) * 1000));
const relWall = (ms) => (t0wall === null ? null : Math.round(ms - t0wall));

function handleEvent(method, params, sessionId) {
  const key = (id) => `${sessionId ?? 'page'}:${id}`;
  switch (method) {
    case 'Target.attachedToTarget': {
      const info = params.targetInfo;
      events.push({ kind: 'target', at: relWall(Date.now()), text: `${info.type} ${info.url.slice(0, 90)}` });
      // Enable network in the worker and let it run.
      workerSessions.add(params.sessionId);
      send('Network.enable', {}, params.sessionId).catch(() => {});
      if (throttleOn) applyThrottle(params.sessionId);
      send('Runtime.runIfWaitingForDebugger', {}, params.sessionId).catch(() => {});
      break;
    }
    case 'Network.requestWillBeSent': {
      if (t0mono === null) t0mono = params.timestamp;
      requests.set(key(params.requestId), {
        url: params.request.url,
        worker: sessionId ? true : false,
        start: relMono(params.timestamp),
        response: null, finish: null, failed: null,
        status: null, bytes: 0, type: params.type,
      });
      break;
    }
    case 'Network.responseReceived': {
      const r = requests.get(key(params.requestId));
      if (r) { r.response = relMono(params.timestamp); r.status = params.response.status; }
      break;
    }
    case 'Network.loadingFinished': {
      const r = requests.get(key(params.requestId));
      if (r) { r.finish = relMono(params.timestamp); r.bytes = params.encodedDataLength; }
      break;
    }
    case 'Network.loadingFailed': {
      const r = requests.get(key(params.requestId));
      if (r) { r.failed = params.errorText; r.finish = relMono(params.timestamp); }
      break;
    }
    case 'Runtime.consoleAPICalled': {
      const text = (params.args ?? []).map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.preview) return `${a.description ?? ''} ${JSON.stringify(a.preview.properties?.map((p) => [p.name, p.value]))}`;
        return a.description ?? '';
      }).join(' ');
      events.push({ kind: 'console', level: params.type, at: relWall(params.timestamp), text });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails;
      events.push({
        kind: 'exception', at: relWall(params.timestamp),
        text: `${d.text} ${d.exception?.description ?? ''}`.slice(0, 400),
      });
      break;
    }
  }
}

ws.onmessage = (raw) => {
  const msg = JSON.parse(raw.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    return;
  }
  if (msg.method) handleEvent(msg.method, msg.params, msg.sessionId);
};

await send('Network.enable', { maxTotalBufferSize: 100_000_000 });
await send('Page.enable');
await send('Runtime.enable');
await send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: true });

// Boot straight into the explore-mode map: skip the landing page and the
// browser-runtime resume-session modal (see types/index.ts).
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try {
    localStorage.setItem('dt-current-page', 'explore');
    sessionStorage.setItem('dt-session-active', '1');
  } catch (e) {}`,
});

t0wall = Date.now();
marks.push({ name: 'navigate', at: 0 });
await send('Page.navigate', { url: appUrl });

const shots = [];
async function screenshot(tag) {
  try {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    const name = `shot-${tag}.png`;
    writeFileSync(`${outDir}/${name}`, Buffer.from(data, 'base64'));
    shots.push({ at: relWall(Date.now()), file: name });
  } catch (e) {
    events.push({ kind: 'shot-error', at: relWall(Date.now()), text: String(e) });
  }
}

// Phase 1: initial load, screenshots every 2 s for 10 s.
for (let i = 1; i <= 5; i++) { await sleep(2000); await screenshot(`load-${i * 2}s`); }

function applyThrottle(sessionId) {
  const bytesPerSec = (throttleKbps * 1024) / 8;
  send('Network.emulateNetworkConditions', {
    offline: false, latency: 100,
    downloadThroughput: bytesPerSec, uploadThroughput: bytesPerSec,
  }, sessionId).catch(() => {});
}

// Phase 2: zoom in like a user heading for a site, one click per second.
for (let i = 1; i <= zoomClicks; i++) {
  if (throttleKbps > 0 && i === zoomClicks) {
    throttleOn = true;
    applyThrottle(undefined);
    for (const s of workerSessions) applyThrottle(s);
    marks.push({ name: `throttle-${throttleKbps}kbps`, at: relWall(Date.now()) });
    await sleep(500);
  }
  const clicked = await send('Runtime.evaluate', {
    expression: `(() => { const b = document.querySelector('.maplibregl-ctrl-zoom-in'); if (b) { b.click(); return true; } return false; })()`,
    returnByValue: true,
  });
  marks.push({ name: `zoom-click-${i}`, at: relWall(Date.now()), ok: clicked.result?.value === true });
  await sleep(1000);
  if (i % 2 === 0 || i === zoomClicks) await screenshot(`zoom-${i}`);
}

// Phase 3: settle until the duration is up, screenshot every 2 s.
while (Date.now() - t0wall < durationSec * 1000) {
  await sleep(2000);
  await screenshot(`settle-${Math.round((Date.now() - t0wall) / 1000)}s`);
}

// Current zoom, if the map exposes anything queryable.
const zoomProbe = await send('Runtime.evaluate', {
  expression: `(() => { try { const el = document.querySelector('.maplibregl-map'); return el ? 'map-present' : 'no-map'; } catch (e) { return String(e); } })()`,
  returnByValue: true,
}).catch(() => null);
events.push({ kind: 'probe', at: relWall(Date.now()), text: JSON.stringify(zoomProbe?.result?.value ?? null) });

const reqList = Array.from(requests.values()).sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
writeFileSync(`${outDir}/timeline.json`, JSON.stringify({ appUrl, marks, requests: reqList, events, shots }, null, 1));

// ---- classified summary ----
function classify(url) {
  let u; try { u = new URL(url); } catch { return 'other'; }
  const p = u.pathname;
  if (/\/tiles\/catchments\//.test(p)) return 'catchment-tile';
  if (/\.pbf$/.test(p)) return 'basemap-vector-tile';
  if (/\/api\/choropleth/.test(p)) return u.searchParams.get('valuesOnly') === '1' ? 'choropleth-full-values' : 'choropleth-geojson';
  if (/\/api\/catchment-values/.test(p)) return 'catchment-values';
  if (/style\.json|tiles\.json|catchments-tiles\.json|\/fonts\/|\/glyphs\//.test(p)) return 'map-metadata';
  if (/\/api\//.test(p)) return 'api-other';
  if (/\/docs\//.test(p)) return 'docs';
  return 'other';
}

const groups = new Map();
for (const r of reqList) {
  const g = classify(r.url);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(r);
}

console.log(`\n=== map load timeline: ${appUrl} (${reqList.length} requests) ===`);
for (const m of marks) console.log(`  mark ${String(m.at).padStart(6)} ms  ${m.name}${m.ok === false ? ' (CLICK FAILED)' : ''}`);
for (const [g, rs] of Array.from(groups.entries()).sort((a, b) => (a[1][0].start ?? 0) - (b[1][0].start ?? 0))) {
  const done = rs.filter((r) => r.finish !== null && !r.failed);
  const failed = rs.filter((r) => r.failed);
  const bytes = done.reduce((s, r) => s + r.bytes, 0);
  const durs = done.map((r) => r.finish - r.start).sort((a, b) => a - b);
  const p50 = durs.length ? durs[Math.floor(durs.length / 2)] : null;
  const slowest = done.slice().sort((a, b) => (b.finish - b.start) - (a.finish - a.start))[0];
  console.log(`\n${g}: ${rs.length} req (${rs.filter((r) => r.worker).length} via worker), ${(bytes / 1024).toFixed(0)} KiB` + (failed.length ? `, ${failed.length} FAILED` : ''));
  console.log(`  first start ${Math.min(...rs.map((r) => r.start ?? 1e9))} ms, last finish ${done.length ? Math.max(...done.map((r) => r.finish)) : '-'} ms, p50 dur ${p50} ms`);
  if (slowest) console.log(`  slowest: ${slowest.finish - slowest.start} ms  ${slowest.url.slice(0, 120)}`);
  for (const f of failed.slice(0, 3)) console.log(`  FAIL ${f.failed}  ${f.url.slice(0, 100)}`);
}

console.log('\n=== console/exceptions ===');
for (const e of events.filter((e) => e.kind === 'console' || e.kind === 'exception').slice(0, 80)) {
  console.log(`  ${String(e.at).padStart(6)} ms [${e.level ?? e.kind}] ${e.text.slice(0, 180)}`);
}

ws.close();
chrome.kill('SIGTERM');
