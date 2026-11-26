// BRO-7171 Stage 2: gap-recovery attempt ledger, retry caps (reused lifecycle
// policy), reconcile, kill switch, daily ceiling, strategy table, GUI check.
// Run: node --test scripts/lib/gap-recovery-ledger.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('./gap-recovery-ledger.js');
const T = require('./gap-strategy-table.js');
const { parseIoregConsole } = require('./gui-session.js');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const NOW = Date.now();
const KEY = 'some-show-2025/thestage--critic.json';
const closedOld = { id: 'old', status: 'closed', openingDate: '2019-01-10', closingDate: '2019-06-01' };
const openMature = { id: 'mature', status: 'open', openingDate: iso(NOW - 400 * DAY).slice(0, 10), category: 'broadway' };

const row = (o) => L.makeRow({ reviewKey: KEY, gapClass: 'PAYWALL_PAGE', strategy: 'ARCHIVE', ...o });

test('ledger file: append + read round-trip, torn lines skipped, unknown outcome refused', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gapledger-')), 'l.jsonl');
  L.appendRows([{ reviewKey: KEY, outcome: 'rejected', strategy: 'ARCHIVE', reason: 'not_longer' }], f);
  fs.appendFileSync(f, '{"torn":\n');
  L.appendRows([{ reviewKey: KEY, outcome: 'auth_failed', strategy: 'BROWSER_SESSION' }], f);
  const rows = L.readRows(f);
  assert.equal(rows.length, 2);
  assert.throws(() => L.makeRow({ reviewKey: KEY, outcome: 'bogus' }), /unknown outcome/);
});

test('retry cap: closedOld strict reason abandons after ONE evidence attempt (lifecycle policy, not a new one)', () => {
  const stamp = L.evidenceStamp({ show: closedOld, strategy: 'ARCHIVE', outcome: 'rejected', reason: 'show_not_mentioned', priorState: null });
  assert.equal(stamp.abandoned, true);
  const idx = L.indexRows([row({ outcome: 'rejected', reason: 'show_not_mentioned', ...stamp })]);
  const st = L.strategyState(idx, KEY, 'ARCHIVE');
  assert.equal(st.evidenceAttempts, 1);
  const e = L.strategyEligibility({ strategy: 'ARCHIVE', show: closedOld, review: {}, gapClass: 'PAYWALL_PAGE', state: st });
  assert.equal(e.ok, false);
  assert.match(e.reason, /abandoned|max_retries/);
});

test('retry cap: openMature lenient reason cools down, then caps at 5 evidence attempts', () => {
  const s1 = L.evidenceStamp({ show: openMature, strategy: 'REFETCH_FREE', outcome: 'no_evidence', reason: 'all_tiers_failed', priorState: null });
  assert.ok(s1.retryAfter && Date.parse(s1.retryAfter) > NOW, 'cooldown set from FETCH_COOLDOWN_MS');
  let idx = L.indexRows([L.makeRow({ reviewKey: KEY, strategy: 'REFETCH_FREE', outcome: 'no_evidence', reason: 'all_tiers_failed', ...s1 })]);
  let e = L.strategyEligibility({ strategy: 'REFETCH_FREE', show: openMature, review: {}, gapClass: 'BLOCKED', state: L.strategyState(idx, KEY, 'REFETCH_FREE') });
  assert.deepEqual(e, { ok: false, reason: 'cooldown' });
  const five = Array.from({ length: 5 }, (_, i) => L.makeRow({ ts: iso(NOW - (10 - i) * DAY), reviewKey: KEY, strategy: 'REFETCH_FREE', outcome: 'no_evidence', reason: 'all_tiers_failed', retryAfter: iso(NOW - DAY) }));
  idx = L.indexRows(five);
  e = L.strategyEligibility({ strategy: 'REFETCH_FREE', show: openMature, review: {}, gapClass: 'BLOCKED', state: L.strategyState(idx, KEY, 'REFETCH_FREE') });
  assert.deepEqual(e, { ok: false, reason: 'max_retries_reached' });
  // four past-cooldown attempts: still eligible
  idx = L.indexRows(five.slice(0, 4));
  e = L.strategyEligibility({ strategy: 'REFETCH_FREE', show: openMature, review: {}, gapClass: 'BLOCKED', state: L.strategyState(idx, KEY, 'REFETCH_FREE') });
  assert.equal(e.ok, true);
});

test('retry cap: non-evidence outcomes never count (auth, GUI, budget)', () => {
  const rows = ['auth_failed', 'browser_unavailable', 'non_evidence', 'pending_push'].flatMap((o) => Array.from({ length: 4 }, () => row({ outcome: o, strategy: 'BROWSER_SESSION' })));
  assert.deepEqual(L.evidenceStamp({ show: closedOld, strategy: 'BROWSER_SESSION', outcome: 'auth_failed', reason: 'x' }), {});
  const st = L.strategyState(L.indexRows(rows), KEY, 'BROWSER_SESSION');
  assert.equal(st.evidenceAttempts, 0);
  assert.equal(L.strategyEligibility({ strategy: 'BROWSER_SESSION', show: closedOld, review: {}, gapClass: 'PAYWALL_PAGE', state: st }).ok, true);
});

test('URL_REDISCOVER reuses the file serpRetryCount gate (no second counter)', () => {
  const st = L.strategyState(new Map(), KEY, 'URL_REDISCOVER');
  const wrong = L.strategyEligibility({ strategy: 'URL_REDISCOVER', show: closedOld, review: { serpRetryCount: 0 }, gapClass: 'URL_WRONG_PAGE', state: st });
  assert.equal(wrong.ok, false, 'closedOld wrong_content max is 0');
  const cool = L.strategyEligibility({ strategy: 'URL_REDISCOVER', show: openMature, review: { serpRetryAfter: iso(NOW + DAY) }, gapClass: 'NO_URL', state: st });
  assert.deepEqual({ ok: cool.ok, reason: cool.reason }, { ok: false, reason: 'cooldown' });
  const go = L.strategyEligibility({ strategy: 'URL_REDISCOVER', show: openMature, review: {}, gapClass: 'NO_URL', state: st });
  assert.equal(go.ok, true);
  assert.equal(L.serpGateReason('URL_DEAD'), 'wrong_content');
});

