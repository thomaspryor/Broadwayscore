// TESTS-VS-DERIVED-DATA-EXEMPT: structural check that each audit reports no stale baseline entries on live data; pins no specific facts
// BRO-5315: every baseline-diff audit must detect STALE baseline entries
// (keys with no live violation behind them). A fixed violation left in the
// baseline silently re-excuses the same regression later (BRO-2257). Pattern
// from tests/unit/audit-orphaned-audit-writes.test.mjs ('baseline holds no
// entries that are no longer orphans'), generalised via scripts/lib/stale-baseline.js.
//
// Two layers:
//   1. Detection logic, against fixtures, through the real exported functions
//      (CLAUDE.md rule 15): set + multiset diff, prune, CLI modes, and each
//      audit's own key function / stale helper.
//   2. Each audit's live baseline is clean: `--check-stale` exits 0 against
//      the real repo/data. Prune with `--prune-stale` (drops only stale keys;
//      --update-baseline would also accept any NEW violations).
//      Data-dependent audits skip when their private inputs are absent (the
//      CI unit-test job has core data but no review-texts / aggregator archive).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lib = require('../../scripts/lib/stale-baseline.js');
const { findStaleHealExemptions, evaluateGate } = require('../../scripts/lib/data-gate-heal-paths.js');
const bcp = require('../../scripts/lib/broadway-category-predicate-baseline.js');
const cvb = require('../../scripts/lib/cv-flag-contradiction-baseline.js');
const dsb = require('../../scripts/lib/duplicate-shows-baseline.js');
const ssu = require('../../scripts/lib/show-score-urls-baseline.js');
const { computeStaleSites, siteKey } = require('../../scripts/audit-venue-write-guard.js');
const { listAppPageRoutes, computeStalePages } = require('../../scripts/check-bundle-size.js');

// ---------- layer 1: detection logic ----------

test('set-shaped baseline: keys absent from the live set are stale', () => {
  assert.deepEqual(lib.computeStaleBaselineKeys(['a', 'b', 'c'], new Set(['b'])), ['a', 'c']);
  assert.deepEqual(lib.computeStaleBaselineKeys(['a'], ['a', 'a', 'x']), [], 'more live than baselined is new debt, not stale');
  assert.deepEqual(lib.computeStaleBaselineKeys([], ['a']), []);
});

test('multiset baseline compares COUNTS (broadway-category-predicate shape)', () => {
  const k = bcp.hitKey('scripts/x.js', "if (s.category === 'broadway')");
  const baselineCounts = bcp.baselineKeySet([
    { file: 'scripts/x.js', snippet: "if (s.category === 'broadway')" },
    { file: 'scripts/x.js', snippet: "if (s.category === 'broadway')" },
    { file: 'scripts/x.js', snippet: "if (s.category === 'broadway')" },
  ]);
  assert.deepEqual(lib.computeStaleBaselineKeys(baselineCounts, [k]), [k, k], '3 baselined, 1 live -> 2 stale copies');
  assert.deepEqual(lib.computeStaleBaselineKeys(baselineCounts, [k, k, k]), []);
});

test('pruneStaleEntries drops exactly the stale copies and never adds', () => {
  const entries = [{ k: 'a' }, { k: 'b' }, { k: 'a' }, { k: 'a' }, { k: 'c' }];
  const out = lib.pruneStaleEntries(entries, (e) => e.k, ['a', 'a', 'c']);
  assert.deepEqual(out.map((e) => e.k), ['a', 'b']);
  assert.equal(entries.length, 5, 'input not mutated');
});

test('runStaleModes: --check-stale exits 1 on stale, 0 when clean; --prune-stale prunes and exits 0', () => {
  const logs = [];
  const orig = console.log;
  console.log = (s) => logs.push(String(s));
  try {
    let code = null;
    let pruned = null;
    const base = { label: 't', updateCmd: 'x', prune: (s) => { pruned = s; }, exit: (c) => { code = c; } };
    assert.equal(lib.runStaleModes([], { ...base, stale: ['a'] }), false, 'no flag: caller continues');
    assert.equal(code, null);
    lib.runStaleModes(['--check-stale'], { ...base, stale: ['a'] });
    assert.equal(code, 1);
    assert.ok(logs.some((l) => l.includes('- a')), 'stale key is reported');
    assert.equal(pruned, null, '--check-stale is read-only');
    lib.runStaleModes(['--check-stale'], { ...base, stale: [] });
    assert.equal(code, 0);
    lib.runStaleModes(['--prune-stale'], { ...base, stale: ['a'] });
    assert.deepEqual(pruned, ['a']);
    assert.equal(code, 0);
  } finally {
    console.log = orig;
  }
});

