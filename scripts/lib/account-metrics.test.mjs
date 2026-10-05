// Tests for scripts/lib/account-metrics.js (BRO-4615). Requires the real module.
// Run: node --test scripts/lib/account-metrics.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const m = require('./account-metrics.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const NOW = Date.parse('2026-10-08T12:00:00Z'); // a Thursday
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();

test('slimUsers drops CI test accounts and never keeps an email', () => {
  const out = m.slimUsers([
    { id: 'a', email: 'person@example.com', created_at: iso(1), last_sign_in_at: iso(0), app_metadata: { provider: 'google' } },
    { id: 't', email: `ugc-roundtrip+x-1${m.TEST_EMAIL_SUFFIX}`, created_at: iso(0), app_metadata: { provider: 'email' } },
    { id: 'b', email: null, created_at: iso(3), app_metadata: { provider: 'apple' } },
  ]);
  assert.deepEqual(out.map((u) => u.id), ['a', 'b']);
  assert.ok(!JSON.stringify(out).includes('@'), 'no email in the result');
  assert.equal(out[1].provider, 'apple');
});

test('summarizeAccounts counts totals, new per day/week and accounts that saved something', () => {
  const users = m.slimUsers([
    { id: 'a', created_at: iso(0), last_sign_in_at: iso(0), app_metadata: { provider: 'google' } },
    { id: 'b', created_at: iso(2), last_sign_in_at: iso(10), app_metadata: { provider: 'google' } },
    { id: 'c', created_at: iso(20), app_metadata: { provider: 'apple' } },
  ]);
  const s = m.summarizeAccounts(users, {
    ratings: [{ user_id: 'a' }, { user_id: 'a' }, { user_id: 'ghost-test-user' }],
    watchlist: [{ user_id: 'b' }],
    lists: [],
  }, NOW);
  assert.equal(s.total, 3);
  assert.equal(s.newToday, 1);
  assert.equal(s.newLast7, 2);
  assert.equal(s.newLast30, 3);
  assert.equal(s.signedInLast7, 1);
  assert.deepEqual(s.providers, { google: 2, apple: 1 });
  assert.equal(s.ratings, 2, "a removed test account's rows are not counted");
  assert.equal(s.withRating, 1);
  assert.equal(s.withWatchlist, 1);
  assert.equal(s.withAnything, 2);
  assert.equal(s.daily.length, 60);
  assert.equal(s.daily.at(-1).date, '2026-10-08');
  assert.equal(s.daily.at(-1).newAccounts, 1);
  assert.equal(s.weeks.length, 12);
  assert.equal(s.weeks.at(-1).week, '2026-10-05');
  assert.equal(s.weeks.at(-1).newAccounts, 2, 'Mon 10-05 .. Thu 10-08: a (today) + b (Tue)');
  assert.equal(s.weeks.at(-1).partial, true);
});

test('summarizeFunnel splits phones from computers and keeps per-source rows', () => {
  const f = m.summarizeFunnel([
    { src: 'show_bookmark', dev: 'Mobile', shown: 5, started: 0, completed: 0, acted: 0 },
    { src: 'show_rating_save', dev: 'Desktop', shown: 2, started: 2, completed: 2, acted: 2 },
    { src: 'show_want_to_see', dev: 'Desktop', shown: 3, started: 1, completed: 0, acted: 0 },
    { src: 'header', dev: null, shown: 0, started: 1, completed: 1, acted: 0 },
  ]);
  assert.deepEqual(f.totals.mobile, { shown: 5, started: 0, completed: 0, acted: 0 });
  assert.deepEqual(f.totals.desktop, { shown: 5, started: 3, completed: 2, acted: 2 });
  assert.equal(f.totals.other.completed, 1, 'iOS app rows (no $device_type) are kept apart');
  assert.equal(f.totals.all.shown, 10);
  assert.equal(f.sources[0].label, 'Bookmark icon on a show');
});