test('reconcile: a recovered review whose file is not complete is reopened once, and the reopen resets strategy counts', () => {
  const rows = [
    row({ ts: iso(NOW - 3 * DAY), outcome: 'rejected', reason: 'not_longer', abandoned: true }),
    row({ ts: iso(NOW - 2 * DAY), outcome: 'pending_push' }),
    row({ ts: iso(NOW - 2 * DAY + 1000), outcome: 'recovered', pushedBlob: 'abc' }),
    L.makeRow({ ts: iso(NOW - DAY), reviewKey: 'other/x.json', outcome: 'recovered', strategy: 'ARCHIVE' }),
  ];
  const files = { [KEY]: { contentTier: 'truncated' }, 'other/x.json': { contentTier: 'complete' } };
  const reopen = L.reconcileRecovered(rows, (k) => files[k] || null);
  assert.equal(reopen.length, 1);
  assert.equal(reopen[0].reviewKey, KEY);
  assert.equal(reopen[0].outcome, 'reopened');
  assert.equal(reopen[0].detail.tier, 'truncated');
  const after = [...rows, ...reopen];
  assert.equal(L.reconcileRecovered(after, (k) => files[k] || null).length, 0, 'idempotent');
  assert.equal(L.strategyState(L.indexRows(after), KEY, 'ARCHIVE').evidenceAttempts, 0, 'reopen resets counts');
  // unreadable file reopens too
  assert.equal(L.reconcileRecovered(rows.slice(0, 3), () => null)[0].reason, 'recovered_file_unreadable');
});

test('reconcile: order in the file does not matter (union merge appends out of order)', () => {
  const rows = [
    row({ ts: iso(NOW - DAY), outcome: 'recovered' }),
    row({ ts: iso(NOW - 5 * DAY), outcome: 'rejected', reason: 'garbage' }),
  ];
  assert.equal(L.reconcileRecovered(rows, () => ({ contentTier: 'excerpt' })).length, 1);
});

test('reconcile: a recovery whose honest tier is truncated stays closed while its text is on disk', () => {
  // The Stage pilot (BRO-7171 Stage 2b): stub -> truncated recoveries were reopened on
  // every reconcile only because the tier was not "complete", then re-fetched forever.
  const rows = [row({ ts: iso(NOW - DAY), outcome: 'recovered', bytesAfter: 3156 })];
  const kept = { contentTier: 'truncated', fullText: 'x'.repeat(3156) };
  assert.equal(L.reconcileRecovered(rows, () => kept).length, 0, 'recovered text still on disk: no reopen');
  assert.equal(L.reconcileRecovered(rows, () => ({ contentTier: 'truncated', fullText: 'x'.repeat(3100) })).length, 0, 'a small later trim is not a loss');
  const lost = L.reconcileRecovered(rows, () => ({ contentTier: 'stub', fullText: 'x'.repeat(200) }));
  assert.equal(lost.length, 1, 'text clobbered back to a stub: reopen');
  assert.equal(lost[0].reason, 'recovered_text_lost');
});

test('recovered row only from a landing: carries the pushed blob and the attempt info', () => {
  const r = L.recoveredRowFromLanding({ path: 'show-a/thestage--x.json', blob: 'deadbeef', commit: 'c0ffee' }, { strategy: 'ARCHIVE', gapClass: 'PAYWALL_PAGE', bytesBefore: 10, bytesAfter: 900, priorFullTextHash: 'h' });
  assert.equal(r.outcome, 'recovered');
  assert.equal(r.pushedBlob, 'deadbeef');
  assert.equal(r.reviewKey, 'show-a/thestage--x.json');
  assert.equal(r.bytesAfter, 900);
});

test('kill switch: env or state file stops the run', () => {
  assert.equal(L.killSwitchActive({ env: { GAP_RECOVERY_DISABLED: '1' }, stateFileExists: false }).active, true);
  assert.equal(L.killSwitchActive({ env: { GAP_RECOVERY_DISABLED: 'true' }, stateFileExists: false }).active, true);
  assert.equal(L.killSwitchActive({ env: {}, stateFileExists: true }).active, true);
  assert.equal(L.killSwitchActive({ env: { GAP_RECOVERY_DISABLED: '0' }, stateFileExists: false }).active, false);
});

test('daily ceiling: distinct reviews accepted today (ledger + this run), yesterday not counted', () => {
  const rows = [
    row({ ts: iso(NOW), outcome: 'pending_push' }),
    row({ ts: iso(NOW), outcome: 'recovered' }), // same review: counted once
    L.makeRow({ ts: iso(NOW), reviewKey: 'b/y.json', outcome: 'recovered', strategy: 'ARCHIVE' }),
    L.makeRow({ ts: iso(NOW - 2 * DAY), reviewKey: 'c/z.json', outcome: 'recovered', strategy: 'ARCHIVE' }),
  ];
  assert.equal(L.acceptedToday(rows, NOW), 2);
  assert.equal(L.ceilingReached({ rows, nowMs: NOW, ceiling: 3, acceptedThisRun: 0 }), false);
  assert.equal(L.ceilingReached({ rows, nowMs: NOW, ceiling: 3, acceptedThisRun: 1 }), true);
  assert.equal(L.dailyCeiling({ GAP_RECOVERY_DAILY_CEILING: '7' }), 7);
  assert.equal(L.dailyCeiling({}), L.DEFAULT_DAILY_CEILING);
  assert.equal(L.runCeiling({ GAP_RECOVERY_RUN_CEILING: '60' }), 60);
  assert.equal(L.runCeiling({}), null);
  // per-run cap: earlier rows today do not count
  assert.equal(L.ceilingReached({ rows: [], nowMs: NOW, ceiling: 3, acceptedThisRun: 2 }), false);
});

