#!/usr/bin/env node
// scripts/visual-identical.mjs (BRO-7491 Phase 1, SHADOW ONLY): screenshot the same routes on the base
// (origin/main) and on the change, at every visual-qa width and in the listed interactive states, then
// record whether every pair matched. It never approves anything; visual-approval.js only posts the result
// on the card. Fails closed: any error, missing route or failed self-test is "not identical".
//
//   node scripts/visual-identical.mjs --base-url=http://localhost:3001 --head-url=http://localhost:3000 \
//     --paths=/,/shows/hamilton [--states=states.json] [--mask=".clock,[data-live]"] [--out=<dir>]
//
// states.json: { "/shows/hamilton": [ { "name": "rating panel open", "click": "button[aria-label='Show ratings']", "waitFor": "[role=dialog]" } ] }
// Writes <out>/identical.json (default .claude/visual-qa/<branch>/identical.json). Exit 0 whenever it wrote a report.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { WIDTHS, AD_NETWORK_URL_RE, launchChromium } from './lib/visual-capture.mjs';

const require = createRequire(import.meta.url);
const ident = require('./lib/visual-identical.js');
const va = require('./lib/visual-approval.js');

const SETTLE_MS = Number(process.env.VISUAL_IDENTICAL_SETTLE_MS) || 2000;
const FROZEN = Date.UTC(2026, 0, 15, 12, 0, 0);
const STILL_CSS = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
const CANARY_CSS = 'body{border-top:3px solid #ff0000!important}';

