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
  s = T.selectStrategy({ gapClass: 'NO_URL', hasUrl: false, hasAdapter: false });
  assert.equal(s.strategy, null);
  assert.deepEqual(s.skipped, [{ strategy: 'AGG_LINK', reason: 'disabled' }, { strategy: 'URL_REDISCOVER', reason: 'disabled' }]);
  const on = { ...T.STRATEGY_FLAGS, URL_REDISCOVER: { ...T.STRATEGY_FLAGS.URL_REDISCOVER, enabled: true } };
  s = T.selectStrategy({ gapClass: 'NO_URL', hasUrl: false, hasAdapter: false, flags: on });
  assert.equal(s.strategy, 'URL_REDISCOVER');
  assert.deepEqual(s.skipped, [{ strategy: 'AGG_LINK', reason: 'disabled' }]);
  s = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, eligible: (st) => (st === 'REFETCH_FREE' ? { ok: false, reason: 'cooldown' } : { ok: true }) });
  assert.equal(s.strategy, 'ARCHIVE');
  // Stage 3 pilots: ARCHIVE 0/20 on recent shows, 9/20 on historic -> historic only.
  s = T.selectStrategy({ gapClass: 'PAYWALL_PAGE', hasUrl: true, hasAdapter: false, recency: 'recent' });
  assert.equal(s.strategy, null);
  assert.deepEqual(s.skipped[1], { strategy: 'ARCHIVE', reason: 'disabled_recent' });
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
  for (const code of ['url_moved_during_fetch', 'write_refused', 'write_rolled_back']) assert.equal(L.outcomeForGateRefusal(code), 'non_evidence');
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
  assert.equal(none.strategy, null);
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
