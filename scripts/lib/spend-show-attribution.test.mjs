// BRO-8325 class guard: ScrapingBee rows with no showId are invisible to the SB
// market gate (sb-market-gate.js keys the SERP cut on the ledger showId) and to
// per-show spend reports. 45% of SB rows had none. Two causes, both covered:
//   1. Single-show CLI runs (`--show=ID`) never wrapped themselves; the ledger
//      now reads the show from argv (behavioural tests below, real function).
//   2. Per-show loops in multi-show collectors called providers outside
//      withSpendShow; the sites below must stay wrapped (source guard: these
//      scripts run network work at require time, so they cannot be imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..');
const { showIdFromArgv } = require('./provider-telemetry.js');

test('showIdFromArgv: exactly one slug-shaped show attributes, anything else does not', () => {
  assert.equal(showIdFromArgv(['node', 'x.js', '--show=hamlet-2026', '--url=https://a']), 'hamlet-2026');
  assert.equal(showIdFromArgv(['node', 'x.js', '--shows=oh-mary-london-2026']), 'oh-mary-london-2026');
  assert.equal(showIdFromArgv(['node', 'x.js', '--show=a-b', '--show=a-b']), 'a-b', 'same show twice is still one show');
  for (const argv of [
    ['node', 'x.js'],
    ['node', 'x.js', '--show=a-b,c-d'], // a list
    ['node', 'x.js', '--shows=a-b,c-d'],
    ['node', 'x.js', '--show=a-b', '--show=c-d'], // two shows
    ['node', 'x.js', '--show=all'], // keyword, not a slug
    ['node', 'x.js', '--show=ID'], // placeholder
    ['node', 'x.js', '--show='],
    ['node', 'x.js', '--showcase=a-b'],
  ]) assert.equal(showIdFromArgv(argv), null, argv.join(' '));
});

// Real process, real ledger write: what ingest-review-from-url.js --show=X and
// opening-night-lane.js --show=X rows now carry. Fails with the argv fallback reverted.
function rowFromChild(args, env = {}, adopt = true) {
  const ledger = path.join(os.tmpdir(), `spend-attr-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  const code = `const t = require(${JSON.stringify(path.join(HERE, 'provider-telemetry.js'))}); ${adopt ? 't.adoptArgvShow();' : ''} t.recordSbCall({ host: 'theatre.reviews', fn: 'page', success: true, credits: 1 });`;
  const childEnv = { ...process.env, SCRAPER_SPEND_LEDGER_PATH: ledger, ...env };
  delete childEnv.SCRAPER_SPEND_SHOW_ID;
  if (env.SCRAPER_SPEND_SHOW_ID) childEnv.SCRAPER_SPEND_SHOW_ID = env.SCRAPER_SPEND_SHOW_ID;
  delete childEnv.BD_TELEMETRY_DISABLED;
  const r = spawnSync(process.execPath, ['-e', code, '--', ...args], { env: childEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  try { return JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').pop()); } finally { fs.rmSync(ledger, { force: true }); }
}

test('a --show=ID process stamps that show on its SB ledger rows', (t) => {
  if (process.env.BD_TELEMETRY_DISABLED === '1') t.diagnostic('parent disables telemetry; child re-enables it');
  assert.equal(rowFromChild(['--show=hamlet-2026']).showId, 'hamlet-2026');
  assert.equal(rowFromChild(['--show=a-b,c-d']).showId, null, 'a show list stays unattributed');
  assert.equal(rowFromChild([]).showId, null);
  // Opt-in (BRO-8325 review): without adoptArgvShow() a --show=ID filter never attributes.
  assert.equal(rowFromChild(['--show=hamlet-2026'], {}, false).showId, null);
  // env wins over adopted argv: an orchestrator that exported an id keeps it.
  assert.equal(rowFromChild(['--show=show-b'], { SCRAPER_SPEND_SHOW_ID: 'show-a' }).showId, 'show-a');
  assert.equal(rowFromChild([], { SCRAPER_SPEND_SHOW_ID: 'show-a' }).showId, 'show-a');
});

// Per-show provider work in multi-show collectors (ledger 2026-11-26..28: every
// row from these scripts had showId null). Each entry: script + the wrapped call.
const WRAPPED_SITES = [
  ['audit-show-review-gap.js', /withSpendShow\(\s*s\.id,\s*\(\)\s*=>\s*auditShow\(/],
  ['audit-outlet-ground-truth.js', /withSpendShow\(\s*show\.id,\s*\(\)\s*=>\s*fetchJsonList\(wpSearchUrl\(/],
  ['audit-outlet-ground-truth.js', /withSpendShow\(\s*show\.id,\s*\(\)\s*=>\s*fetchJsonList\(`https:\/\/theatre\.reviews\//],
  ['audit-outlet-ground-truth.js', /withSpendShow\(\s*show\.id,\s*\(\)\s*=>\s*fetchText\(roundup\)/],
  ['collect-review-texts.js', /function processReview\(review\)\s*\{\s*return withSpendShow\(\s*review && review\.showId,/],
  ['replay-pending-bylines.js', /withSpendShow\(\s*id,\s*\(\)\s*=>\s*processShow\(id,/],
  ['backfill-unknown-critics.js', /withSpendShow\(\s*u\.dir,\s*\(\)\s*=>\s*fetchHtml\(u\.url\)/],
];

test('per-show collector loops run their provider calls inside withSpendShow', () => {
  for (const [file, re] of WRAPPED_SITES) {
    const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    assert.match(src, re, `${file}: per-show provider call must be wrapped in withSpendShow (BRO-8325)`);
    assert.match(src, /\{[^}]*\bwithSpendShow\b[^}]*\}\s*=\s*require\(['"]\.\/lib\/provider-telemetry['"]\)/, `${file}: withSpendShow must be imported`);
  }
  // collect-review-texts has a single per-review entry; no raw call may bypass the wrapper.
  const crt = fs.readFileSync(path.join(SCRIPTS, 'collect-review-texts.js'), 'utf8');
  assert.equal((crt.match(/processReviewInner\(/g) || []).length, 2, 'processReviewInner is only defined and called by processReview');
});

test('single-show scripts opt in to argv attribution', () => {
  for (const file of ['ingest-review-from-url.js', 'opening-night-lane.js']) {
    const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
    assert.match(src, /require\(['"]\.\/lib\/provider-telemetry['"]\)\.adoptArgvShow\(\)/, `${file}: must call adoptArgvShow() (BRO-8325)`);
  }
});
