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

const NOW = Date.parse('2026-12-10T12:00:00Z'); // a Thursday, after the accounts launch
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
  assert.equal(s.daily.at(-1).date, '2026-12-10');
  assert.equal(s.daily.at(-1).newAccounts, 1);
  assert.equal(s.weeks.length, 12);
  assert.equal(s.weeks.at(-1).week, '2026-12-07');
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
      daily: [{ day: '2026-12-10', signed_in_users: 2 }],
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
  assert.equal(lines[0], '1 real account in total, 1 new this past week.');
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

test('device-only saves (watchlist_add local=true) count neither as an action nor as a sign-up that took', () => {
  const q = m.buildQueries();
  assert.match(q.actions, /coalesce\(toString\(properties\.local\), ''\) != 'true'/, 'actions table must leave out signed-out device saves');
  const acted = q.funnel.match(/countIf\(\(event IN \([^)]*\) AND coalesce\(toString\(properties\.local\), ''\) != 'true'\) OR/);
  assert.ok(acted, 'n_acted must leave out signed-out device saves');
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

test('classifyAccount sorts owner aliases, fake addresses and real people', () => {
  const owner = 'Jane.Doe@gmail.com';
  assert.equal(m.classifyAccount('janedoe+bsc@gmail.com', owner), 'owner');
  assert.equal(m.classifyAccount('jane.doe@googlemail.com', owner), 'owner');
  assert.equal(m.classifyAccount('claude-e2e-1759000000@example.com', owner), 'test');
  assert.equal(m.classifyAccount('someone@mysite.test', owner), 'test');
  assert.equal(m.classifyAccount('qa1@realdomain.org', owner), 'test');
  assert.equal(m.classifyAccount('walk-1@broadwayscorecard-test.invalid', owner), 'ci-test');
  assert.equal(m.classifyAccount('theatrefan@yahoo.com', owner), 'person');
  assert.equal(m.classifyAccount('testarossa@gmail.com', owner), 'person');
  assert.equal(m.classifyAccount(undefined, owner), 'person');
  assert.equal(m.classifyAccount('janedoe@gmail.com', ''), 'person');
});

test('summarizeAccounts counts real people only and reports what it left out', () => {
  const users = m.slimUsers([
    { id: 'o', email: 'jane.doe+x@gmail.com', created_at: iso(1), app_metadata: { provider: 'email' } },
    { id: 't', email: 'claude-e2e-1@example.com', created_at: iso(2) },
    { id: 'p', email: 'fan@yahoo.com', created_at: iso(3), last_sign_in_at: iso(1), app_metadata: { provider: 'google' } },
  ], { ownerEmail: 'janedoe@gmail.com' });
  const a = m.summarizeAccounts(users, { ratings: [{ user_id: 'p' }, { user_id: 'o' }], watchlist: [], lists: [] }, NOW);
  assert.equal(a.total, 1);
  assert.deepEqual(a.excluded, { yours: 1, test: 1, prelaunch: 0 });
  assert.equal(a.withRating, 1);
  assert.equal(a.people.length, 1);
  assert.deepEqual(Object.keys(a.people[0]).sort(), ['joined', 'lastSignIn', 'provider', 'saved']);
  assert.equal(a.people[0].saved, true);
  assert.ok(!JSON.stringify(a).includes('@'), 'no email leaves the summary');
  const line = m.weeklySummaryLines(m.buildDashboardData({ now: NOW, accounts: a, ph: {} }))[0];
  assert.match(line, /1 real account in total, 1 new this past week \(not counting 1 of yours, 1 test\)/);
});

// BRO-4619 welcome screen.
test('summarizeAccounts counts a "seen it, no stars" pick as saving something', () => {
  const users = m.slimUsers([{ id: 'a', created_at: iso(1) }, { id: 'b', created_at: iso(1) }]);
  const s = m.summarizeAccounts(users, { ratings: [], watchlist: [], lists: [], seen: [{ user_id: 'b' }, { user_id: 'b' }] }, NOW);
  assert.equal(s.withSeen, 1);
  assert.equal(s.withAnything, 1);
  assert.deepEqual(s.people.map((p) => p.saved).sort(), [false, true]);
  // An older caller with no seen rows still works.
  assert.equal(m.summarizeAccounts(users, { ratings: [], watchlist: [], lists: [] }, NOW).withSeen, 0);
});

test('the sign-up funnel counts welcome-screen picks as saving something', () => {
  const q = m.buildQueries().funnel;
  assert.match(q, /onboarding_step_completed' AND toString\(properties\.step\) = 'shows' AND toFloat\(properties\.shows_added\) > 0/);
  assert.match(q, /event IN \('sign_in_prompt_shown', 'sign_in_started', 'sign_in_completed', 'onboarding_step_completed'/);
});

test('welcome query keeps only devices that saw the welcome screen', () => {
  const q = m.buildQueries().welcome;
  assert.match(q, /WHERE n_shown > 0/);
  for (const k of m.WELCOME_STEPS) assert.match(q, new RegExp(`AS ${k}\\b`), `query returns ${k}`);
});

test('summarizeWelcome splits phones from computers and feeds the dashboard and Monday email', () => {
  const rows = [
    { dev: 'Mobile', shown: 5, picked: 3, skipped_shows: 1, import_tapped: 2, imported: 1, completed: 3, closed_early: 2, searched: 1, switched_market: 0 },
    { dev: 'Desktop', shown: 2, picked: 1, imported: 0, completed: 1, closed_early: 1 },
  ];
  const w = m.summarizeWelcome(rows);
  assert.equal(w.mobile.shown, 5);
  assert.equal(w.desktop.picked, 1);
  assert.equal(w.desktop.searched, 0, 'missing columns read as 0');
  assert.equal(w.all.shown, 7);
  assert.equal(w.all.closed_early, 3);
  const accounts = m.summarizeAccounts([], { ratings: [], watchlist: [], lists: [] }, NOW);
  const d = m.buildDashboardData({ now: NOW, accounts, ph: { welcome: rows } });
  assert.equal(d.welcome.all.completed, 4);
  assert.ok(m.weeklySummaryLines(d).includes(
    'Welcome screen, last 30 days: 7 saw it, 4 saved shows from it, 1 finished an import from another app, 4 reached the last step, 3 closed it early.'));
  const failed = m.buildDashboardData({ now: NOW, accounts, ph: { welcome: null } });
  assert.equal(failed.welcome, null);
  assert.deepEqual(failed.failed, ['welcome']);
  assert.ok(!m.weeklySummaryLines(failed).some((l) => l.startsWith('Welcome screen')));
});

test('every onboarding_* event the site sends has a plain-English label', () => {
  const root = path.resolve(here, '../..');
  const out = execFileSync('grep', ['-rhoE', "(track|trackUgc)\\('onboarding_[a-z_]+'", path.join(root, 'src')], { encoding: 'utf8' });
  const sent = [...new Set(out.trim().split('\n').map((l) => l.match(/'(onboarding_[a-z_]+)'/)[1]))];
  assert.ok(sent.length >= 7, `found ${sent.length} onboarding events`);
  for (const e of sent) assert.ok(m.ACTION_LABELS[e], `${e} needs a label in ACTION_LABELS`);
});

test('weeklySummaryLines leaves welcome-screen events out of "most common this week"', () => {
  const accounts = m.summarizeAccounts([], { ratings: [], watchlist: [], lists: [] }, NOW);
  const d = m.buildDashboardData({ now: NOW, accounts, ph: { actions: [
    { event: 'onboarding_shown', last7: 9, last30: 9, users30: 9 },
    { event: 'watchlist_add', last7: 4, last30: 4, users30: 2 },
  ] } });
  assert.ok(m.weeklySummaryLines(d).includes('Most common this week: added to watchlist (4).'));
});

test('classifyAccount and slimUsers treat every listed owner address as the owner', () => {
  assert.equal(m.classifyAccount('pat@work.example.org', ['jane.doe@gmail.com', 'Pat@Work.example.org']), 'owner');
  assert.equal(m.classifyAccount('pat@company.com', ['jane.doe@gmail.com']), 'person');
  assert.equal(m.classifyAccount('pat+x@company.com', ['pat@company.com']), 'owner');
  const users = m.slimUsers([
    { id: 'a', email: 'janedoe@gmail.com', created_at: iso(1) },
    { id: 'b', email: 'pat@company.com', created_at: iso(1) },
    { id: 'c', email: 'fan@yahoo.com', created_at: iso(1) },
  ], { ownerEmail: 'jane.doe@gmail.com', ownerEmails: ['pat@company.com'] });
  assert.deepEqual(users.map((u) => u.kind), ['owner', 'owner', 'person']);
});

test('accounts made before the public launch are counted as pre-launch, not people', () => {
  const users = m.slimUsers([
    { id: 'old', email: 'friend@yahoo.com', created_at: '2026-07-27T12:00:00Z' },
    { id: 'eve', email: 'eve@yahoo.com', created_at: `${m.ACCOUNTS_LAUNCH_DAY}T00:00:01Z` },
    { id: 'oldtest', email: 'claude-e2e-1@example.com', created_at: '2026-07-01T00:00:00Z' },
  ], {});
  assert.deepEqual(users.map((u) => u.kind), ['prelaunch', 'person', 'test']);
  const a = m.summarizeAccounts(users, { ratings: [{ user_id: 'old' }], watchlist: [], lists: [] }, Date.parse('2026-10-08T00:00:00Z'));
  assert.equal(a.total, 1);
  assert.deepEqual(a.excluded, { yours: 0, test: 1, prelaunch: 1 });
  assert.equal(a.withRating, 0, "a pre-launch account's rating is not a real person's");
});