test('strategy table: per-class order, skips with reasons, disabled flag removes a strategy', () => {
  let s = T.selectStrategy({ gapClass: 'PAYWALL_PAGE', hasUrl: true, hasAdapter: true, runGates: { BROWSER_SESSION: { ok: false, reason: 'browser_unavailable' } } });
  assert.equal(s.strategy, 'ARCHIVE');
  assert.deepEqual(s.skipped, [{ strategy: 'BROWSER_SESSION', reason: 'browser_unavailable' }]);
  s = T.selectStrategy({ gapClass: 'PAYWALL_PAGE', hasUrl: true, hasAdapter: false });
  assert.equal(s.skipped[0].reason, 'no_adapter');
  // Stage 2 decision rule (pilot accepted 0/20 < 30%): both url-finding routes ship off.
  assert.equal(T.STRATEGY_FLAGS.URL_REDISCOVER.enabled, false);
  assert.equal(T.STRATEGY_FLAGS.AGG_LINK.enabled, false);
  // Owner challenge 2026-11-09: NO_URL goes to URL_FIND (free methods first) before the SERP-only route.
  s = T.selectStrategy({ gapClass: 'NO_URL', hasUrl: false, hasAdapter: false });
  assert.equal(s.strategy, 'URL_FIND');
  assert.deepEqual(s.skipped, []);
  const findOff = { ...T.STRATEGY_FLAGS, URL_FIND: { ...T.STRATEGY_FLAGS.URL_FIND, enabled: false } };
  s = T.selectStrategy({ gapClass: 'NO_URL', hasUrl: false, hasAdapter: false, flags: findOff });
  assert.equal(s.strategy, null);
  assert.deepEqual(s.skipped, [{ strategy: 'URL_FIND', reason: 'disabled' }, { strategy: 'AGG_LINK', reason: 'disabled' }, { strategy: 'URL_REDISCOVER', reason: 'disabled' }]);
  const on = { ...findOff, URL_REDISCOVER: { ...T.STRATEGY_FLAGS.URL_REDISCOVER, enabled: true } };
  s = T.selectStrategy({ gapClass: 'NO_URL', hasUrl: false, hasAdapter: false, flags: on });
  assert.equal(s.strategy, 'URL_REDISCOVER');
  assert.deepEqual(s.skipped, [{ strategy: 'URL_FIND', reason: 'disabled' }, { strategy: 'AGG_LINK', reason: 'disabled' }]);
  // a dead (often invented) url: Wayback of it first, then URL_FIND looks for the real one
  assert.equal(T.selectStrategy({ gapClass: 'URL_DEAD', hasUrl: true, hasAdapter: false, eligible: (st) => (st === 'ARCHIVE' ? { ok: false, reason: 'abandoned' } : { ok: true }) }).strategy, 'URL_FIND');
  s = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, eligible: (st) => (st === 'REFETCH_FREE' ? { ok: false, reason: 'cooldown' } : { ok: true }) });
  assert.equal(s.strategy, 'ARCHIVE');
  // Stage 3 pilots: ARCHIVE 0/20 on recent shows, 9/20 on historic -> historic only.
  // recent paywalled page: no Wayback, so the free refetch (saved cookies) and then the paid fetch
  s = T.selectStrategy({ gapClass: 'PAYWALL_PAGE', hasUrl: true, hasAdapter: false, recency: 'recent', showAgeDays: 10 });
  assert.equal(s.strategy, 'REFETCH_FREE');
  assert.deepEqual(s.skipped[1], { strategy: 'ARCHIVE', reason: 'show_too_new' });
  assert.equal(T.selectStrategy({ gapClass: 'PAYWALL_PAGE', hasUrl: true, hasAdapter: false, recency: 'recent', showAgeDays: 10, eligible: (st) => (st === 'REFETCH_FREE' ? { ok: false, reason: 'cooldown' } : { ok: true }) }).strategy, 'PAID_FETCH');
  assert.equal(T.selectStrategy({ gapClass: 'PAYWALL_PAGE', hasUrl: true, hasAdapter: false, recency: 'historic' }).strategy, 'ARCHIVE');
  assert.equal(T.selectStrategy({ gapClass: 'FALSE_TRUNCATION_SUSPECT', hasUrl: true, hasAdapter: true }).strategy, null);
  assert.equal(T.selectStrategy({ gapClass: 'GARBAGE_PAGE', hasUrl: true, hasAdapter: true, only: 'URL_REDISCOVER', flags: on }).strategy, 'URL_REDISCOVER');
  assert.equal(T.selectStrategy({ gapClass: 'GARBAGE_PAGE', hasUrl: true, hasAdapter: true, only: 'URL_REDISCOVER' }).strategy, null);
  // every open class the classifier emits has a table row
  const { GAP_CLASSES, CLOSED_CLASSES } = require('./text-gap-classify.js');
  for (const c of GAP_CLASSES) if (!CLOSED_CLASSES.includes(c)) assert.ok(Array.isArray(T.CLASS_STRATEGIES[c]), `no strategy row for ${c}`);
});

test('candidate order: recent before historic, newest show first, cheaper strategy first', () => {
  const c = [
    { reviewKey: 'a', recency: 'historic', showDate: '2024-01-01', strategy: 'ARCHIVE' },
    { reviewKey: 'b', recency: 'recent', showDate: '2025-01-01', strategy: 'URL_REDISCOVER' },
    { reviewKey: 'c', recency: 'recent', showDate: '2026-01-01', strategy: 'URL_REDISCOVER' },
    { reviewKey: 'd', recency: 'recent', showDate: '2025-01-01', strategy: 'ARCHIVE' },
  ].sort(T.compareCandidates).map((x) => x.reviewKey);
  assert.deepEqual(c, ['c', 'd', 'b', 'a']);
});

test('pendingPushInfo: an earlier run\'s unlanded acceptance can still get its recovered row', () => {
  const rows = [
    { ts: '2026-11-08T01:00:00Z', reviewKey: 'a/x.json', strategy: 'ARCHIVE', outcome: 'pending_push', gapClass: 'PAYWALL_PAGE', url: 'u', bytesAfter: 900, runId: 'r1' },
    { ts: '2026-11-08T01:00:00Z', reviewKey: 'b/y.json', strategy: 'ARCHIVE', outcome: 'pending_push', runId: 'r1' },
    { ts: '2026-11-08T02:00:00Z', reviewKey: 'b/y.json', strategy: 'ARCHIVE', outcome: 'recovered', runId: 'r1' },
  ];
  const m = L.pendingPushInfo(rows);
  assert.deepEqual([...m.keys()], ['a/x.json']);
  const row = L.recoveredRowFromLanding({ path: '/r/a/x.json', blob: 'abc' }, m.get('a/x.json'));
  assert.equal(row.outcome, 'recovered');
  assert.equal(row.strategy, 'ARCHIVE');
  assert.equal(row.bytesAfter, 900);
});

test('write-path refusals are non-evidence; gate verdicts are evidence; owned records are skipped', () => {
  for (const code of ['url_moved_during_fetch', 'write_refused', 'write_rolled_back', 'identity_check_unavailable']) assert.equal(L.outcomeForGateRefusal(code), 'non_evidence');
  for (const code of ['show_not_mentioned', 'not_longer', 'garbage', 'paywall']) assert.equal(L.outcomeForGateRefusal(code), 'rejected');
  assert.equal(L.ownedRecordReason({ manualContentTier: 'stub' }), 'manual_tier');
  assert.equal(L.ownedRecordReason({ _locked: true }), 'locked');
  assert.equal(L.ownedRecordReason({ wrongProduction: true }), 'excluded_record');
  assert.equal(L.ownedRecordReason({ contentTier: 'excerpt' }), null);
});

test('live preflight: no shows.json refuses the run; no cookie jar gates the browser only', () => {
  assert.match(T.liveEnvironmentGates({ showsJsonReadable: false, cookieJarExists: true }).fatal, /generic-title gate/);
  const noJar = T.liveEnvironmentGates({ showsJsonReadable: true, cookieJarExists: false });
  assert.equal(noJar.fatal, null);
  assert.equal(noJar.runGates.BROWSER_SESSION.reason, 'browser_unavailable:cookie_jar_missing');
  assert.deepEqual(T.liveEnvironmentGates({ showsJsonReadable: true, cookieJarExists: true }), { fatal: null, runGates: {} });
});

