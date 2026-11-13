import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SC = require('../../src/lib/score-call.js');
const P = require('../../scripts/lib/review-forecast-pilot.js');
const { buildSyncRows, nyToday, clearTargets } = require('../../scripts/lib/score-call-forecasts.js');
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
test('gapSentence: owner wording, inside/outside the likely range (BRO-7430)', () => {
  const R = { lo50: 63, hi50: 77 };
  assert.equal(SC.gapSentence({ called: 59, forecast: 70, ...R }), 'Your prediction is 11 points below our forecast, and outside our likely range.');
  assert.equal(SC.gapSentence({ called: 81, forecast: 70, ...R }), 'Your prediction is 11 points above our forecast, and outside our likely range.');
  assert.equal(SC.gapSentence({ called: 66, forecast: 70, ...R }), 'Your prediction is 4 points below our forecast, inside our likely range.');
  assert.equal(SC.gapSentence({ called: 63, forecast: 70, ...R }), 'Your prediction is 7 points below our forecast, inside our likely range.', 'edge is inside');
  assert.equal(SC.gapSentence({ called: 77, forecast: 70, ...R }), 'Your prediction is 7 points above our forecast, inside our likely range.');
  assert.equal(SC.gapSentence({ called: 78, forecast: 70, ...R }), 'Your prediction is 8 points above our forecast, and outside our likely range.');
  assert.equal(SC.gapSentence({ called: 70, forecast: 70, ...R }), 'Your prediction matches our forecast.');
  assert.equal(SC.gapSentence({ called: 69, forecast: 70, ...R }), 'Your prediction is 1 point below our forecast, inside our likely range.', 'singular');
  assert.equal(SC.gapSentence({ called: 73, forecast: 74 }), 'Your prediction is 1 point below our forecast.', 'no range: no range clause');
  assert.equal(SC.gapSentence({ called: 73, forecast: 74, lo50: null, hi50: 80 }), 'Your prediction is 1 point below our forecast.');
  assert.equal(SC.gapSentence({ called: 70, forecast: null, ...R }), null);
  assert.equal(SC.gapSentence({ called: 70, forecast: undefined }), null);
});

test('readersSentence: every branch (BRO-7430)', () => {
  const f = (o) => SC.readersSentence({ forecast: 70, readersAvg: 64, readersN: 12, called: 59, ...o });
  assert.equal(f({}), 'You are 5 points below other readers and 11 below our forecast.');
  assert.equal(f({ called: 75, readersAvg: 70, forecast: 64 }), 'You are 5 points above other readers and 11 above our forecast.');
  assert.equal(f({ called: 64 }), 'You are level with other readers and 6 below our forecast.');
  assert.equal(f({ called: 70 }), 'You are 6 points above other readers and level with our forecast.');
  assert.equal(f({ called: 70, readersAvg: 70 }), 'You are level with other readers and our forecast.');
  assert.equal(f({ readersN: 1, called: 57 }), 'You are 7 points below the one other reader and 13 below our forecast.');
  assert.equal(f({ readersN: 1, called: 57, readersAvg: 70 }), 'You are 13 points below the one other reader and 13 below our forecast.');
  assert.equal(f({ readersN: 1, called: 65, readersAvg: 64, forecast: 66 }), 'You are 1 point above the one other reader and 1 below our forecast.');
  assert.equal(f({ readersN: 1, called: 64 }), 'You are level with the one other reader and 6 below our forecast.');
  assert.equal(f({ forecast: null }), 'You are 5 points below other readers.');
  assert.equal(f({ forecast: null, called: 64 }), 'You are level with other readers.');
  assert.equal(f({ forecast: null, readersN: 1, called: 70 }), 'You are 6 points above the one other reader.');
  assert.equal(f({ readersN: 0 }), null);
  assert.equal(f({ readersAvg: null }), null);
});