test('evaluateAlerts: sign-ins that start but never finish fire the sign-in alert', () => {
  const stalled = m.evaluateAlerts({ started: 4, started_devices: 3, completed: 0 });
  assert.equal(stalled.find((a) => a.key === m.ALERT_KEYS.signInStalled).firing, true);

  const fine = m.evaluateAlerts({ started: 4, started_devices: 3, completed: 1 });
  assert.equal(fine.find((a) => a.key === m.ALERT_KEYS.signInStalled).firing, false);

  const oneRetrier = m.evaluateAlerts({ started: 5, started_devices: 1, completed: 0 });
  assert.equal(oneRetrier.find((a) => a.key === m.ALERT_KEYS.signInStalled).firing, false, 'one person retrying is not an outage');

  assert.deepEqual(m.evaluateAlerts(null), [], 'a failed PostHog query is not a broken sign-in');
});

test('evaluateAlerts: save failures and error spikes need several devices', () => {
  const get = (h, k) => m.evaluateAlerts(h).find((a) => a.key === k).firing;
  assert.equal(get({ save_failed: 3, save_failed_devices: 2 }, m.ALERT_KEYS.saveFailures), true);
  assert.equal(get({ save_failed: 9, save_failed_devices: 1 }, m.ALERT_KEYS.saveFailures), false);
  assert.equal(get({ errors: 10, error_devices: 3 }, m.ALERT_KEYS.errorSpike), true);
  assert.equal(get({ errors: 9, error_devices: 9 }, m.ALERT_KEYS.errorSpike), false);
});

test('health query leaves out the quiet error codes the site already treats as non-failures', () => {
  const q = m.buildQueries().health;
  for (const c of ['network', 'no_session', '23505', 'PGRST116']) assert.ok(q.includes(`'${c}'`), c);
  assert.ok(q.includes('INTERVAL 24 HOUR'));
});

test('buildDashboardData merges signed-in users into the daily series and lists failed queries', () => {
  const accounts = m.summarizeAccounts([], { ratings: [], watchlist: [], lists: [] }, NOW);
  const d = m.buildDashboardData({
    now: NOW,
    accounts,
    ph: {
      active: [{ dau: 1, wau: 2, mau: 3 }],
      daily: [{ day: '2026-10-08', signed_in_users: 2 }],
      actions: [{ event: 'rating_submitted', last7: 2, last30: 2, users30: 2 }],
      funnel: null,
      health: [{}],
    },
  });
  assert.deepEqual(d.active, { dau: 1, wau: 2, mau: 3 });
  assert.equal(d.daily.at(-1).signedInUsers, 2);
  assert.equal(d.actions[0].label, 'Rated a show');
  assert.equal(d.funnel, null);
  assert.deepEqual(d.failed, ['funnel']);
  assert.equal(d.accounts.daily, undefined, 'daily lives once, at the top level');
});

test('weeklySummaryLines reads as plain English', () => {
  const accounts = m.summarizeAccounts(m.slimUsers([{ id: 'a', created_at: iso(1) }]), { ratings: [{ user_id: 'a' }], watchlist: [], lists: [] }, NOW);
  const lines = m.weeklySummaryLines(m.buildDashboardData({ now: NOW, accounts, ph: { active: [{ dau: 1, wau: 1, mau: 1 }] } }));
  assert.equal(lines[0], '1 account in total, 1 new this past week.');
  assert.match(lines[1], /^1 signed-in person used the site this week/);
});

test('weeklySummaryLines counts iPhone app sign-ins, which have no sign-in box step', () => {
  const accounts = m.summarizeAccounts(m.slimUsers([{ id: 'a', created_at: iso(1) }]), { ratings: [], watchlist: [], lists: [] }, NOW);
  const funnel = [
    { src: 'rate', dev: 'Desktop', shown: 1, started: 1, completed: 1, acted: 0 },
    { src: '', dev: '', shown: 0, started: 0, completed: 1, acted: 0 },
    { src: 'app', dev: 'App', shown: 0, started: 1, completed: 1, acted: 0 },
  ];
  const lines = m.weeklySummaryLines(m.buildDashboardData({ now: NOW, accounts, ph: { funnel } }));
  const line = lines.find((l) => l.startsWith('Sign-up funnel'));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /Computers: 1 saw the sign-in box, 1 started, 1 finished/);
  assert.match(line, /iPhone app \/ other: 1 started, 2 finished/);
});