test('GUI check: a locked screen is usable (Stage 4); a missing console session is not', () => {
  // Stage 2 refused a locked screen, so the 01:30 nightly never ran one browser attempt.
  const locked = '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="tom","CGSSessionScreenIsLocked"=Yes})';
  const open = '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"kCGSSessionUserNameKey"="tom"})';
  const offConsole = '"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=No,"kCGSSessionUserNameKey"="tom","CGSSessionScreenIsLocked"=Yes})';
  assert.deepEqual(parseIoregConsole(locked, 'tom'), { available: true, reason: 'gui_ok_screen_locked' });
  assert.equal(parseIoregConsole(offConsole, 'tom').reason, 'session_not_on_console');
  assert.deepEqual(parseIoregConsole(open, 'tom'), { available: true, reason: 'gui_ok' });
  assert.equal(parseIoregConsole(open, 'someone').reason, 'user_not_on_console');
  assert.equal(parseIoregConsole('', 'tom').reason, 'no_console_session');
});

test('URL_WRONG_PAGE retries the stored url first when nothing contradicts it (Stage 4)', () => {
  // Stage 3 sent every URL_WRONG_PAGE row to URL_REDISCOVER (disabled), so 1,009
  // rows had no route although The Stage's stored urls extract fine in the browser.
  const now = Date.parse('2026-11-09T00:00:00Z');
  const show = { title: 'The Master Builder', previewsStartDate: '2026-09-01', openingDate: '2026-09-10', venue: 'Old Vic', category: 'west-end' };
  const stageUrl = 'https://www.thestage.co.uk/reviews/the-master-builder-review-old-vic-london';
  const ok = T.storedUrlWorthRetry({ url: stageUrl, show, nowMs: now });
  assert.equal(ok.ok, true);
  // subscriber outlet: browser first; free refetch is the fallback when the browser is gated
  assert.equal(T.selectStrategy({ gapClass: 'URL_WRONG_PAGE', hasUrl: true, hasAdapter: true, storedUrlOk: ok }).strategy, 'BROWSER_SESSION');
  assert.equal(T.selectStrategy({ gapClass: 'URL_WRONG_PAGE', hasUrl: true, hasAdapter: true, storedUrlOk: ok,
    runGates: { BROWSER_SESSION: { ok: false, reason: 'browser_unavailable:x' } } }).strategy, 'REFETCH_FREE');
  // free outlet: refetch first
  assert.equal(T.selectStrategy({ gapClass: 'URL_WRONG_PAGE', hasUrl: true, hasAdapter: false, storedUrlOk: ok }).strategy, 'REFETCH_FREE');
  assert.equal(T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false }).strategy, 'REFETCH_FREE');
  // deadline row pointing at unrelated news: rediscovery only (disabled -> none)
  const news = T.storedUrlWorthRetry({ url: 'https://deadline.com/2026/05/ben-affleck-artificial-intelligence-startup-1236123456/', show, nowMs: now });
  assert.deepEqual(news, { ok: false, reason: 'url_names_other_show' });
  const none = T.selectStrategy({ gapClass: 'URL_WRONG_PAGE', hasUrl: true, hasAdapter: true, storedUrlOk: news });
  // ... and URL_FIND (free) looks for the right url
  assert.equal(none.strategy, 'URL_FIND');
  assert.deepEqual(none.skipped.map((s) => s.reason), ['url_names_other_show', 'url_names_other_show', 'disabled']);
  // Globe Seagull row holds another production's url; the show has not started.
  const seagull = { title: 'The Seagull', previewsStartDate: '2027-01-15', venue: "Shakespeare's Globe", category: 'west-end' };
  assert.equal(T.storedUrlWorthRetry({ url: 'https://www.thestage.co.uk/reviews/the-seagull-review-barbican-london', show: seagull, nowMs: now }).reason, 'show_not_started');
  assert.equal(T.storedUrlWorthRetry({ url: stageUrl, show: null, nowMs: now }).reason, 'show_unknown');
  // other classes ignore the stored-url check
  assert.equal(T.selectStrategy({ gapClass: 'BLOCKED', hasUrl: true, hasAdapter: false, storedUrlOk: news }).strategy, 'REFETCH_FREE');
});

test('free refetch: only the collector cooldown blocks; abandoned / max retries do not (Stage 4)', () => {
  assert.deepEqual(T.collectorRefetchGate({ shouldRetry: false, reason: 'cooldown' }), { ok: false, reason: 'collector_cooldown' });
  assert.equal(T.collectorRefetchGate({ shouldRetry: false, reason: 'abandoned' }).ok, true);
  assert.equal(T.collectorRefetchGate({ shouldRetry: false, reason: 'max_retries_reached' }).ok, true);
  assert.equal(T.collectorRefetchGate({ shouldRetry: true, reason: 'not_gated' }).ok, true);
});

// BRO-7171 leftover: the driver checked the daily ceiling against a
// start-of-run snapshot plus its own count, so a second run's accepts (same
// ledger file) were invisible and two runs could each take the full ceiling.
test('daily ceiling is read fresh from the shared ledger before each attempt', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gapceil-')), 'l.jsonl');
  const snapshot = L.readRows(f); // run A starts: nothing accepted yet
  // run B (another process) accepts 3 reviews into the same file
  L.appendRows([1, 2, 3].map((n) => ({ reviewKey: `s/b${n}.json`, outcome: 'pending_push', runId: 'B' })), f);
  assert.equal(L.ceilingReached({ rows: snapshot, ceiling: 3, acceptedThisRun: 0 }), false, 'the old snapshot check misses run B');
  assert.equal(L.ceilingReachedNow({ file: f, ceiling: 3 }), true, 'fresh read sees run B');
  assert.equal(L.ceilingReachedNow({ file: f, ceiling: 4 }), false);
  // run mode is a per-run cap: other runs do not count
  assert.equal(L.ceilingReachedNow({ file: f, ceiling: 3, runMode: true, acceptedThisRun: 2 }), false);
  assert.equal(L.ceilingReachedNow({ file: f, ceiling: 3, runMode: true, acceptedThisRun: 3 }), true);
});

// BRO-7171 leftover: rows with the same ts had no order (Array.sort on ts only;
// a union merge appends the other side's rows after ours, so file order is not
// lifecycle order). A pending_push and its recovered row written in the same
// millisecond could index as [recovered, pending_push], leaving the review
// "pending" forever (pendingPushInfo) and invisible to reconcile.
test('indexRows: equal timestamps order by lifecycle, then per-process seq', () => {
  const ts = iso(NOW);
  const pending = row({ ts, outcome: 'pending_push', runId: 'r1' });
  const recovered = row({ ts, outcome: 'recovered', runId: 'r1' });
  const reopened = row({ ts, outcome: 'reopened' });
  // File order as a union merge can leave it: later lifecycle first.
  const list = L.indexRows([reopened, recovered, pending]).get(KEY);
  assert.deepEqual(list.map((r) => r.outcome), ['pending_push', 'recovered', 'reopened']);
  assert.equal(L.pendingPushInfo([recovered, pending]).size, 0, 'a landed review is not still pending');
  // Two attempt rows of one run in the same ms keep their write order via seq.
  const a = row({ ts, outcome: 'no_evidence', strategy: 'ARCHIVE', runId: 'r2' });
  const b = row({ ts, outcome: 'rejected', strategy: 'ARCHIVE', runId: 'r2' });
  assert.ok(b.seq > a.seq, 'makeRow stamps a monotonic seq');
  assert.deepEqual(L.indexRows([b, a]).get(KEY).map((r) => r.outcome), ['no_evidence', 'rejected']);
  // appendRows keeps a caller-supplied seq/ts (rows re-published verbatim).
  assert.equal(L.makeRow({ ...a }).seq, a.seq);
});