test('per-audit key shapes: a fixed violation shows up as stale', () => {
  // cv-flag-contradiction: (showId, file)
  assert.deepEqual(
    lib.computeStaleBaselineKeys([cvb.hitKey('s1', 'a.json'), cvb.hitKey('s2', 'b.json')], [cvb.hitKey('s2', 'b.json')]),
    ['s1::a.json']
  );
  // duplicate-shows: unordered pair
  assert.deepEqual(lib.computeStaleBaselineKeys([dsb.pairKey('b', 'a')], [dsb.pairKey('a', 'b')]), []);
  assert.deepEqual(lib.computeStaleBaselineKeys([dsb.pairKey('x', 'y')], [dsb.pairKey('a', 'b')]), ['x|y']);
  // show-score-urls: url + id set — the same URL now shared by different ids is stale
  const old = { url: 'https://www.show-score.com/x/', showIds: ['a', 'b'] };
  const now = { url: 'https://www.show-score.com/x', showIds: ['a', 'c'] };
  assert.deepEqual(lib.computeStaleBaselineKeys([ssu.identityKey(old)], [ssu.identityKey(now)]), [ssu.identityKey(old)]);
  // venue-write-guard: file::snippet keyed object
  const live = [{ file: 'scripts/a.js', snippet: 'venue: v' }];
  const baseline = { sites: { [siteKey(live[0])]: {}, 'scripts/gone.js::venue: x': {} } };
  assert.deepEqual(computeStaleSites(live, baseline), ['scripts/gone.js::venue: x']);
});

test('data-gate-heal-paths: a heal-exempt annotation on a gate with a real heal path is stale', () => {
  const ctx = { scriptSource: "const BASELINE = 'data/audit/x-baseline.json'; if (args.includes('--update-baseline')) {}", workflowFiles: [] };
  const healed = evaluateGate({ script: 'audit-x', flags: '--strict', healExemptReason: 'why' }, ctx);
  const exempt = evaluateGate({ script: 'audit-y', flags: '--strict', healExemptReason: 'why' }, { scriptSource: '', workflowFiles: [] });
  const plain = evaluateGate({ script: 'audit-z', flags: '--strict', healExemptReason: null }, ctx);
  assert.equal(healed.healPath, 'baseline-diff', 'fixture must exercise the baseline-diff path');
  assert.deepEqual(findStaleHealExemptions([healed, exempt, plain], 'test.yml'), ['test.yml:audit-x']);
});

test('check-bundle-size: routes come from src/app; a deleted page is stale (no build needed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5315-app-'));
  try {
    for (const p of ['page.tsx', 'show/[slug]/page.tsx', '(marketing)/about/page.tsx', '_lib/page.tsx', '@modal/x/page.tsx', 'api/ping/route.ts']) {
      fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), '');
    }
    const routes = listAppPageRoutes(dir);
    assert.deepEqual([...routes].sort(), ['/', '/about', '/api/ping', '/show/[slug]']);
    assert.deepEqual(computeStalePages({ pages: { '/': 1, '/about': 1, '/gone': 1 } }, routes), ['/gone']);
    // Build-only framework/metadata routes are never stale against the static list.
    const pages = { '/': 1, '/_not-found': 1, '/robots.txt': 1, '/sitemap.xml': 1, '/sitemap/[__metadata_id__]': 1, '/gone': 1 };
    assert.deepEqual(computeStalePages({ pages }, routes, { staticRoutes: true }), ['/gone']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- layer 2: every live baseline is clean ----------

const hasDir = (rel) => { try { return fs.readdirSync(path.join(ROOT, rel)).length > 0; } catch { return false; } };
const hasFile = (rel) => fs.existsSync(path.join(ROOT, rel));
const CORPUS = hasDir('data/review-texts') && hasFile('data/shows.json');

const AUDITS = [
  { script: 'audit-broadway-category-predicate.js' },
  { script: 'audit-direct-provider-calls.js' },
  { script: 'audit-venue-write-guard.js' },
  { script: 'audit-data-gate-heal-paths.js' },
  { script: 'check-bundle-size.js' }, // static: baseline pages vs src/app routes, no build
  { script: 'audit-show-score-urls.js', skip: !(hasFile('data/show-score-urls.json') && hasFile('data/shows.json')) && 'core data absent' },
  { script: 'audit-cv-flag-contradiction.js', skip: !CORPUS && 'review-texts corpus absent' },
  { script: 'audit-duplicate-shows.js', skip: !CORPUS && 'review-texts corpus absent' },
  { script: 'audit-sibling-title-misroute.js', skip: !CORPUS && 'review-texts corpus absent' },
  { script: 'audit-aggregator-archive-integrity.js', skip: !(hasDir('data/aggregator-archive') && hasFile('data/shows.json')) && 'aggregator archive absent' },
];

for (const { script, skip } of AUDITS) {
  test(`${script}: baseline holds no stale entries`, { skip: skip || false, timeout: 300_000 }, () => {
    const r = spawnSync(process.execPath, [path.join('scripts', script), '--check-stale'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().split('\n').slice(-15).join('\n');
    assert.equal(r.status, 0, `${script} --check-stale exited ${r.status}; prune with: node scripts/${script} --prune-stale\n${tail}`);
  });
}
