/**
 * autonomous-ui-capture.js — screenshot evidence for a tier-3 UI diff
 * (Sprint 2, S2-T6).
 *
 * A checks-green UI change is not an approvable UI change: tsc, lint and the
 * production build all pass on a page that renders wrong. The owner cannot
 * tap Approve on "it compiles" for something that changes what the site LOOKS
 * like — so a UI diff either carries screenshots taken from its own branch,
 * or the morning email shows NO approve link for it at all (renderItem in
 * scripts/lib/autonomous-email-render.js). Never a silent downgrade to
 * "checks passed, ship it".
 *
 * Runs against the production build the check gauntlet already produced in
 * that worktree (`npx next build`) — `next start` serves it, Playwright
 * shoots it, the server is killed. Nothing here is fatal to the night: every
 * failure path returns { ok:false, error } and the caller simply ships an
 * item with no approve link.
 */

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { checksEnv } = require('./autonomous-checks.js');

// Two representative pages at two widths: the homepage (cards, shelves,
// scores) and one show page (hero, review rows) — the two layouts nearly
// every UI card in this repo touches. Widths are the mobile/desktop pair
// /visual-qa uses.
const DEFAULT_ROUTES = ['/', '/show/hamilton'];
const WIDTHS = [{ label: '390', width: 390, height: 844 }, { label: '1280', width: 1280, height: 900 }];

const SERVER_READY_TIMEOUT_MS = 90_000;
const SHOT_TIMEOUT_MS = 45_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function probe(url) {
  return new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(3000, () => { req.destroy(); resolve(0); });
  });
}

async function waitForServer(url, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (await probe(url) === 200) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * @param {object} o
 * @param {string} o.workdir - the branch worktree, with a built .next
 * @param {string} o.outDir  - where PNGs are written (created if absent)
 * @param {string[]} [o.routes]
 * @returns {Promise<{ok:boolean, files:string[], error:string|null}>}
 */
async function captureUiScreenshots({ workdir, outDir, routes = DEFAULT_ROUTES }) {
  if (!fs.existsSync(path.join(workdir, '.next'))) {
    return { ok: false, files: [], error: 'no production build in the worktree — screenshots need the build check to have run first (if tier3BuildCheck is off in .claude/autonomous-config.json, every UI card will lose its approve link)' };
  }
  let chromium;
  try { ({ chromium } = require('@playwright/test')); }
  catch (err) { return { ok: false, files: [], error: `playwright unavailable: ${String(err.message).slice(0, 120)}` }; }

  let port;
  try { port = await freePort(); }
  catch (err) { return { ok: false, files: [], error: `could not reserve a port: ${err.message}` }; }

  const base = `http://127.0.0.1:${port}`;
  // Same secret-free, NEXT_PUBLIC-only env the build ran under: the server is
  // rendering implementer-authored code and must not see .env either.
  // detached: SIGTERM to `npx` leaves the real `next start` child running and
  // holding the port (ship-check finding). Own process group -> kill the group.
  const server = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: workdir, stdio: ['ignore', 'ignore', 'pipe'], env: checksEnv({ build: true }), detached: true,
  });
  let serverErr = '';
  server.stderr.on('data', c => { serverErr = (serverErr + String(c)).slice(-500); });

  const files = [];
  let browser = null;
  try {
    if (!await waitForServer(base, SERVER_READY_TIMEOUT_MS)) {
      return { ok: false, files: [], error: `next start never became ready on ${base}: ${serverErr.slice(0, 200) || 'no output'}` };
    }
    fs.mkdirSync(outDir, { recursive: true });
    browser = await chromium.launch();
    for (const route of routes) {
      for (const w of WIDTHS) {
        const page = await browser.newPage({ viewport: { width: w.width, height: w.height } });
        try {
          const res = await page.goto(base + route, { waitUntil: 'networkidle', timeout: SHOT_TIMEOUT_MS });
          if (!res || res.status() >= 400) throw new Error(`${route} returned ${res ? res.status() : 'no response'}`);
          const name = `${route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home'}-${w.label}.png`;
          const file = path.join(outDir, name);
          await page.screenshot({ path: file, fullPage: true });
          files.push(file);
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
    // Partial capture is NOT evidence: an item shipped with two of four shots
    // reads as "reviewed" while half the change is unseen.
    if (files.length !== routes.length * WIDTHS.length) {
      return { ok: false, files, error: `captured ${files.length} of ${routes.length * WIDTHS.length} expected screenshots` };
    }
    return { ok: true, files, error: null };
  } catch (err) {
    return { ok: false, files, error: String(err.message || err).slice(0, 300) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { process.kill(-server.pid, 'SIGTERM'); } catch { try { server.kill('SIGTERM'); } catch { /* already gone */ } }
  }
}

module.exports = { captureUiScreenshots, DEFAULT_ROUTES, WIDTHS, freePort, waitForServer };