test('captions, small print, strip footer, first-reader line (BRO-7430)', () => {
  assert.deepEqual(SC.rangeCaption({ lo50: 63, hi50: 77 }), { word: 'likely', nums: '63 to 77' });
  assert.equal(SC.rangeCaption({ lo50: null, hi50: 77 }), null);
  assert.equal(SC.rangeCaption({}), null);
  assert.equal(SC.readersCaption(12), 'average of 12');
  assert.equal(SC.readersCaption(2), 'average of 2');
  assert.equal(SC.readersCaption(1), '1 other reader');
  assert.equal(SC.readersCaption(0), null);
  assert.equal(SC.readersCaption(null), null);
  const d = 'December 6, 2026';
  assert.equal(SC.smallPrint({ hasForecast: true, hasRange: true, hasReaders: false, dateText: d }), 'The Critic Score lands in our likely range about half the time. Reviews come out after opening night on December 6, 2026. Come back to see who was closer.');
  assert.equal(SC.smallPrint({ hasForecast: true, hasRange: true, hasReaders: true, dateText: d }), 'The Critic Score lands in our likely range about half the time. Reviews come out after opening night on December 6, 2026. Come back to see who was closest.');
  assert.equal(SC.smallPrint({ hasForecast: true, hasRange: false, hasReaders: true, dateText: '' }), 'Reviews come out after opening night. Come back to see who was closest.', 'no range: no first sentence; no date: no date clause');
  assert.equal(SC.smallPrint({ hasForecast: false, hasRange: false, hasReaders: true, dateText: d }), 'Reviews come out after opening night on December 6, 2026. Come back to see who was closer.');
  assert.equal(SC.smallPrint({ hasForecast: false, hasRange: false, hasReaders: false, dateText: d }), 'Reviews come out after opening night on December 6, 2026. Come back to see how close your prediction was.');
  assert.equal(SC.readersMissSentence(64, 66.4), 'Readers were 2 points off on average.');
  assert.equal(SC.readersMissSentence(65, 66), 'Readers were 1 point off on average.');
  assert.equal(SC.readersMissSentence(66, 66), 'Readers were 0 points off on average.');
  assert.equal(SC.readersMissSentence(null, 66), null);
  assert.equal(SC.FIRST_READER_LINE, "You're the first reader to predict this show.");
  const all = [SC.FIRST_READER_LINE, SC.smallPrint({ hasForecast: true, hasRange: true, hasReaders: true, dateText: d }), SC.readersSentence({ called: 1, forecast: 9, readersAvg: 5, readersN: 3 }), SC.gapSentence({ called: 1, forecast: 9, lo50: 3, hi50: 12 })].join(' ');
  assert.doesNotMatch(all, /[\u2014\u2013]/, 'no em or en dashes in copy');
  assert.doesNotMatch(all, /between \d+ and \d+/, 'the 80% sentence is gone');
});

