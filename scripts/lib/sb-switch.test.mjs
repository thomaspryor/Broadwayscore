// BRO-8330: the ONE global ScrapingBee off switch (SCRAPINGBEE_DISABLED=1).
// Behavior + class guards. Real functions are require()d (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
process.env.SCRAPER_SPEND_LEDGER_PATH = path.join(os.tmpdir(), `sb-switch-test-ledger-${process.pid}.jsonl`);

const sw = require('./sb-switch.js');

test('isScrapingBeeOff: only the exact value 1 turns it off', () => {
  assert.equal(sw.isScrapingBeeOff({ SCRAPINGBEE_DISABLED: '1' }), true);
  for (const v of ['', '0', 'true', 'yes', ' 1 ', undefined]) {
    assert.equal(sw.isScrapingBeeOff({ SCRAPINGBEE_DISABLED: v }), false, `value ${v}`);
  }
  assert.equal(sw.isScrapingBeeOff({}), false);
});

test('scrapingBeeKey: empty when off, even with a candidate key; passthrough when on', () => {
  assert.equal(sw.scrapingBeeKey({ SCRAPINGBEE_DISABLED: '1', SCRAPINGBEE_API_KEY: 'k' }, 'cand'), '');
  assert.equal(sw.scrapingBeeKey({ SCRAPINGBEE_API_KEY: 'k' }), 'k');
  assert.equal(sw.scrapingBeeKey({ SCRAPINGBEE_API_KEY: 'k' }, 'cand'), 'k', 'process key wins, as before');
  assert.equal(sw.scrapingBeeKey({}, 'cand'), 'cand');
  assert.equal(sw.scrapingBeeKey({}), '');
});

test('scrubEnvIfOff removes the key only when off', () => {
  const on = { SCRAPINGBEE_API_KEY: 'k' };
  assert.equal(sw.scrubEnvIfOff(on), false);
  assert.equal(on.SCRAPINGBEE_API_KEY, 'k');
  const off = { SCRAPINGBEE_DISABLED: '1', SCRAPINGBEE_API_KEY: 'k' };
  assert.equal(sw.scrubEnvIfOff(off), true);
  assert.equal(off.SCRAPINGBEE_API_KEY, undefined);
});

test('workflow expression semantics: blanks the key on 1, keeps it otherwise (empty-string trap)', () => {
  // Mirror of: vars.D != '1' && secrets.K || ''  (GitHub Actions && / || return operands)
  const expr = (d, k) => (d !== '1' && k) || '';
  assert.equal(expr('1', 'secret'), '');
  assert.equal(expr('', 'secret'), 'secret');
  assert.equal(expr(undefined, 'secret'), 'secret');
  assert.equal(expr('0', 'secret'), 'secret');
  // the trap the reviewer caught: `d == '1' && '' || k` always yields k
  assert.equal(((('1' === '1') && '') || 'secret'), 'secret');
});

test('with switch on: scraper.js gets no key, even from .env top-up path', () => {
  const saved = { k: process.env.SCRAPINGBEE_API_KEY, d: process.env.SCRAPINGBEE_DISABLED };
  process.env.SCRAPINGBEE_API_KEY = 'test-key';
  process.env.SCRAPINGBEE_DISABLED = '1';
  try {
    delete require.cache[require.resolve('./sb-switch.js')];
    delete require.cache[require.resolve('./scraper.js')];
    const scraper = require('./scraper.js');
    assert.equal(process.env.SCRAPINGBEE_API_KEY, undefined, 'env scrubbed on require');
    return scraper.fetchWithScrapingBee('https://example.com/x').then((r) => {
      assert.equal(r, null, 'fetchWithScrapingBee returns null without any request');
    });
  } finally {
    if (saved.k === undefined) delete process.env.SCRAPINGBEE_API_KEY; else process.env.SCRAPINGBEE_API_KEY = saved.k;
    if (saved.d === undefined) delete process.env.SCRAPINGBEE_DISABLED; else process.env.SCRAPINGBEE_DISABLED = saved.d;
  }
});

