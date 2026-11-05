/**
 * Unit tests for scripts/lib/scrapingdog-caps.js (card #1252).
 *
 * Run: node --test scripts/lib/scrapingdog-caps.test.mjs
 *
 * Production code requires this module — change a decision function, these
 * fail. That is the point (CLAUDE.md rule 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('./scrapingdog-caps.js');
const { utcDay } = require('./brightdata-caps.js');

const {
  DEFAULT_DAILY_CREDIT_CEILING,
  resolveDailyCreditCeiling,
  resolveExemptScripts,
  shouldTripBreaker,
  computeTodayCredits,
  isBreakerActive,
  consultScrapingdog,
  getScrapingdogCapStats,
  _resetForTests,
} = caps;

// ---------- resolvers ----------

test('resolveDailyCreditCeiling: default when env unset', () => {
  assert.equal(resolveDailyCreditCeiling({}), DEFAULT_DAILY_CREDIT_CEILING);
});

test('resolveDailyCreditCeiling: honors a positive override', () => {
  assert.equal(resolveDailyCreditCeiling({ SD_BREAKER_CEILING: '1' }), 1);
  assert.equal(resolveDailyCreditCeiling({ SD_BREAKER_CEILING: '9000' }), 9000);
});

test('resolveDailyCreditCeiling: garbage/zero/negative fall back, never NaN or 0', () => {
  for (const bad of ['', 'abc', '0', '-5', undefined]) {
    assert.equal(resolveDailyCreditCeiling({ SD_BREAKER_CEILING: bad }), DEFAULT_DAILY_CREDIT_CEILING, `input ${JSON.stringify(bad)}`);
  }
});

test('resolveExemptScripts: default reuses BD list, env override, blank env ignored', () => {
  assert.ok(resolveExemptScripts({}).includes('opening-night-poller.js'));
  assert.deepEqual(resolveExemptScripts({ SD_EXEMPT_SCRIPTS: 'a.js, b.js' }), ['a.js', 'b.js']);
  assert.ok(resolveExemptScripts({ SD_EXEMPT_SCRIPTS: '   ' }).includes('opening-night-poller.js'));
});

// ---------- shouldTripBreaker ----------

test('shouldTripBreaker: over and exactly at the ceiling both trip', () => {
  assert.equal(shouldTripBreaker({ dayCredits: 46000, ceiling: 45000 }).tripped, true);
  assert.equal(shouldTripBreaker({ dayCredits: 45000, ceiling: 45000 }).tripped, true);
});

test('shouldTripBreaker: under the ceiling does not trip', () => {
  assert.equal(shouldTripBreaker({ dayCredits: 44999, ceiling: 45000 }).tripped, false);
  assert.equal(shouldTripBreaker({ dayCredits: 0, ceiling: 45000 }).tripped, false);
});

test('shouldTripBreaker: unknown/null credits is NOT zero and NOT over — fails open', () => {
  for (const bad of [null, undefined, NaN, 'lots']) {
    const v = shouldTripBreaker({ dayCredits: bad, ceiling: 45000 });
    assert.equal(v.tripped, false, `input ${String(bad)}`);
    assert.equal(v.reason, 'unknown-billing');
  }
});

test('shouldTripBreaker: a missing/zero ceiling never trips', () => {
  assert.equal(shouldTripBreaker({ dayCredits: 999999, ceiling: 0 }).reason, 'no-ceiling');
  assert.equal(shouldTripBreaker({ dayCredits: 999999, ceiling: NaN }).tripped, false);
});

// ---------- computeTodayCredits ----------

test('computeTodayCredits: cold start (no prevState) is a baseline day, never a trip', () => {
  const r = computeTodayCredits({ cycleUsed: 50000, day: '2026-08-11', prevState: null });
  assert.equal(r.status, 'baseline');
  assert.equal(r.dayCredits, null);
  assert.deepEqual(r.newState, { day: '2026-08-11', dayBaseline: 50000, lastCycleUsed: 50000 });
});

test('computeTodayCredits: same-day reads diff against the SAME baseline', () => {
  const prevState = { day: '2026-08-11', dayBaseline: 50000, lastCycleUsed: 50500 };
  const r = computeTodayCredits({ cycleUsed: 51200, day: '2026-08-11', prevState });
  assert.equal(r.status, 'ok');
  assert.equal(r.dayCredits, 1200);
  assert.equal(r.newState.dayBaseline, 50000, 'baseline must not drift across same-day reads');
});

test('computeTodayCredits: day rollover carries forward YESTERDAY\'S LAST reading, not today\'s first', () => {
  // This is the exact bug the cycleDelta-parity fix guards against: resetting
  // to "whatever today's first reading happens to be" would silently absorb
  // a post-midnight burst into the new baseline.
  const prevState = { day: '2026-08-10', dayBaseline: 40000, lastCycleUsed: 44000, updatedAt: '2026-08-10T23:30:00.000Z' };
  const r = computeTodayCredits({ cycleUsed: 44300, day: '2026-08-11', prevState });
  assert.equal(r.status, 'ok');
  assert.equal(r.dayCredits, 300, 'diff must be against 44000 (yesterday\'s last reading), not 44300 (today\'s first)');
  assert.equal(r.newState.dayBaseline, 44000);
});

test('computeTodayCredits: BRO-3020 stale prev reading on rollover degrades to baseline (no phantom day)', () => {
  const prevState = { day: '2026-08-10', dayBaseline: 40000, lastCycleUsed: 44000, updatedAt: '2026-08-10T00:26:11.000Z' };
  const r = computeTodayCredits({ cycleUsed: 94000, day: '2026-08-11', prevState });
  assert.equal(r.status, 'baseline');
  assert.equal(r.dayCredits, null);
  assert.equal(r.newState.dayBaseline, 94000);
  assert.match(r.reason, /mis-attribute/);
});

test('computeTodayCredits: rollover window boundary is inclusive at 6h', () => {
  const mk = (updatedAt) => computeTodayCredits({ cycleUsed: 44300, day: '2026-08-11',
    prevState: { day: '2026-08-10', dayBaseline: 40000, lastCycleUsed: 44000, updatedAt } });
  assert.equal(mk('2026-08-10T18:00:00.000Z').status, 'ok');
  assert.equal(mk('2026-08-10T17:59:59.000Z').status, 'baseline');
});

test('computeTodayCredits: missing/invalid updatedAt on rollover degrades to baseline', () => {
  for (const updatedAt of [undefined, null, 'garbage', 12345]) {
    const r = computeTodayCredits({ cycleUsed: 44300, day: '2026-08-11',
      prevState: { day: '2026-08-10', dayBaseline: 40000, lastCycleUsed: 44000, updatedAt } });
    assert.equal(r.status, 'baseline', String(updatedAt));
    assert.equal(r.dayCredits, null);
  }
});

test('computeTodayCredits: future updatedAt (clock skew) on rollover degrades to baseline', () => {
  const r = computeTodayCredits({ cycleUsed: 44300, day: '2026-08-11',
    prevState: { day: '2026-08-10', dayBaseline: 40000, lastCycleUsed: 44000, updatedAt: '2026-08-11T05:00:00.000Z' } });
  assert.equal(r.status, 'baseline');
});

test('computeTodayCredits: a gap of more than one day degrades to baseline, never a false trip', () => {
  const prevState = { day: '2026-08-08', dayBaseline: 10000, lastCycleUsed: 12000 };
  const r = computeTodayCredits({ cycleUsed: 40000, day: '2026-08-11', prevState });
  assert.equal(r.status, 'baseline');
  assert.equal(r.dayCredits, null);
  assert.equal(r.newState.dayBaseline, 40000);
});

test('computeTodayCredits: counter going down mid-day means the cycle renewed — new cycle IS today\'s usage', () => {
  const prevState = { day: '2026-08-11', dayBaseline: 40000, lastCycleUsed: 44900 };
  const r = computeTodayCredits({ cycleUsed: 500, day: '2026-08-11', prevState });
  assert.equal(r.status, 'ok');
  assert.equal(r.dayCredits, 500);
  assert.equal(r.newState.dayBaseline, 0, 'baseline clamps to 0 so later same-day reads keep diffing correctly');
});

test('computeTodayCredits: after a mid-day renewal, a later same-day read keeps accumulating correctly', () => {
  const afterRenewal = { day: '2026-08-11', dayBaseline: 0, lastCycleUsed: 500 };
  const r = computeTodayCredits({ cycleUsed: 900, day: '2026-08-11', prevState: afterRenewal });
  assert.equal(r.dayCredits, 900);
});

test('computeTodayCredits: unreachable billing (null cycleUsed) leaves prevState untouched', () => {
  const prevState = { day: '2026-08-11', dayBaseline: 40000, lastCycleUsed: 44000 };
  const r = computeTodayCredits({ cycleUsed: null, day: '2026-08-11', prevState });
  assert.equal(r.status, 'unknown');
  assert.equal(r.dayCredits, null);
  assert.deepEqual(r.newState, prevState);
});

test('computeTodayCredits: unreachable billing with no prior state at all', () => {
  const r = computeTodayCredits({ cycleUsed: NaN, day: '2026-08-11', prevState: null });
  assert.equal(r.status, 'unknown');
  assert.equal(r.newState, null);
});

// ---------- isBreakerActive ----------

test('isBreakerActive: same day + trippedAt blocks', () => {
  assert.equal(isBreakerActive({ day: '2026-08-11', trippedAt: '2026-08-11T12:00:00.000Z' }, '2026-08-11'), true);
});

test('isBreakerActive: yesterday\'s state expires with its day', () => {
  assert.equal(isBreakerActive({ day: '2026-08-10', trippedAt: '2026-08-10T12:00:00.000Z' }, '2026-08-11'), false);
});

test('isBreakerActive: absent/garbage state never blocks', () => {
  for (const s of [null, undefined, {}, 'nope', 42]) {
    assert.equal(isBreakerActive(s, '2026-08-11'), false);
  }
});

test('isBreakerActive: an entry without trippedAt is a cleared entry', () => {
  assert.equal(isBreakerActive({ day: '2026-08-11', trippedAt: null }, '2026-08-11'), false);
});

// ---------- consultScrapingdog (stateful) ----------

function withStateFile(state) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdcaps-')), 'sd-circuit-breaker.json');
  if (state !== null) fs.writeFileSync(p, JSON.stringify(state));
  return p;
}

const TRIPPED = (day) => ({ day, trippedAt: '2026-08-11T12:00:00.000Z', dayCredits: 46000, ceiling: 45000 });

test('consultScrapingdog: no breaker → allowed', () => {
  _resetForTests();
  const env = { SD_BREAKER_STATE_PATH: withStateFile({}) };
  assert.equal(consultScrapingdog({ env }).allowed, true);
});

test('consultScrapingdog: tripped breaker blocks a bulk caller without throwing', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)) };
  const v = consultScrapingdog({ env });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'breaker');
  assert.equal(getScrapingdogCapStats().blockedByBreaker, 1);
});

test('consultScrapingdog: opening-night caller (via BD_OPENING_NIGHT) is exempt even with the breaker tripped', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)), BD_OPENING_NIGHT: '1' };
  const v = consultScrapingdog({ env });
  assert.equal(v.allowed, true);
  assert.equal(v.exempt, true);
});

test('consultScrapingdog: opening-night workflow name exempts too', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)), GITHUB_WORKFLOW: 'Opening Night Poller' };
  assert.equal(consultScrapingdog({ env }).allowed, true);
});

test('consultScrapingdog: a missing state file fails open', () => {
  _resetForTests();
  const env = { SD_BREAKER_STATE_PATH: path.join(os.tmpdir(), 'sdcaps-does-not-exist', 'x.json') };
  assert.equal(consultScrapingdog({ env }).allowed, true);
});

test('consultScrapingdog: a corrupt state file fails open', () => {
  _resetForTests();
  const p = withStateFile({});
  fs.writeFileSync(p, '{not json');
  assert.equal(consultScrapingdog({ env: { SD_BREAKER_STATE_PATH: p } }).allowed, true);
});

test('consultScrapingdog: SD_CAPS_DISABLED=1 is a full kill switch', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)), SD_CAPS_DISABLED: '1' };
  assert.equal(consultScrapingdog({ env }).allowed, true);
});

test('consultScrapingdog: firstBlock is true once, then false — one ledger row per process', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)) };
  assert.equal(consultScrapingdog({ env }).firstBlock, true);
  assert.equal(consultScrapingdog({ env }).firstBlock, false);
  assert.equal(consultScrapingdog({ env }).firstBlock, false);
  assert.equal(getScrapingdogCapStats().blocked, 3, 'every withheld call still counts');
});

test('consultScrapingdog: a cleared breaker (yesterday\'s trip) does not block today', () => {
  _resetForTests();
  const env = { SD_BREAKER_STATE_PATH: withStateFile(TRIPPED('2026-08-01')) };
  assert.equal(consultScrapingdog({ env, now: new Date('2026-08-11T12:00:00Z') }).allowed, true);
});

test('pressNightSpentUsd ignores zero-credit memo-skip rows but counts credit-bearing ones (BRO-6898)', () => {
  const purpose = 'press-night:some-show:2026-11-03';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-cap-'));
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  const table = { scrapingdog: { usdPerUnit: 0.01 } };
  const row = (extra) => JSON.stringify({ provider: 'scrapingdog', purpose, success: true, credits: 1, ...extra });
  fs.writeFileSync(ledgerPath, [
    row({}),
    row({ fn: 'run-memo-skip', status: 'run-memo-skip', success: false, credits: 0 }),
    row({ fn: 'run-memo-skip', success: false, credits: 4 }),
  ].join('\n') + '\n');
  // 1 real call (1 unit) + 1 credit-bearing skip row (4 units); the zero-credit skip row adds nothing.
  assert.equal(caps.pressNightSpentUsd(purpose, { ledgerPath, table }), 0.05);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- BRO-6989: incremental press-night ledger total ----------

const PN = 'press-night:some-show:2026-11-03';
const PN_TABLE = { scrapingdog: { usdPerUnit: 0.01 } };
const pnRow = (i, purpose = PN, ts = i) => JSON.stringify({ ts: new Date(1e12 + ts * 1000).toISOString(), provider: 'scrapingdog', purpose, success: true, credits: 1 + (i % 3) });

function pnLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-cap-'));
  return { dir, ledgerPath: path.join(dir, 'ledger.jsonl') };
}
// Ground truth: the same bytes read through a fresh path (cache miss = full scan).
function fullScan(ledgerPath, dir) {
  const copy = path.join(dir, `oracle-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.copyFileSync(ledgerPath, copy);
  return caps.pressNightSpentUsd(PN, { ledgerPath: copy, table: PN_TABLE });
}
function checkSame(ledgerPath, dir) {
  const cached = caps.pressNightSpentUsd(PN, { ledgerPath, table: PN_TABLE });
  assert.equal(cached, fullScan(ledgerPath, dir));
  return cached;
}

test('pressNightSpentUsd cached total equals full scan across appends', () => {
  _resetForTests();
  const { dir, ledgerPath } = pnLedger();
  fs.writeFileSync(ledgerPath, Array.from({ length: 50 }, (_, i) => pnRow(i, i % 2 ? PN : 'other')).join('\n') + '\n');
  const first = checkSame(ledgerPath, dir);
  for (let i = 50; i < 70; i++) {
    fs.appendFileSync(ledgerPath, pnRow(i) + '\n');
    checkSame(ledgerPath, dir);
  }
  assert.ok(checkSame(ledgerPath, dir) > first);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pressNightSpentUsd handles a partial (unterminated) tail without double counting', () => {
  _resetForTests();
  const { dir, ledgerPath } = pnLedger();
  const full = pnRow(1);
  fs.writeFileSync(ledgerPath, pnRow(0) + '\n' + full.slice(0, 20));
  const a = caps.pressNightSpentUsd(PN, { ledgerPath, table: PN_TABLE });
  fs.appendFileSync(ledgerPath, full.slice(20) + '\n');
  const b = checkSame(ledgerPath, dir);
  assert.ok(b > a);
  // complete row with no trailing newline is counted, then the newline arrives: still counted once
  fs.appendFileSync(ledgerPath, pnRow(2));
  const c = checkSame(ledgerPath, dir);
  fs.appendFileSync(ledgerPath, '\n');
  assert.equal(checkSame(ledgerPath, dir), c);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pressNightSpentUsd rescans after a trim rewrite (shrink, same inode)', () => {
  _resetForTests();
  const { dir, ledgerPath } = pnLedger();
  const rows = Array.from({ length: 100 }, (_, i) => pnRow(i));
  fs.writeFileSync(ledgerPath, rows.join('\n') + '\n');
  checkSame(ledgerPath, dir);
  fs.writeFileSync(ledgerPath, rows.slice(60).join('\n') + '\n');
  checkSame(ledgerPath, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pressNightSpentUsd rescans when a trim keeps line 0 and the size stays above the offset', () => {
  _resetForTests();
  const { dir, ledgerPath } = pnLedger();
  // Row 0 has the oldest ts-but-one; trim drops older-than-it rows is simulated by
  // dropping middle rows while keeping the first line, then appending more than was dropped.
  const rows = Array.from({ length: 100 }, (_, i) => pnRow(i));
  fs.writeFileSync(ledgerPath, rows.join('\n') + '\n');
  checkSame(ledgerPath, dir);
  const kept = [rows[0], ...rows.slice(30)];
  const extra = Array.from({ length: 80 }, (_, i) => pnRow(200 + i));
  fs.writeFileSync(ledgerPath, [...kept, ...extra].join('\n') + '\n');
  assert.ok(fs.statSync(ledgerPath).size > 0);
  checkSame(ledgerPath, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pressNightSpentUsd rescans after a same-size rewrite and after an atomic rename replace', () => {
  _resetForTests();
  const { dir, ledgerPath } = pnLedger();
  fs.writeFileSync(ledgerPath, Array.from({ length: 20 }, (_, i) => pnRow(i)).join('\n') + '\n');
  const before = checkSame(ledgerPath, dir);
  // same byte length, different content (credits digit flipped 1->3 on every row would change size? keep length: swap provider-neutral ts digit)
  const text = fs.readFileSync(ledgerPath, 'utf8').replace(/"credits":1/g, '"credits":2');
  assert.equal(text.length, fs.statSync(ledgerPath).size);
  fs.writeFileSync(ledgerPath, text);
  assert.notEqual(checkSame(ledgerPath, dir), before);
  const tmp = path.join(dir, 'new.jsonl');
  fs.writeFileSync(tmp, Array.from({ length: 5 }, (_, i) => pnRow(i)).join('\n') + '\n');
  fs.renameSync(tmp, ledgerPath);
  checkSame(ledgerPath, dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pressNightSpentUsd: missing ledger is 0, and a different price table is not served from cache', () => {
  _resetForTests();
  const { dir, ledgerPath } = pnLedger();
  assert.equal(caps.pressNightSpentUsd(PN, { ledgerPath, table: PN_TABLE }), 0);
  fs.writeFileSync(ledgerPath, pnRow(0) + '\n');
  const a = caps.pressNightSpentUsd(PN, { ledgerPath, table: PN_TABLE });
  const b = caps.pressNightSpentUsd(PN, { ledgerPath, table: { scrapingdog: { usdPerUnit: 1 } } });
  assert.ok(b > a * 50);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pressNightSpentUsd warm calls on a 44MB-class ledger average under 20 ms (BRO-6989)', () => {
  _resetForTests();
  const { dir, ledgerPath } = pnLedger();
  const filler = 'x'.repeat(280);
  const lines = [];
  for (let i = 0; i < 114000; i++) lines.push(JSON.stringify({ ts: i, provider: 'scrapingdog', purpose: i % 50 === 0 ? PN : `press-night:other-${i % 7}:2026-11-03`, success: true, credits: 1, pad: filler }));
  fs.writeFileSync(ledgerPath, lines.join('\n') + '\n');
  assert.ok(fs.statSync(ledgerPath).size > 30e6);
  caps.pressNightSpentUsd(PN, { ledgerPath, table: PN_TABLE }); // cold: full scan, no target
  const N = 30;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    fs.appendFileSync(ledgerPath, pnRow(i) + '\n');
    caps.pressNightSpentUsd(PN, { ledgerPath, table: PN_TABLE });
  }
  const avgMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  assert.ok(avgMs < 20, `avg ${avgMs.toFixed(2)} ms`);
  assert.equal(caps.pressNightSpentUsd(PN, { ledgerPath, table: PN_TABLE }), fullScan(ledgerPath, dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pressNightSpentUsd retries when a trim rewrite lands between validation and read (torn read)', () => {
  _resetForTests();
  const { dir, ledgerPath } = pnLedger();
  const rows = Array.from({ length: 30 }, (_, i) => pnRow(i));
  fs.writeFileSync(ledgerPath, rows.join('\n') + '\n');
  checkSame(ledgerPath, dir); // prime the cache
  fs.appendFileSync(ledgerPath, pnRow(100) + '\n');
  const realRead = fs.readSync;
  let calls = 0;
  fs.readSync = (...args) => {
    const n = realRead(...args);
    if (++calls === 2) {
      // trim lands after head + fingerprint validation, before the data read: drop 3 oldest rows, append 3 new ones
      fs.writeFileSync(ledgerPath, [...rows.slice(3), pnRow(100), pnRow(101), pnRow(102), pnRow(103)].map((r, i) => (i >= 27 ? r.replace(/"credits":\d/, '"credits":9') : r)).join('\n') + '\n');
    }
    return n;
  };
  let cached;
  try { cached = caps.pressNightSpentUsd(PN, { ledgerPath, table: PN_TABLE }); } finally { fs.readSync = realRead; }
  assert.equal(cached, fullScan(ledgerPath, dir));
  assert.equal(checkSame(ledgerPath, dir), cached);
  fs.rmSync(dir, { recursive: true, force: true });
});