// BRO-7171 coordinator 2026-11-10: manual driver runs appended 368 rows to the
// machine state ledger that never reached the published data/audit mirror
// (only the nightly published). A live manual run against the state ledger
// must publish its own rows; the nightly's child run and dry runs must not.
test('manualRunShouldPublish: live manual run on the state ledger publishes; nightly child, dry run, repo ledger do not', () => {
  const state = L.stateLedgerPath();
  assert.equal(typeof L.manualRunShouldPublish, 'function');
  assert.equal(L.manualRunShouldPublish({ dryRun: false, ledgerPath: state, env: {} }), true);
  assert.equal(L.manualRunShouldPublish({ dryRun: true, ledgerPath: state, env: {} }), false);
  assert.equal(L.manualRunShouldPublish({ dryRun: false, ledgerPath: state, env: { GAP_RECOVERY_RUN_LOCK_PARENT: '123' } }), false);
  assert.equal(L.manualRunShouldPublish({ dryRun: false, ledgerPath: '/tmp/x.jsonl', env: {} }), false);
  assert.equal(L.manualRunShouldPublish({ dryRun: false, ledgerPath: state, env: { CI: 'true' } }), false);
  assert.equal(L.manualRunShouldPublish({ dryRun: false, ledgerPath: state, env: { GAP_RECOVERY_NO_PUBLISH: '1' } }), false);
});

test('URL_FIND_PROBE rows are logged but inert: no shadowing of pending_push/recovered, no strategy state (BRO-7171)', () => {
  const k = 'show-2018/telegraph--x.json';
  const t = (h) => new Date(NOW - h * 3600e3).toISOString();
  const probe = { reviewKey: k, strategy: 'URL_FIND_PROBE', outcome: 'non_evidence', reason: 'probe:none', ts: t(1) };
  const pend = [{ reviewKey: k, strategy: 'URL_FIND', outcome: 'pending_push', reason: 'accepted', url: 'https://x/r', ts: t(2) }, probe];
  assert.equal(L.pendingPushInfo(pend).has(k), true);
  const rec = [{ reviewKey: k, strategy: 'URL_FIND', outcome: 'recovered', reason: 'landed_on_origin_main', bytesAfter: 5000, ts: t(2) }, probe];
  assert.equal(L.reconcileRecovered(rec, () => ({ fullText: '' , contentTier: 'excerpt' })).length, 1);
  assert.equal(L.indexRows([probe]).size, 0);
});

test('reconcile: a recovery another writer replaced by re-fetching the same url is superseded, and that strategy is not retried there (BRO-7171 loop)', () => {
  // ilford-boy revstan 2026-11-12..13: the engine's raw-HTML text (2468, blog
  // footer + comments) landed, the collector's article-body fetch (1383) replaced
  // it, reconcile reopened it, the engine re-accepted the footer: every night.
  const URL = 'https://revstanstheatreblog.co.uk/2026/10/25/review-ilford-boy-donmar-warehouse/';
  const recTs = iso(NOW - DAY);
  const rows = [row({ ts: recTs, outcome: 'recovered', strategy: 'REFETCH_FREE', url: URL, bytesAfter: 2468 })];
  const collector = { url: URL, contentTier: 'truncated', fullText: 'x'.repeat(1383), fetchMethod: 'playwright', textFetchedAt: iso(NOW - DAY / 2) };
  const reopen = L.reconcileRecovered(rows, () => collector);
  assert.equal(reopen.length, 1);
  assert.equal(reopen[0].reason, L.SUPERSEDED_REASON);
  assert.equal(reopen[0].detail.supersededBy, 'playwright');
  const after = [...rows, ...reopen];
  const idx = L.indexRows(after);
  const st = L.strategyState(idx, KEY, 'REFETCH_FREE');
  assert.deepEqual(L.strategyEligibility({ strategy: 'REFETCH_FREE', show: openMature, review: collector, gapClass: 'TRUNCATED_OTHER', state: st }),
    { ok: false, reason: 'superseded_at_url' });
  // trailing-slash / tracking variants are the same article
  assert.equal(L.strategyEligibility({ strategy: 'REFETCH_FREE', show: openMature, review: { ...collector, url: URL.replace(/\/$/, '') + '?utm_source=x' }, gapClass: 'TRUNCATED_OTHER', state: st }).ok, false);
  // every raw-HTML strategy is blocked at the url (ARCHIVE parses the same page
  // with the same extractor); a subscriber browser session and a new url are not
  assert.equal(L.strategyEligibility({ strategy: 'ARCHIVE', show: openMature, review: collector, gapClass: 'TRUNCATED_OTHER', state: L.strategyState(idx, KEY, 'ARCHIVE') }).reason, 'superseded_at_url');
  assert.equal(L.strategyEligibility({ strategy: 'PAID_FETCH', show: openMature, review: collector, gapClass: 'TRUNCATED_OTHER', state: L.strategyState(idx, KEY, 'PAID_FETCH') }).reason, 'superseded_at_url');
  assert.equal(L.strategyEligibility({ strategy: 'BROWSER_SESSION', show: openMature, review: collector, gapClass: 'TRUNCATED_OTHER', state: L.strategyState(idx, KEY, 'BROWSER_SESSION') }).ok, true);
  // the block lifts once the newer text degrades to a stub
  assert.equal(L.strategyEligibility({ strategy: 'REFETCH_FREE', show: openMature, review: { ...collector, contentTier: 'stub', fullText: 'x'.repeat(200) }, gapClass: 'TRUNCATED_OTHER', state: st }).ok, true);
  assert.equal(L.strategyEligibility({ strategy: 'REFETCH_FREE', show: openMature, review: { ...collector, url: 'https://other.example/review' }, gapClass: 'TRUNCATED_OTHER', state: st }).ok, true);
  // the block survives a later reopen (a reopen resets counts, not this)
  const later = [...after, row({ ts: iso(NOW), outcome: 'reopened', strategy: 'ARCHIVE', reason: 'recovered_text_lost', url: URL })];
  assert.equal(L.strategyEligibility({ strategy: 'REFETCH_FREE', show: openMature, review: collector, gapClass: 'TRUNCATED_OTHER', state: L.strategyState(L.indexRows(later), KEY, 'REFETCH_FREE') }).ok, false);
});