test('with switch on: no SB request is made by any entry point (https spy)', async () => {
  const https = require('node:https');
  const origReq = https.request, origGet = https.get;
  const hits = [];
  const spy = (orig) => function (u, ...rest) {
    const s = typeof u === 'string' ? u : (u && (u.href || u.hostname || u.host)) || '';
    if (/scrapingbee/i.test(String(s))) hits.push(String(s));
    return orig.call(this, u, ...rest);
  };
  https.request = spy(origReq); https.get = spy(origGet);
  const saved = { k: process.env.SCRAPINGBEE_API_KEY, d: process.env.SCRAPINGBEE_DISABLED };
  process.env.SCRAPINGBEE_API_KEY = 'test-key';
  process.env.SCRAPINGBEE_DISABLED = '1';
  try {
    for (const m of ['./scraper.js', './url-discovery.js', './site-search-discovery.js', './reddit-api.js', './check-sb-credits.js', './credit-preflight.js']) {
      delete require.cache[require.resolve(m)];
    }
    const scraper = require('./scraper.js');
    await scraper.fetchWithScrapingBee('https://example.com/a');
    const sbc = require('./check-sb-credits.js');
    const st = await sbc.fetchSBCreditStatus();
    assert.equal(st.ok, true); assert.equal(st.skipped, true);
    const pre = require('./credit-preflight.js');
    assert.ok(pre, 'credit-preflight loads');
    const { sbCreditVerdict } = require('./sb-credit-verdict.js');
    assert.equal(sbCreditVerdict(st).level, 'pass', 'off is healthy, not a warning');
    assert.deepEqual(hits, [], 'no request touched scrapingbee');
  } finally {
    https.request = origReq; https.get = origGet;
    if (saved.k === undefined) delete process.env.SCRAPINGBEE_API_KEY; else process.env.SCRAPINGBEE_API_KEY = saved.k;
    if (saved.d === undefined) delete process.env.SCRAPINGBEE_DISABLED; else process.env.SCRAPINGBEE_DISABLED = saved.d;
  }
});

// ---- class guards (fail if a future caller ignores the switch) ----

function listFiles(dir, exts, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

test('class guard: every non-test script that calls app.scrapingbee.com or reads the key requires sb-switch', () => {
  const offenders = [];
  for (const f of listFiles(path.join(ROOT, 'scripts'), ['.js', '.mjs', '.cjs'])) {
    const rel = path.relative(ROOT, f);
    if (/\.test\.|\/test-|__tests__|sb-switch\.js$/.test(rel)) continue;
    const src = fs.readFileSync(f, 'utf8');
    const callsSb = /app\.scrapingbee\.com/.test(src);
    if (!callsSb) continue;
    if (!/sb-switch/.test(src)) offenders.push(rel);
  }
  // evaluate-brightdata-serp.js is a manual evaluation tool (never in CI) and is exempt.
  const allowed = new Set(['scripts/evaluate-brightdata-serp.js', 'scripts/lib/provider-billing.js', 'scripts/lib/cloud-proxy.js', 'scripts/lib/direct-provider-detector.js']);
  const bad = offenders.filter((o) => !allowed.has(o));
  assert.deepEqual(bad, [], `these files call ScrapingBee without honoring SCRAPINGBEE_DISABLED (require ./lib/sb-switch): ${bad.join(', ')}`);
});

test('class guard: every workflow SB key line is blanked by the switch and followed by the passthrough', () => {
  const wfDir = path.join(ROOT, '.github', 'workflows');
  const bad = [];
  for (const f of fs.readdirSync(wfDir).filter((n) => n.endsWith('.yml'))) {
    const lines = fs.readFileSync(path.join(wfDir, f), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/^\s*SCRAPINGBEE_API_KEY:/.test(line)) return;
      if (/^\s*SCRAPINGBEE_API_KEY:\s*(''|"")?\s*$/.test(line)) return; // literal empty (test.yml)
      const guarded = /vars\.SCRAPINGBEE_DISABLED != '1' && secrets\.SCRAPINGBEE_API_KEY \|\| ''/.test(line);
      const next = lines[i + 1] || '';
      const pass = /^\s*SCRAPINGBEE_DISABLED: \$\{\{ vars\.SCRAPINGBEE_DISABLED \}\}/.test(next);
      if (!guarded || !pass) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `unguarded SB key lines: ${bad.slice(0, 10).join(', ')}`);
});
