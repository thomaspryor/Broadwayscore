import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SC = require('../../src/lib/score-call.js');
const P = require('../../scripts/lib/review-forecast-pilot.js');
const { buildSyncRows } = require('../../scripts/lib/score-call-forecasts.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

test('parseCall accepts only integers 0-100', () => {
  assert.equal(SC.parseCall(0), 0); assert.equal(SC.parseCall('73'), 73); assert.equal(SC.parseCall(100), 100);
  for (const bad of [-1, 101, 5.5, NaN, '', 'abc', null, undefined]) assert.equal(SC.parseCall(bad), null);
});
test('resultStrip: off by N, beat forecast, null forecast', () => {
  assert.deepEqual(SC.resultStrip({ called: 80, forecast: 70, critic: 78.4 }), { off: 2, forecastMiss: 8, beatForecast: true, critic: 78 });
  assert.equal(SC.resultStrip({ called: 60, forecast: 70, critic: 78 }).beatForecast, false);
  assert.equal(SC.resultStrip({ called: 60, forecast: null, critic: 78 }).forecastMiss, null);
  assert.equal(SC.resultStrip({ called: null, forecast: 1, critic: 5 }), null);
});
test('gapSentence', () => {
  assert.equal(SC.gapSentence({ called: 80, forecast: 74, lo80: 62, hi80: 85 }), 'We forecast 74 (likely 62 to 85). You are 6 above.');
  assert.equal(SC.gapSentence({ called: 74, forecast: 74 }), 'We forecast 74. You matched it.');
  assert.equal(SC.gapSentence({ called: 70, forecast: null }), null);
});
test('isCallableShow agrees with the pilot predicate on every real show and several dates', () => {
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
  let disagree = 0;
  for (const today of ['2025-01-15', '2025-10-01', '2026-03-01', '2026-11-11']) for (const s of shows) if (SC.isCallableShow(s, today) !== P.isPilotTarget(s, today)) disagree++;
  assert.equal(disagree, 0);
});
test('buildSyncRows uses the last ledger row before opening, skips rows without forecast, flags live reviews', () => {
  const shows = [{ id: 'a', category: 'broadway', type: 'musical', status: 'previews', openingDate: '2026-12-01' }, { id: 'b', category: 'broadway', type: 'play', status: 'previews', openingDate: '2026-12-01' }];
  const ledger = [
    { showId: 'a', recordedAt: '2026-11-01', forecast: 70, lo80: 60, hi80: 80 },
    { showId: 'a', recordedAt: '2026-11-10', forecast: 74.4, lo80: 62, hi80: 85 },
    { showId: 'a', recordedAt: '2026-12-01', forecast: 99, lo80: 90, hi80: 100 }, // not strictly before opening
  ];
  const rows = buildSyncRows({ shows, ledgerRows: ledger, today: '2026-11-11', reviewCounts: { a: 2 } });
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { p_show_id: 'a', p_opening: '2026-12-01', p_forecast: 74, p_lo: 62, p_hi: 85, p_reviews_live: true, p_enabled: true });
});
// BRO-7348 owner-only board: allowed to read the ledger only while it stays admin-gated and per-request.
const OWNER_ONLY = new Set(['src/app/admin/forecasts/page.tsx', 'src/lib/admin-review-forecasts.ts']);
test('owner-only forecast board stays admin-gated and dynamic', () => {
  const page = fs.readFileSync(path.join(ROOT, 'src/app/admin/forecasts/page.tsx'), 'utf8');
  assert.ok(/isAdmin/.test(page) && /notFound\(/.test(page) && /dynamic\s*=\s*'force-dynamic'/.test(page) && !/generateStaticParams/.test(page));
});
test('LEAK GUARD: nothing under src/ or public/ reads the ledger or the sync loader', () => {
  const bad = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== 'node_modules') walk(p); } else if (/\.(tsx?|jsx?|mjs|json)$/.test(f.name) && /score-call-forecasts|review-forecast-pilot|lo80|hi80/.test(fs.readFileSync(p, 'utf8')) && !/CallTheScore|useScoreCall|score-call\.js/.test(f.name) && !OWNER_ONLY.has(path.relative(ROOT, p))) bad.push(p); } };
  walk(path.join(ROOT, 'src')); walk(path.join(ROOT, 'public'));
  assert.deepEqual(bad, []);
});