test('reconcile: superseded only for a later, non-engine, same-url, substantive write; everything else stays a loss', () => {
  const URL = 'https://example.com/review';
  const recTs = iso(NOW - DAY);
  const rows = [row({ ts: recTs, outcome: 'recovered', strategy: 'REFETCH_FREE', url: URL, bytesAfter: 3000 })];
  const base = { url: URL, contentTier: 'truncated', fullText: 'x'.repeat(1500), fetchMethod: 'playwright', textFetchedAt: iso(NOW - DAY / 2) };
  const reason = (rev) => L.reconcileRecovered(rows, () => rev)[0].reason;
  assert.equal(reason(base), L.SUPERSEDED_REASON);
  assert.equal(reason({ ...base, textFetchedAt: iso(NOW - 2 * DAY) }), 'recovered_text_lost', 'written before the recovery landed');
  assert.equal(reason({ ...base, textFetchedAt: undefined }), 'recovered_text_lost', 'no fetch time');
  assert.equal(reason({ ...base, url: 'https://example.com/other' }), 'recovered_text_lost', 'a different url');
  assert.equal(reason({ ...base, fetchMethod: 'gap-recovery-refetch-free' }), 'recovered_text_lost', 'the engine itself');
  assert.equal(reason({ ...base, contentTier: 'stub', fullText: 'x'.repeat(200) }), 'recovered_text_lost', 'clobbered to a stub');
  assert.equal(reason({ ...base, contentTier: 'invalid' }), 'recovered_text_lost', 'clobbered to garbage');
  assert.equal(reason({ ...base, fullText: 'x'.repeat(300) }), 'recovered_text_lost', 'too short to stand');
  assert.equal(reason({ ...base, fullText: 'x'.repeat(1100) }), 'recovered_text_lost', 'under 40% of the recovered bytes: a teaser cut');
  assert.equal(reason({ ...base, url: 'not a url' }), 'recovered_text_lost', 'malformed url');
});

test('reconcile: a subscriber/archive/paid recovery replaced by a collector fetch stays a loss (alerts, not blocked)', () => {
  // NYT the-unbelievers 2026-11-09: BROWSER_SESSION 5389 chars, then a 2399-char
  // browserbase cut labelled complete; that must not be waved through.
  const URL = 'https://www.nytimes.com/2026/10/01/theater/the-unbelievers-review.html';
  const later = { url: URL, contentTier: 'complete', fullText: 'x'.repeat(2399), fetchMethod: 'browserbase', textFetchedAt: iso(NOW - DAY / 2) };
  for (const strategy of ['BROWSER_SESSION', 'ARCHIVE', 'PAID_FETCH']) {
    const rows = [row({ ts: iso(NOW - DAY), outcome: 'recovered', strategy, url: URL, bytesAfter: 5389 })];
    assert.equal(L.reconcileRecovered(rows, () => later)[0].reason, 'recovered_text_lost', strategy);
  }
});