test('summarizeFunnel names app rows with no source and keeps finish-only devices', () => {
  const f = m.summarizeFunnel([{ src: '', dev: 'App', shown: 0, started: 2, completed: 3, acted: 0 }]);
  assert.equal(f.sources[0].label, 'iPhone app');
  assert.equal(f.totals.other.completed, 3);
});

test('funnel query keeps devices that only finished signing in', () => {
  const q = m.buildQueries().funnel;
  assert.match(q, /WHERE n_shown > 0 OR n_started > 0 OR n_completed > 0/);
  assert.match(q, /'sign_in_started', 'sign_in_completed'\)\) AS dev/);
  assert.match(q, /'sign_in_started', 'sign_in_completed'\)\) AS src/);
});

test('summarizeFunnel lists finish-only rows and drops rows with no sign-in step', () => {
  const f = m.summarizeFunnel([
    { src: 'app', dev: 'App', shown: 0, started: 0, completed: 3, acted: 0 },
    { src: 'menu', dev: 'Desktop', shown: 0, started: 0, completed: 0, acted: 1 },
  ]);
  assert.deepEqual(f.sources.map((x) => x.source), ['app']);
});

test('weeklySummaryLines keeps phone or computer sign-ins that skipped the sign-in box', () => {
  const accounts = m.summarizeAccounts(m.slimUsers([{ id: 'a', created_at: iso(1) }]), { ratings: [], watchlist: [], lists: [] }, NOW);
  const funnel = [{ src: 'menu', dev: 'Mobile', shown: 0, started: 1, completed: 1, acted: 0 }];
  const line = m.weeklySummaryLines(m.buildDashboardData({ now: NOW, accounts, ph: { funnel } })).find((l) => l.startsWith('Sign-up funnel'));
  assert.match(line || '', /Phones: 0 saw the sign-in box, 1 started, 1 finished/);
});

test('account-metrics.js --simulate=signin-stalled prints the alert and sends nothing', () => {
  const out = execFileSync(process.execPath, [path.join(here, '..', 'account-metrics.js'), '--simulate=signin-stalled', '--out=/tmp/account-metrics-test'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.match(out, /SIMULATION/);
  assert.match(out, /WOULD ALERT \[ugc:signin-stalled\]/);
});

test('a stalled sign-in alert clears only on a real completion, not when old starts age out', () => {
  const stall = (h) => m.evaluateAlerts(h).find((a) => a.key === m.ALERT_KEYS.signInStalled);
  const agedOut = stall({ started: 2, started_devices: 2, completed: 0 });
  assert.equal(agedOut.firing, false);
  assert.equal(agedOut.resolvable, false, 'still nobody finished: keep the incident open');
  assert.equal(stall({ started: 2, started_devices: 2, completed: 1 }).resolvable, true);
  assert.equal(stall({ started: 0, started_devices: 0, completed: 0 }).resolvable, true);
});

test('only the synthetic Google/Apple check pages; the PostHog signals go to the digest', () => {
  const { isPageWorthy } = require('./page-worthy-alerts.js');
  assert.equal(isPageWorthy(m.ALERT_KEYS.signInRedirect + 'google'), true);
  assert.equal(isPageWorthy(m.ALERT_KEYS.signInRedirect + 'apple'), true);
  for (const k of [m.ALERT_KEYS.signInStalled, m.ALERT_KEYS.saveFailures, m.ALERT_KEYS.errorSpike]) {
    assert.equal(isPageWorthy(k), false, k);
  }
});

test('offline save failures are not counted', () => {
  assert.match(m.buildQueries().health, /rating_save_failed' AND NOT match\(lower\(toString\(properties\.error_message\)\), 'failed to fetch/);
});
