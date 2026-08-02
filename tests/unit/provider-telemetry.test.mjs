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
  recordBbCall, recordBdCall, countCallsByProvider, topCallers, computeAttributedPct,
} = require('../../scripts/lib/provider-telemetry.js');

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