// BRO-7171 2026-11-15: a review renamed mid-run (artshub--unknown.json ->
// artshub--dr-diana-carroll.json) threw ENOENT out of the driver loop and the
// whole nightly run stopped as status=failed.
test('isVanishedReviewFile: only this candidate\'s own missing file is skippable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-vanish-'));
  const gone = path.join(dir, 'artshub--unknown.json');
  let err;
  try { fs.readFileSync(gone, 'utf8'); } catch (e) { err = e; }
  assert.equal(L.isVanishedReviewFile(err, gone), true);
  // a different missing file (shows.json, registry) is a real fault
  assert.equal(L.isVanishedReviewFile(err, path.join(dir, 'other.json')), false);
  // not ENOENT
  assert.equal(L.isVanishedReviewFile(Object.assign(new Error('x'), { code: 'EACCES', path: gone }), gone), false);
  assert.equal(L.isVanishedReviewFile(new SyntaxError('bad json'), gone), false);
  // an ENOENT that does not name a path is not this file's
  assert.equal(L.isVanishedReviewFile(Object.assign(new Error('x'), { code: 'ENOENT' }), gone), false);
  // ENOENT but the file is back (rename raced back in): not vanished
  fs.writeFileSync(gone, '{}');
  assert.equal(L.isVanishedReviewFile(err, gone), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('driver: the per-review loop skips a vanished file instead of failing the run', () => {
  const src = fs.readFileSync(new URL('../gap-recovery-driver.js', import.meta.url), 'utf8');
  const loop = src.slice(src.indexOf('for (let i = 0; i < work.length; i++)'));
  const catchAt = loop.indexOf('L.isVanishedReviewFile(e, c.filePath)');
  assert.ok(catchAt > 0, 'driver loop must catch vanished review files');
  // the catch sits inside the loop, before the run-level flush('final')
  assert.ok(catchAt < loop.indexOf("flush('final')"), 'catch must be per-review, not run-level');
  assert.match(loop.slice(catchAt - 200, catchAt + 400), /reason: 'file_vanished'/);
});

// BRO-7171 2026-11-15: 12 reviews traded nightly between the engine (longer
// raw-HTML text) and the collector (shorter text) at the same url, each trade a
// recovered_text_lost reopen (jena-friedman thecomedybureau 4x).
test('strategyEligibility: two lost free-fetch recoveries at one url stop raw-HTML strategies there', () => {
  const U = 'https://thecomedybureau.com/show/jena/';
  const rec = (ts, strategy = 'REFETCH_FREE') => ({ reviewKey: KEY, strategy, outcome: 'recovered', reason: 'landed_on_origin_main', url: U, ts, bytesAfter: 2000 });
  const lost = (ts, strategy = 'REFETCH_FREE') => ({ reviewKey: KEY, strategy, outcome: 'reopened', reason: L.LOST_REASON, url: U, ts });
  const review = { url: U, fullText: 'Tickets $25.', contentTier: 'truncated' };
  const elig = (rows, strategy = 'REFETCH_FREE', r = review) =>
    L.strategyEligibility({ strategy, show: closedOld, review: r, gapClass: 'TRUNCATED_OTHER', state: L.strategyState(L.indexRows(rows), KEY, strategy) });
  const once = [rec('2026-11-09T07:00:00Z'), lost('2026-11-10T07:00:00Z')];
  assert.equal(elig(once).ok, true, 'one loss: try again');
  // one loss reconciled on two machines is still one loss
  const dup = [rec('2026-11-09T07:00:00Z'), { ...lost('2026-11-10T07:00:00Z'), detail: { recoveredAt: '2026-11-09T07:00:00Z' } }, { ...lost('2026-11-10T07:05:00Z'), detail: { recoveredAt: '2026-11-09T07:00:00Z' } }];
  assert.equal(elig(dup).ok, true, 'duplicate reconcile rows are one loss');
  const twice = [...once, rec('2026-11-10T07:30:00Z'), lost('2026-11-12T07:00:00Z')];
  assert.deepEqual(elig(twice), { ok: false, reason: 'lost_loop_at_url' });
  // a canonical variant of the url is the same url
  assert.equal(elig(twice, 'REFETCH_FREE', { ...review, url: U + '?utm_source=x' }).reason, 'lost_loop_at_url');
  // paid/archive/subscriber/rediscovery may still bring a clean text or a new url
  for (const s of ['PAID_FETCH', 'ARCHIVE', 'BROWSER_SESSION', 'URL_REDISCOVER']) assert.notEqual(elig(twice, s).reason, 'lost_loop_at_url', s);
  // a url change lifts it
  assert.equal(elig(twice, 'REFETCH_FREE', { ...review, url: 'https://example.com/real-review' }).ok, true);
  // losses of ARCHIVE/BROWSER_SESSION recoveries are real losses, not this trade
  const paidLost = [rec('2026-11-09T07:00:00Z', 'ARCHIVE'), lost('2026-11-10T07:00:00Z', 'ARCHIVE'), rec('2026-11-10T08:00:00Z', 'ARCHIVE'), lost('2026-11-12T07:00:00Z', 'ARCHIVE')];
  // (URL_FIND / URL_REDISCOVER losses are at a found url, not this trade either)
  assert.equal(elig(paidLost).ok, true);
  // a blocked historic gap is counted for the owner, not silently dropped
  const N = require('./gap-recovery-nightly.js');
  assert.equal(N.planCounts([{ recency: 'historic', strategy: null, skipped: [{ strategy: 'REFETCH_FREE', reason: 'lost_loop_at_url' }] }]).needsDecision, 1);
});

// BRO-7944: every refusal row carries url, bytesAfter, tier and the HTTP status or error.
test('refusalDiagnostics: fetch_error keeps the candidate url, an error and an HTTP status', async () => {
  const { createRequire } = await import('node:module');
  const L2 = createRequire(import.meta.url)('./gap-recovery-ledger');
  const d = L2.refusalDiagnostics({ c: { url: 'https://x.test/a', contentTier: 'stub' }, got: { ok: false, reason: 'fetch_error', error: 'Bright Data HTTP 429: slow down', url: undefined } });
  assert.equal(d.url, 'https://x.test/a');
  assert.equal(d.tier, 'stub');
  assert.equal(d.httpStatus, 429);
  assert.match(d.error, /429/);
  assert.equal(d.bytesAfter, 0);
  const row = L2.makeRow({ reviewKey: 'a/b.json', outcome: 'no_evidence', reason: 'fetch_error', ...d });
  assert.equal(row.url, 'https://x.test/a');
  assert.equal(row.httpStatus, 429);
  assert.equal(row.tier, 'stub');
});
test('refusalDiagnostics: gate refusal keeps bytesAfter and the prior tier from the decision', async () => {
  const { createRequire } = await import('node:module');
  const L2 = createRequire(import.meta.url)('./gap-recovery-ledger');
  const d = L2.refusalDiagnostics({ c: { url: 'https://x.test/a', contentTier: 'stub' }, got: { ok: true, url: 'https://x.test/b', rawText: 'abc' }, r: { code: 'too_short', reason: 'too short', newLen: 120, decision: { priorTier: 'excerpt' } } });
  assert.deepEqual([d.url, d.bytesAfter, d.tier, d.error], ['https://x.test/b', 120, 'excerpt', 'too short']);
});

test('recentNonEvidence: a fresh non_evidence row cools the strategy down; old, other-strategy and evidence rows do not (BRO-7944)', () => {
  const now = Date.parse('2026-11-21T08:00:00Z');
  const r = (o) => ({ strategy: 'REFETCH_FREE', outcome: 'non_evidence', ts: '2026-11-21T07:30:00Z', ...o });
  assert.equal(L.recentNonEvidence([r({})], 'REFETCH_FREE', now, {}), true);
  assert.equal(L.recentNonEvidence([r({ ts: '2026-11-21T06:00:00Z' })], 'REFETCH_FREE', now, {}), false);
  assert.equal(L.recentNonEvidence([r({})], 'ARCHIVE', now, {}), false);
  assert.equal(L.recentNonEvidence([r({ outcome: 'rejected' })], 'REFETCH_FREE', now, {}), false);
  assert.equal(L.recentNonEvidence([r({ ts: '2026-11-21T06:00:00Z' }), r({})], 'REFETCH_FREE', now, {}), true);
  assert.equal(L.recentNonEvidence([r({})], 'REFETCH_FREE', now, { GAP_NON_EVIDENCE_COOLDOWN_MIN: '10' }), false);
});

// 2026-11-21: check-outlet-fulltext-floors read the data/audit mirror while
// the Mac driver writes the machine state ledger, so it reported 13 gaps the
// batch had attempted as "never attempted". Readers resolve the ledger the
// way the driver does.
test('floors report reads the ledger the driver writes (ledgerPathDefault), not a hardcoded mirror path', () => {
  const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'check-outlet-fulltext-floors.js'), 'utf8');
  assert.match(src, /ledgerPathDefault\(\)/);
  assert.doesNotMatch(src, /path\.join\([^)]*'gap-recovery-attempts\.jsonl'\)/);
});

test('BRO-8276: a landing moved onto a renamed file closes the old key and records recovered on the new one', () => {
  const L2 = require('./gap-recovery-ledger.js');
  const info = { reviewKey: 's/thestage--unknown.json', gapClass: 'NEVER_FETCHED', strategy: 'BROWSER_SESSION', url: 'https://x/y', runId: 'r1', priorTier: 'excerpt', newTier: 'complete' };
  const pending = L2.makeRow({ ts: '2026-11-24T06:31:00.000Z', reviewKey: info.reviewKey, strategy: info.strategy, outcome: 'pending_push', reason: 'accepted' });
  const landed = { path: 's/thestage--dave-fargnoli.json', blob: 'abc', renamedFrom: 's/thestage--unknown.json' };
  const lookup = (k) => (k === info.reviewKey ? info : null);
  assert.equal(L2.landingInfo(landed, lookup), info, 'info found through renamedFrom');
  const rows = L2.landingRows(landed, info);
  assert.deepEqual(rows.map((r) => [r.reviewKey, r.outcome, r.reason]), [
    ['s/thestage--dave-fargnoli.json', 'recovered', 'landed_on_origin_main'],
    ['s/thestage--unknown.json', 'non_evidence', 'renamed_upstream'],
  ]);
  assert.equal(rows[0].detail.tierImproved, true);
  const idx = L2.indexRows([pending, ...rows]);
  assert.equal(L2.pendingPushInfo([pending, ...rows]).size, 0, 'the old pending_push row is closed');
  assert.equal(idx.get(info.reviewKey).slice(-1)[0].reason, 'renamed_upstream');
  // A plain landing is one recovered row, as before.
  assert.equal(L2.landingRows({ path: info.reviewKey }, info).length, 1);
});

test('BRO-8276: a pending text whose file was removed upstream is closed with gone_upstream', () => {
  const L2 = require('./gap-recovery-ledger.js');
  const pending = L2.makeRow({ reviewKey: 's/a.json', strategy: 'REFETCH_FREE', outcome: 'pending_push', reason: 'accepted' });
  const row = L2.goneUpstreamRow('s/a.json', { strategy: 'REFETCH_FREE', runId: 'r' }, 'removed upstream, no successor file');
  assert.equal(row.outcome, 'non_evidence');
  assert.equal(L2.pendingPushInfo([pending, row]).size, 0);
});