test('resultSentence and forecastMissSentence', () => {
  const r = SC.resultStrip({ called: 59, forecast: 70, critic: 61 });
  assert.equal(SC.resultSentence({ r }), 'You were 2 points off, and closer than our forecast.');
  assert.equal(SC.forecastMissSentence(r), 'Our forecast was 9 points off.');
  const exact = SC.resultStrip({ called: 61, forecast: null, critic: 61 });
  assert.equal(SC.resultSentence({ r: exact }), 'You got it exactly right.');
  assert.equal(SC.forecastMissSentence(exact), null);
  const tie = SC.resultStrip({ called: 60, forecast: 66, critic: 63 });
  assert.equal(SC.resultSentence({ r: tie }), 'You were 3 points off, the same as our forecast.');
  assert.equal(SC.forecastMissSentence(tie), null);
  const worse = SC.resultStrip({ called: 50, forecast: 62, critic: 63 });
  assert.equal(SC.resultSentence({ r: worse }), 'You were 13 points off.');
  assert.equal(SC.forecastMissSentence(worse), 'Our forecast was 1 point off.');
  const bothExact = SC.resultStrip({ called: 63, forecast: 63, critic: 63 });
  assert.equal(SC.resultSentence({ r: bothExact }), 'You got it exactly right.');
  assert.equal(SC.forecastMissSentence(bothExact), 'Our forecast was exactly right.');
  assert.equal(SC.gapSentence({ called: 60, forecast: 66, lo80: null, hi80: 80 }), 'Your prediction is 6 points below our forecast.');
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

test('nyToday uses the New York calendar day (BRO-7392)', () => {
  assert.equal(nyToday(new Date('2026-11-12T03:00:00Z')), '2026-11-11'); // 10pm EST: UTC already tomorrow
  assert.equal(nyToday(new Date('2026-11-12T05:30:00Z')), '2026-11-12'); // past midnight EST
  assert.equal(nyToday(new Date('2026-07-12T03:30:00Z')), '2026-07-11'); // EDT
  assert.equal(nyToday(new Date('2026-07-12T04:30:00Z')), '2026-07-12');
});

test('failed fetch is its own state, and the sync script clears reviews_live (BRO-7392)', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'src/hooks/useScoreCall.ts'), 'utf8');
  assert.match(hook, /const \{ data, error \} = await supabaseRestRpc<ScoreCall\[\]>\('get_my_score_calls'\)/);
  assert.match(hook, /loadError: true/);
  assert.match(hook, /retry/);
  const sync = fs.readFileSync(new URL('../../scripts/sync-score-call-forecasts.mjs', import.meta.url), 'utf8');
  assert.match(sync, /clear_score_call_reviews_live/);
  assert.match(sync, /const today = nyToday\(\)/);
  const mig = fs.readFileSync(new URL('../../supabase/migrations/20261112_score_call_clear_live.sql', import.meta.url), 'utf8');
  assert.match(mig, /REVOKE ALL ON FUNCTION public\.clear_score_call_reviews_live\(TEXT\) FROM PUBLIC, anon, authenticated/);
  assert.match(mig, /now\(\) >= cur\.closes_at/);
});

test('clearTargets selects only rows with no live reviews', () => {
  const rows = [
    { p_show_id: 'a', p_reviews_live: false },
    { p_show_id: 'b', p_reviews_live: true },
    { p_show_id: 'c', p_reviews_live: false },
  ];
  assert.deepEqual(clearTargets(rows), ['a', 'c']);
  assert.deepEqual(clearTargets([]), []);
});

test('a successful lock resets loadError in the hook store', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/hooks/useScoreCall.ts'), 'utf8');
  assert.match(src, /\[showId\]: call \}, loaded: true, loadError: false/);
});

test('mergeCalls: calls held this session win over a read that may predate them', () => {
  const fetched = { a: { called_score: 50 } };
  const held = { b: { called_score: 70 }, a: { called_score: 55 } };
  assert.deepEqual(SC.mergeCalls(fetched, held), { a: { called_score: 55 }, b: { called_score: 70 } });
  assert.deepEqual(SC.mergeCalls(fetched, {}), fetched);
  assert.deepEqual(SC.mergeCalls(null, held), held);
  assert.deepEqual(SC.mergeCalls(undefined, undefined), {});
});

test('hook: load keeps held calls on success and on failure, and lock ignores a stale user', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/hooks/useScoreCall.ts'), 'utf8');
  assert.match(src, /mergeCalls\(calls, held\)/);
  assert.match(src, /calls: held, loaded: true, loadError: true/);
  assert.match(src, /const stale = !!userId && store\.userId !== userId;/);
  assert.match(src, /if \(stale\) return \{ ok: true, call \};/);
});

test('buildSyncRows passes the true 50% band when the ledger has one, omitted (server derives) when it does not (BRO-7430)', () => {
  const shows = [{ id: 'a', openingDate: '2026-12-06', category: 'broadway', type: 'play', status: 'previews' }];
  const mk = (extra) => [{ showId: 'a', openingDate: '2026-12-06', recordedAt: '2026-11-01', forecast: 70, lo80: 56, hi80: 82, ...extra }];
  const withTrue = buildSyncRows({ shows, ledgerRows: mk({ lo50: 63, hi50: 77 }), today: '2026-11-13' });
  assert.equal(withTrue.length, 1);
  assert.equal(withTrue[0].p_lo50, 63); assert.equal(withTrue[0].p_hi50, 77);
  const old = buildSyncRows({ shows, ledgerRows: mk({}), today: '2026-11-13' });
  assert.equal('p_lo50' in old[0], false, 'keys omitted so a pre-migration loader still matches the old function');
});

