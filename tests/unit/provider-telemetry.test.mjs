/**
 * Tests for scripts/lib/provider-telemetry.js (task #752).
 *
 * Two things under test: (1) the ledger/stdout recording plumbing, including
 * the new Browserbase support and the null-safety that bd-telemetry.test.mjs
 * exercises for the legacy wrappers, and (2) the pure attributedPct reducer —
 * the actual point of #752: turning "we believe we track everything" into a
 * falsifiable number.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEDGER_SCRATCH = path.join(os.tmpdir(), `provider-telemetry-test-ledger-${process.pid}.jsonl`);
process.env.SCRAPER_SPEND_LEDGER_PATH = LEDGER_SCRATCH;

const require = createRequire(import.meta.url);
const {
  recordBbCall, recordBdCall, recordSbCall, recordSdCall,
  countCallsByProvider, topCallers, computeAttributedPct,
} = require('../../scripts/lib/provider-telemetry.js');
const { mergeScraperSpendLedger } = require('../../scripts/lib/merge-scraper-spend-ledger.js');

function _captureStdout(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { fn(); } finally { console.log = orig; }
  return lines;
}

function _readLedger() {
  try {
    return fs.readFileSync(LEDGER_SCRATCH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

test.beforeEach(() => { try { fs.unlinkSync(LEDGER_SCRATCH); } catch { /* fine if absent */ } });

// ---------- recording ----------

test('recordBbCall emits [BB Call] and appends a ledger row with caller/purpose', () => {
  const out = _captureStdout(() => {
    recordBbCall({ caller: 'gather-reviews:talkin-broadway', purpose: 'TS live fetch', success: true, status: 201 });
  });
  const [line] = out.filter(l => l.startsWith('[BB Call] '));
  assert.ok(line, 'expected a [BB Call] stdout line');
  const record = JSON.parse(line.slice('[BB Call] '.length));
  assert.equal(record.provider, 'browserbase');
  assert.equal(record.script, 'gather-reviews:talkin-broadway');
  assert.equal(record.purpose, 'TS live fetch');
  assert.equal(record.success, true);

  const ledger = _readLedger();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].provider, 'browserbase');
});

test('recordBdCall/recordBbCall never throw on missing opts', () => {
  assert.doesNotThrow(() => recordBdCall(null));
  assert.doesNotThrow(() => recordBdCall(undefined));
  assert.doesNotThrow(() => recordBbCall(null));
  assert.doesNotThrow(() => recordBbCall({}));
});

test('ledger accumulates one row per call across providers', () => {
  _captureStdout(() => {
    recordBdCall({ url: 'https://variety.com', fn: 'web-unlocker', success: true, status: 200 });
    recordBbCall({ caller: 'scrape-thestage-roundups.js', success: true, status: 201 });
    recordBbCall({ caller: 'scrape-thestage-roundups.js', success: true, status: 201 });
  });
  const ledger = _readLedger();
  assert.equal(ledger.length, 3);
  assert.equal(ledger.filter(r => r.provider === 'browserbase').length, 2);
});

// ---------- concurrent-writer race + reconciliation (task #784) ----------
//
// _appendLedgerLine() is a local readFileSync + push + writeFileSync, not a
// true append — reproduces the scenario where two CI runners each check out
// the same committed ledger ("base"), then independently call
// recordXCall() (which internally calls _appendLedgerLine()) against their
// own local copy without seeing the other's write. When push-with-retry.sh's
// `git rebase -X theirs` resolves the resulting conflicting hunk WITHOUT
// reporting a conflict, ONE runner's appended row is silently dropped unless
// mergeScraperSpendLedger() (invoked by reconcile-merged-json.js) unions them
// back together.