test('BRO-8276: reconcile reads a recovered key that was renamed afterwards from its stamped successor', () => {
  const L2 = require('./gap-recovery-ledger.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-rename-'));
  fs.mkdirSync(path.join(dir, 'show'));
  const text = 'Recovered review text. '.repeat(200);
  fs.writeFileSync(path.join(dir, 'show', 'x--named.json'), JSON.stringify({ fullText: text, contentTier: 'complete', _renamedFrom: { file: 'show/x--unknown.json' } }));
  fs.writeFileSync(path.join(dir, 'show', 'y--other.json'), JSON.stringify({ fullText: 'x' }));
  const rec = L2.makeRow({ reviewKey: 'show/x--unknown.json', strategy: 'ARCHIVE', outcome: 'recovered', reason: 'landed_on_origin_main', bytesAfter: text.length });
  assert.equal(L2.readReviewFollowingRename(dir, 'show/x--unknown.json').fullText, text);
  assert.deepEqual(L2.reconcileRecovered([rec], (k) => L2.readReviewFollowingRename(dir, k)), [], 'not reopened: the text moved, it was not lost');
  // Removed with no stamped successor: still reopened (unreadable).
  fs.unlinkSync(path.join(dir, 'show', 'x--named.json'));
  assert.equal(L2.reconcileRecovered([rec], (k) => L2.readReviewFollowingRename(dir, k)).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('BRO-8276: reconcile follows unstamped outlet moves using the recovered article and named critic', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-outlet-move-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'show'));
  const key = 'show/old-outlet--named-critic.json';
  const text = 'Recovered review text. '.repeat(200);
  const url = 'https://www.example.com/review/';
  const rec = L.makeRow({ reviewKey: key, strategy: 'ARCHIVE', outcome: 'recovered', url, bytesAfter: text.length });
  const successor = { outletId: 'new-outlet', criticName: 'Named Critic', url: 'http://example.com/review?utm_source=newsletter', fullText: text, contentTier: 'invalid', wrongProduction: true };
  const file = path.join(dir, 'show/new-outlet--named-critic.json');
  fs.writeFileSync(file, JSON.stringify(successor));
  // A shorter unknown-byline copy of the same article cannot shadow the named successor.
  fs.writeFileSync(path.join(dir, 'show/new-outlet--unknown.json'), JSON.stringify({ ...successor, criticName: 'Unknown', fullText: 'teaser' }));
  const read = (k, row) => L.readReviewFollowingRename(dir, k, row);
  assert.deepEqual(L.reconcileRecovered([rec], read), [], 'the recovered text survives the outlet move');
  assert.deepEqual(read(key, rec), successor, 'resolution preserves the stored eligibility flags');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), successor, 'read-only');
  fs.writeFileSync(file, JSON.stringify({ ...successor, fullText: 'teaser' }));
  assert.equal(L.reconcileRecovered([rec], read)[0].reason, 'recovered_text_lost', 'a real loss on the successor still reopens');
});

test('BRO-8276: unstamped unknown-byline moves require the same outlet and a unique article', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-unknown-move-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'show'));
  const key = 'show/outlet--unknown.json';
  const rec = { url: 'https://example.com/review' };
  const successor = { outletId: 'outlet', criticName: 'Named Critic', url: rec.url, fullText: 'recovered' };
  const file = path.join(dir, 'show/outlet--named-critic.json');
  fs.writeFileSync(path.join(dir, 'show/other--other-critic.json'), JSON.stringify({ ...successor, outletId: 'other', criticName: 'Other Critic' }));
  assert.equal(L.readReviewFollowingRename(dir, key, rec), null, 'unknown cannot cross outlets');
  fs.writeFileSync(file, JSON.stringify(successor));
  assert.deepEqual(L.readReviewFollowingRename(dir, key, rec), successor);
  fs.writeFileSync(path.join(dir, 'show/outlet--other-critic.json'), JSON.stringify({ ...successor, criticName: 'Other Critic' }));
  assert.equal(L.readReviewFollowingRename(dir, key, rec), null, 'two possible critics are ambiguous');
});

test('BRO-8276: unstamped successor lookup refuses unrelated or ambiguous records', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-move-refusal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'show'));
  fs.mkdirSync(path.join(dir, 'other-show'));
  const key = 'show/old-outlet--named-critic.json';
  const rec = { url: 'https://example.com/review' };
  const successor = { outletId: 'new-outlet', criticName: 'Named Critic', url: rec.url, fullText: 'recovered' };
  const file = path.join(dir, 'show/new-outlet--named-critic.json');
  const read = (row = rec) => L.readReviewFollowingRename(dir, key, row);
  fs.writeFileSync(path.join(dir, 'other-show/new-outlet--named-critic.json'), JSON.stringify(successor));
  assert.equal(read(), null, 'never cross shows');
  fs.writeFileSync(file, JSON.stringify({ ...successor, criticName: 'Other Critic' }));
  assert.equal(read(), null, 'stored byline conflicts with matching filename');
  for (const field of ['criticName', 'outletId']) {
    fs.writeFileSync(file, JSON.stringify({ ...successor, [field]: 42 }));
    assert.equal(read(), null, `malformed ${field} cannot abort reconciliation`);
  }
  fs.writeFileSync(file, JSON.stringify(successor));
  assert.equal(read(null), null, 'missing recovered row cannot establish identity');
  for (const url of [undefined, '', 'undefined', 'https://', 'not-a-url', 'https://example.com/re view', 42, 'https://example.com/other']) {
    assert.equal(read({ url }), null, `unusable or different recovered URL: ${url}`);
    fs.writeFileSync(file, JSON.stringify({ ...successor, url }));
    assert.equal(read(), null, `unusable or different successor URL: ${url}`);
    fs.writeFileSync(file, JSON.stringify(successor));
  }
  const second = path.join(dir, 'show/another-outlet--named-critic.json');
  fs.writeFileSync(second, JSON.stringify({ ...successor, outletId: 'another-outlet' }));
  assert.equal(read(), null, 'two unstamped matches are ambiguous');
  fs.writeFileSync(file, JSON.stringify({ ...successor, _renamedFrom: { file: key } }));
  fs.writeFileSync(second, JSON.stringify({ ...successor, url: 'https://example.com/other', _renamedFrom: { file: key } }));
  assert.equal(read(), null, 'ambiguous stamps cannot fall through to URL matching');
  fs.unlinkSync(second);
  assert.equal(read({}).fullText, successor.fullText, 'a unique stamp still works without a recovered URL');
  fs.writeFileSync(path.join(dir, key), JSON.stringify({ fullText: 'direct' }));
  assert.equal(read().fullText, 'direct', 'the existing path wins');
  fs.writeFileSync(path.join(dir, key), '{broken');
  assert.equal(read(), null, 'a corrupt existing file still reopens');
});