// Guess first, sign up second: pending pick store (real helpers, fake storage).
import { createRequire as _cr } from 'node:module';
{
  const sc = _cr(import.meta.url)('../../src/lib/score-call.js');
  const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } }; };
  const assertM = (await import('node:assert/strict')).default;
  const st = mem();
  assertM.equal(sc.setPendingCall('a', 72.6, st, 1000), null, 'integers only');
  assertM.equal(sc.setPendingCall('a', 73, st, 1000), 73);
  assertM.equal(sc.getPendingCall('a', st, 2000), 73);
  assertM.equal(sc.setPendingCall('a', 40, st, 3000), 40, 'one per show: new pick replaces old');
  assertM.equal(sc.getPendingCall('a', st, 4000), 40);
  assertM.equal(sc.setPendingCall('a', 101, st, 5000), null, 'out of range refused');
  assertM.equal(sc.getPendingCall('a', st, 3000 + 8 * 24 * 3600 * 1000), null, 'expires after 7 days');
  sc.setPendingCall('b', 55, st, 6000); sc.clearPendingCall('a', st, 6000);
  assertM.equal(sc.getPendingCall('a', st, 6000), null); assertM.equal(sc.getPendingCall('b', st, 6000), 55);
  assertM.equal(sc.getPendingCall('a', { getItem() { throw new Error('private'); } }, 1), null, 'storage errors are swallowed');
  assertM.equal(sc.getPendingCall('a', mem(), 1), null);
  console.log('pending-store tests ok');
}

function memStore(init = {}) { const m = { ...init }; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; }, _m: m }; }

test('pending pick: one per show, replaces, expires after 7 days, integers only, clears', () => {
  const s = memStore(); const t0 = 1_700_000_000_000;
  assert.equal(SC.setPendingCall('a', 83, s, t0), 83);
  assert.equal(SC.setPendingCall('a', 40, s, t0 + 1), 40);
  assert.equal(SC.getPendingCall('a', s, t0 + 2), 40);
  assert.equal(SC.setPendingCall('a', 83.5, s, t0), null);
  assert.equal(SC.setPendingCall('a', 101, s, t0), null);
  assert.equal(SC.setPendingCall('a', -1, s, t0), null);
  assert.equal(SC.getPendingCall('a', s, t0 + 7 * 86400000), 40);
  assert.equal(SC.getPendingCall('a', s, t0 + 7 * 86400000 + 5), null, 'expired');
  SC.clearPendingCall('a', s, t0 + 2);
  assert.equal(SC.getPendingCall('a', s, t0 + 2), null);
  assert.equal(Object.keys(s._m).length, 0, 'empty store removes the key');
});

test('pending pick ignores tampered storage (non-integer, strings, bad JSON)', () => {
  const now = 1_700_000_000_000;
  const bad = memStore({ bsc_pending_score_calls: JSON.stringify({ a: { score: 12.5, ts: now }, b: { score: 'x', ts: now }, c: { score: 50 }, d: 7 }) });
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(SC.getPendingCall(id, bad, now), null);
  assert.equal(SC.getPendingCall('a', memStore({ bsc_pending_score_calls: '{not json' }), now), null);
  assert.equal(SC.getPendingCall('a', null, now), null);
});

test('isCallableShow hides already-open, no-date, closed, cancelled and non-broadway shows', () => {
  const base = { category: 'broadway', type: 'musical', status: 'previews', openingDate: '2026-12-01' };
  assert.equal(SC.isCallableShow(base, '2026-11-11'), true);
  assert.equal(SC.isCallableShow({ ...base, openingDate: '2026-11-11' }, '2026-11-11'), false, 'opens today: closed');
  assert.equal(SC.isCallableShow({ ...base, status: 'open', openingDate: '2026-01-01' }, '2026-11-11'), false);
  assert.equal(SC.isCallableShow({ ...base, openingDate: undefined }, '2026-11-11'), false);
  assert.equal(SC.isCallableShow({ ...base, openingDate: 'TBD' }, '2026-11-11'), false);
  assert.equal(SC.isCallableShow({ ...base, status: 'closed' }, '2026-11-11'), false);
  assert.equal(SC.isCallableShow({ ...base, cancelledBeforeOpening: true }, '2026-11-11'), false);
  assert.equal(SC.isCallableShow({ ...base, category: 'west-end' }, '2026-11-11'), false);
});

test('useScoreCall drops a late get_my_score_calls answer for a previous user (store.inflight guard)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/hooks/useScoreCall.ts'), 'utf8');
  assert.match(src, /if \(store\.inflight !== ref\.p\) return;/);
});
test('a not_open answer keeps the waiting number (only ok, already_called, calls_closed clear it)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/show-page/CallTheScore.tsx'), 'utf8');
  assert.match(src, /r\.ok \|\| r\.reason === 'already_called' \|\| r\.reason === 'calls_closed'\) clearPendingCall/);
});

test('auto-save only takes a number picked within 30 minutes; older ones wait for a tap', () => {
  const s = memStore(); const t0 = 1_700_000_000_000;
  SC.setPendingCall('a', 77, s, t0);
  assert.equal(SC.getPendingCall('a', s, t0 + 29 * 60000, SC.AUTOSAVE_WINDOW_MS), 77);
  assert.equal(SC.getPendingCall('a', s, t0 + 31 * 60000, SC.AUTOSAVE_WINDOW_MS), null);
  assert.equal(SC.getPendingCall('a', s, t0 + 31 * 60000), 77, 'still pre-fills the slider');
  const src = fs.readFileSync(path.join(ROOT, 'src/components/show-page/CallTheScore.tsx'), 'utf8');
  assert.match(src, /getPendingCall\(show\.id, ls\(\), Date\.now\(\), AUTOSAVE_WINDOW_MS\)/);
});