test('two concurrent runners each appending to the same base ledger both survive reconciliation', () => {
  const oursPath = path.join(os.tmpdir(), `provider-telemetry-test-ours-${process.pid}.jsonl`);
  const remotePath = path.join(os.tmpdir(), `provider-telemetry-test-remote-${process.pid}.jsonl`);
  try { fs.unlinkSync(oursPath); } catch { /* fine if absent */ }
  try { fs.unlinkSync(remotePath); } catch { /* fine if absent */ }

  // A prior commit already landed one row — this is the shared "base" both
  // runners check out before appending.
  process.env.SCRAPER_SPEND_LEDGER_PATH = oursPath;
  _captureStdout(() => {
    recordBdCall({ url: 'https://variety.com', fn: 'web-unlocker', success: true, status: 200 });
  });
  fs.copyFileSync(oursPath, remotePath);

  // Runner A (e.g. sweep-we-aggregators.js) appends its own call against its
  // local checkout of the base ledger, unaware of runner B.
  process.env.SCRAPER_SPEND_LEDGER_PATH = oursPath;
  _captureStdout(() => {
    recordSbCall({ url: 'https://westendtheatre.com', fn: 'page', success: true, status: 200, credits: 5 });
  });

  // Runner B (e.g. scrape-thestage-roundups.js) appends a DIFFERENT call
  // against its own local checkout of the same base, concurrently.
  process.env.SCRAPER_SPEND_LEDGER_PATH = remotePath;
  _captureStdout(() => {
    recordSdCall({ url: 'https://thestage.co.uk', fn: 'page', success: true, status: 200, credits: 3 });
  });
  process.env.SCRAPER_SPEND_LEDGER_PATH = LEDGER_SCRATCH;

  const oursEntries = fs.readFileSync(oursPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const remoteEntries = fs.readFileSync(remotePath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(oursEntries.length, 2); // base + runner A's row
  assert.equal(remoteEntries.length, 2); // base + runner B's row

  // Without reconciliation, `git rebase -X theirs` would silently keep
  // "ours" (base + runner A) and drop runner B's row entirely — the bug this
  // card exists to fix. mergeScraperSpendLedger() is what reconcile-merged-
  // json.js calls post-rebase to union them back together.
  const { merged, stats } = mergeScraperSpendLedger(oursEntries, remoteEntries);
  assert.equal(merged.length, 3, 'both concurrent rows must survive reconciliation, not just one side');
  assert.ok(merged.some(r => r.provider === 'scrapingbee'), "runner A's row survives");
  assert.ok(merged.some(r => r.provider === 'scrapingdog'), "runner B's row must not be dropped");
  assert.equal(stats.added, 1); // only runner B's row was novel; the shared base row was deduped

  try { fs.unlinkSync(oursPath); } catch { /* cleanup */ }
  try { fs.unlinkSync(remotePath); } catch { /* cleanup */ }
});

test('mergeScraperSpendLedger collapses an exact-duplicate re-read (amend read-back) but keeps distinct rows', () => {
  const base = { ts: '2026-08-02T10:00:00.000Z', provider: 'brightdata', script: 'x.js', workflow: null, host: 'a.com', fn: 'web-unlocker', success: true, status: 200, credits: null, fallback_from: null, purpose: null };
  const distinct = { ...base, host: 'b.com' };
  const { merged, stats } = mergeScraperSpendLedger([base], [base, distinct]);
  assert.equal(merged.length, 2);
  assert.equal(stats.added, 1);
  assert.equal(stats.kept, 1); // the byte-identical base row collapsed, not duplicated
});

// ---------- countCallsByProvider / topCallers ----------

test('countCallsByProvider counts only the requested day', () => {
  const records = [
    { ts: '2026-08-01T10:00:00Z', provider: 'browserbase' },
    { ts: '2026-08-01T11:00:00Z', provider: 'browserbase' },
    { ts: '2026-08-02T09:00:00Z', provider: 'browserbase' },
    { ts: '2026-08-01T12:00:00Z', provider: 'brightdata' },
  ];
  const counts = countCallsByProvider(records, '2026-08-01');
  assert.deepEqual(counts, { browserbase: 2, brightdata: 1 });
});

test('topCallers ranks by count, ties broken alphabetically, capped at n', () => {
  const records = [
    { ts: '2026-08-01T01:00:00Z', provider: 'browserbase', script: 'sweep-we-aggregators.js' },
    { ts: '2026-08-01T02:00:00Z', provider: 'browserbase', script: 'sweep-we-aggregators.js' },
    { ts: '2026-08-01T03:00:00Z', provider: 'browserbase', script: 'gather-reviews.js' },
    { ts: '2026-08-01T04:00:00Z', provider: 'browserbase', script: 'gather-reviews.js' },
    { ts: '2026-08-01T05:00:00Z', provider: 'browserbase', script: 'scrape-thestage-roundups.js' },
  ];
  const top = topCallers(records, '2026-08-01', 'browserbase', 2);
  assert.deepEqual(top, [
    { script: 'gather-reviews.js', count: 2 },
    { script: 'sweep-we-aggregators.js', count: 2 },
  ]);
});

// ---------- computeAttributedPct: the actual point of #752 ----------

test('full coverage: ledger count matches billing count exactly -> 1.0', () => {
  const pct = computeAttributedPct(
    { browserbase: 30 },
    { browserbase: { status: 'ok', sessions: 30 } },
  );
  assert.equal(pct.browserbase, 1);
});

test('partial coverage: ledger undercounts billing -> fractional pct', () => {
  const pct = computeAttributedPct(
    { browserbase: 18 },
    { browserbase: { status: 'ok', sessions: 30 } },
  );
  assert.equal(pct.browserbase, 0.6);
});

test('zero coverage: billing shows spend, ledger has nothing -> 0 (the Aug 1 scenario)', () => {
  const pct = computeAttributedPct(
    { /* nothing recorded */ },
    { browserbase: { status: 'ok', sessions: 99 } },
  );
  assert.equal(pct.browserbase, 0);
});

test('genuine zero-spend day: billing 0, ledger 0 -> 1.0, not null', () => {
  const pct = computeAttributedPct(
    {},
    { browserbase: { status: 'ok', sessions: 0 } },
  );
  assert.equal(pct.browserbase, 1);
});

test('unmeasurable billing day -> null, never a false 0 or 100%', () => {
  const pct = computeAttributedPct(
    { browserbase: 12 },
    { browserbase: { status: 'unknown' } },
  );
  assert.equal(pct.browserbase, null);
});

test('ledger overcounting billing (e.g. billing lag) is clamped to 1.0, never >100%', () => {
  const pct = computeAttributedPct(
    { browserbase: 40 },
    { browserbase: { status: 'ok', sessions: 30 } },
  );
  assert.equal(pct.browserbase, 1);
});

test('brightdata combines serpReqs + unlockerReqs as the billing denominator', () => {
  const pct = computeAttributedPct(
    { brightdata: 8 },
    { brightdata: { status: 'ok', serpReqs: 5, unlockerReqs: 5 } },
  );
  assert.equal(pct.brightdata, 0.8);
});

test('scrapingbee/scrapingdog use dayCredits as the billing denominator', () => {
  const pct = computeAttributedPct(
    { scrapingbee: 9, scrapingdog: 4 },
    {
      scrapingbee: { status: 'ok', dayCredits: 10 },
      scrapingdog: { status: 'baseline' }, // baseline (no dayCredits yet) -> unmeasurable
    },
  );
  assert.equal(pct.scrapingbee, 0.9);
  assert.equal(pct.scrapingdog, null);
});

test('missing provider entry in billing record -> null for that provider', () => {
  const pct = computeAttributedPct({ browserbase: 5 }, {});
  assert.equal(pct.browserbase, null);
});