test('fitForecaster returns lo50/hi50 inside the 80% band (BRO-7430)', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ season: 2000 + (i % 10), mu: 70, y: 60 + ((i * 7) % 31), x: Object.fromEntries(require('../../scripts/lib/review-forecast.js').FEATURE_NAMES.map((k) => [k, 0])) }));
  const m = P.fitForecaster(rows);
  const p = m.predict({ mu: 70, x: rows[0].x });
  assert.ok(p.lo80 <= p.lo50 && p.lo50 <= p.forecast && p.forecast <= p.hi50 && p.hi50 <= p.hi80, JSON.stringify(p));
  assert.ok(p.hi50 - p.lo50 < p.hi80 - p.lo80, '50% band is narrower');
});

test('20261113 migration: grants restated, readers RPC locked to the caller, derivation in one place (BRO-7430)', () => {
  const mig = fs.readFileSync(new URL('../../supabase/migrations/20261113_score_calls_range50_readers.sql', import.meta.url), 'utf8');
  assert.match(mig, /REVOKE ALL ON FUNCTION public\.lock_score_call\(TEXT, INTEGER\), public\.get_my_score_calls\(\), public\.get_score_call_readers\(\),\s+public\.sync_score_call_show\(TEXT, DATE, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN, INTEGER, INTEGER\)\s+FROM PUBLIC, anon, authenticated/);
  assert.match(mig, /GRANT EXECUTE ON FUNCTION public\.lock_score_call\(TEXT, INTEGER\), public\.get_my_score_calls\(\), public\.get_score_call_readers\(\) TO authenticated/);
  assert.match(mig, /GRANT EXECUTE ON FUNCTION public\.sync_score_call_show\([^)]*\) TO service_role/);
  assert.doesNotMatch(mig, /TO (anon|PUBLIC)\b/);
  const readers = mig.slice(mig.indexOf('CREATE FUNCTION public.get_score_call_readers'), mig.indexOf('CREATE FUNCTION public.sync_score_call_show'));
  assert.match(readers, /SECURITY DEFINER/);
  assert.match(readers, /me\.user_id = auth\.uid\(\)/);
  assert.match(readers, /o\.user_id <> me\.user_id/);
  assert.match(readers, /GROUP BY o\.show_id/);
  assert.doesNotMatch(readers, /o\.user_id,|SELECT o\.user_id|o\.called_score,/, 'never one row per reader');
  assert.match(mig, /p_lo50 INTEGER DEFAULT NULL, p_hi50 INTEGER DEFAULT NULL/, 'an older loader still works');
  assert.match(mig, /BEGIN;[\s\S]*COMMIT;/);
  assert.equal((mig.match(/0\.53/g) || []).length >= 2, true);
  assert.equal(fs.readFileSync(new URL('../../supabase/migrations/20261111_score_calls.sql', import.meta.url), 'utf8').includes('lo50'), false, 'applied migration untouched');
});

test('readers fetch: only when locked, a failed or missing RPC is "no readers", cache cleared on lock (BRO-7430)', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'src/hooks/useScoreCall.ts'), 'utf8');
  assert.match(hook, /'get_score_call_readers'/);
  assert.match(hook, /if \(!userId \|\| !locked\) return;/);
  assert.match(hook, /readersCache = null; \/\/ a fresh lock/);
  const comp = fs.readFileSync(path.join(ROOT, 'src/components/show-page/CallTheScore.tsx'), 'utf8');
  assert.match(comp, /useScoreCallReaders\(show\.id, true\)/);
  assert.match(comp, /ready && !failed && !readers/, 'a failed readers fetch never claims first reader');
  assert.match(hook, /return null; \}/);
  assert.doesNotMatch(comp, /lo80|hi80/, 'the 80% band never reaches the reader');
});