function arg(argv, name) { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : ''; }
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function shoot(browser, baseUrl, route, width, state, masks, { canary = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  try {
    await context.addCookies([{ name: 'bwsc_noads', value: '1', url: baseUrl }]);
    await context.route(AD_NETWORK_URL_RE, (r) => r.abort('blockedbyclient'));
    await context.addInitScript(`(() => { const T = ${FROZEN}; const R = Date; const F = function (...a) { return new.target ? new R(...(a.length ? a : [T])) : new R(T).toString(); }; F.now = () => T; F.prototype = R.prototype; F.UTC = R.UTC; F.parse = R.parse; globalThis.Date = F; })();`);
    const page = await context.newPage();
    const res = await page.goto(baseUrl + route, { waitUntil: 'load', timeout: 20000 });
    if (!res || res.status() >= 400) throw new Error(`page answered ${res ? res.status() : 'nothing'}`);
    const want = new URL(baseUrl + route); const got = new URL(page.url());
    const norm = (u) => u.pathname.replace(/\/$/, '') + u.search;
    if (norm(want) !== norm(got)) throw new Error(`redirected to ${got.pathname}`);
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate(() => document.fonts && document.fonts.ready);
    await page.addStyleTag({ content: STILL_CSS + masks.map((m) => `${m}{visibility:hidden!important}`).join('') + (canary ? CANARY_CSS : '') });
    if (state) {
      await page.locator(state.click).first().click({ timeout: 8000 });
      if (state.waitFor) await page.waitForSelector(state.waitFor, { timeout: 8000 });
      await page.waitForTimeout(500);
    }
    return await page.screenshot({ fullPage: true });
  } finally { await context.close(); }
}

async function main(argv = process.argv.slice(2)) {
  const baseUrl = arg(argv, 'base-url').replace(/\/$/, '');
  const headUrl = arg(argv, 'head-url').replace(/\/$/, '');
  const paths = (arg(argv, 'paths') || '/').split(',').map((s) => s.trim()).filter(Boolean);
  const masks = (arg(argv, 'mask') || '').split(',').map((s) => s.trim()).filter(Boolean).concat(['time', '[data-visual-mask]']);
  const statesFile = arg(argv, 'states');
  const broad = masks.find((m) => /^(html|body|main|#root|#__next|\*)$/i.test(m));
  if (broad) { console.error(`Refused: --mask ${broad} would hide the whole page, so nothing could be compared.`); return 2; }
  if (!baseUrl || !headUrl) { console.error('Usage: node scripts/visual-identical.mjs --base-url=<url> --head-url=<url> [--paths=/,/x] [--states=file.json] [--mask=<css>] [--out=<dir>]'); return 2; }
  const hostKey = (u) => { try { const x = new URL(u); return `${x.hostname === 'localhost' ? '127.0.0.1' : x.hostname}:${x.port || (x.protocol === 'https:' ? 443 : 80)}`; } catch { return u; } };
  if (hostKey(baseUrl) === hostKey(headUrl)) { console.error('Refused: --base-url and --head-url are the same server, so the comparison would prove nothing.'); return 2; }

  const git = (a) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return ''; } };
  const branch = git(['branch', '--show-current']) || 'detached';
  const out = arg(argv, 'out') || join('.claude', 'visual-qa', branch);
  mkdirSync(out, { recursive: true });
  // Scratch pictures live in the system temp dir, never under <out>: visual-approval.js reads that folder for evidence.
  const work = mkdtempSync(join(tmpdir(), 'visual-identical-'));
  let states = {};
  let setupError = '';
  if (statesFile) { try { states = JSON.parse(readFileSync(statesFile, 'utf8')); } catch (e) { setupError = `could not read the states file: ${e.message}`; } }
  for (const list of Object.values(states)) for (const st of (Array.isArray(list) ? list : [])) if (!st || !st.name || !st.click) setupError = setupError || 'a listed state has no name or no click selector';

  const pairs = [];
  if (setupError) pairs.push({ route: paths[0], width: 0, state: '', status: 'error', reason: setupError });
  let canaryOk = false;
  let browser;
  try {
    browser = await launchChromium();
    for (const route of setupError ? [] : paths) {
      const variants = [{ name: '' }, ...((states[route] || []).map((s) => ({ name: s.name, ...s })))];
      for (const width of WIDTHS) {
        for (const v of variants) {
          const key = `${route.replace(/[^a-z0-9]+/gi, '_')}_${width}_${(v.name || 'page').replace(/[^a-z0-9]+/gi, '_')}`;
          const pair = { route, width, state: v.name || '' };
          try {
            const st = v.click ? v : null;
            const [b, h, h2] = [await shoot(browser, baseUrl, route, width, st, masks), await shoot(browser, headUrl, route, width, st, masks), await shoot(browser, headUrl, route, width, st, masks)];
            const f = (n) => join(work, `${key}.${n}.png`);
            writeFileSync(f('base'), b); writeFileSync(f('head'), h); writeFileSync(f('head2'), h2);
            const self = await ident.compareImages(f('head'), f('head2'));
            const cmp = await ident.compareImages(f('base'), f('head'));
            if (!self.same) { pair.status = 'different'; pair.reason = 'the page does not render the same twice in a row (animated or live content)'; }
            else { pair.status = cmp.same ? 'same' : 'different'; pair.reason = cmp.reason; }
          } catch (e) { pair.status = 'error'; pair.reason = String(e.message || e).split('\n')[0].slice(0, 160); }
          pairs.push(pair);
        }
      }
    }
    // Self-test: a known 3px change on the head page must be noticed, or no "same" result is trustworthy.
    try {
      const plain = await shoot(browser, headUrl, paths[0], 360, null, masks);
      const changed = await shoot(browser, headUrl, paths[0], 360, null, masks, { canary: true });
      writeFileSync(join(work, 'canary.a.png'), plain); writeFileSync(join(work, 'canary.b.png'), changed);
      canaryOk = (await ident.compareImages(join(work, 'canary.a.png'), join(work, 'canary.b.png'))).same === false;
    } catch { canaryOk = false; }
  } catch (e) {
    pairs.push({ route: paths[0], width: 0, state: '', status: 'error', reason: String(e.message || e).split('\n')[0].slice(0, 160) });
  } finally { if (browser) await browser.close().catch(() => {}); try { rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } }

  const decision = ident.decide(pairs, canaryOk);
  const mergeBase = git(['merge-base', 'origin/main', 'HEAD']);
  const report = {
    schema: 1, outcome: decision.outcome, identical: decision.identical, reasons: decision.reasons, canaryOk,
    baseUrl, headUrl, mergeBase, headSha: git(['rev-parse', 'HEAD']), patch: (() => { try { return va.patchId('origin/main', 'HEAD', process.cwd()) || ''; } catch { return ''; } })(),
    widths: WIDTHS, masks, statesFile: statesFile || '', statesSha: statesFile && existsSync(statesFile) ? sha(readFileSync(statesFile, 'utf8')) : '', pairs,
  };
  writeFileSync(join(out, 'identical.json'), JSON.stringify(report, null, 2));
  console.log(`[visual-identical] ${decision.outcome}: ${pairs.length} pair(s), canary ${canaryOk ? 'ok' : 'FAILED'}; wrote ${join(out, 'identical.json')}`);
  for (const r of decision.reasons) console.log(`  - ${r}`);
  return 0;
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(`[visual-identical] ${e.stack || e.message}`); process.exitCode = 1; });
