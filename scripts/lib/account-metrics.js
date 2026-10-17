/**
 * account-metrics.js — the numbers behind /admin/accounts (BRO-4615).
 *
 * Accounts, ratings, watchlists and lists went live 2026-10-04 (BRO-4525).
 * The owner wants one page that answers: how many accounts are there, how
 * many new ones per day/week, how many signed-in people use the site
 * (DAU/WAU/MAU), what they do, and where the sign-up funnel loses people on
 * mobile vs desktop. Plus an alert when sign-in or saving breaks.
 *
 * Two sources, each used for what it is good at:
 *   - Supabase (service role, read-only): ground truth for accounts. Only
 *     counts and dates leave this module; emails are read solely to drop the
 *     CI test accounts and are never copied into the result.
 *   - PostHog HogQL: behaviour. Signed-in users carry a `user_id`
 *     super-property (setAnalyticsUser, not identify()), so per-user counts
 *     are count(DISTINCT properties.user_id).
 *
 * The signed-in numbers deliberately skip the Real Users lens: bots don't
 * sign in, and the owner's own account is one of the accounts Supabase
 * counts, so leaving it in keeps the two halves of the page consistent.
 *
 * Pure: no I/O. scripts/account-metrics.js does the fetching.
 */
'use strict';

const DAY = 86400000;

// CI round-trip / walkthrough accounts (scripts/test-ugc-roundtrip.mjs,
// scripts/ux-walkthrough.mjs). They are deleted after each run, but a run
// that dies mid-way can leave one behind for a while.
const TEST_EMAIL_SUFFIX = '@broadwayscorecard-test.invalid';

// Addresses nobody receives mail at: reserved test domains (RFC 2606/6761)
// and the throwaway sign-ups dev sessions make (claude-e2e-<ts>@example.com).
const TEST_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'mailinator.com']);
const TEST_TLDS = ['.test', '.invalid', '.example', '.local', '.localhost'];
const TEST_LOCAL = /^(claude|e2e|qa|test)([-_.+]|\d|$)/;

// Accounts opened to the public on the website this day (first sign-in box on
// broadwayscorecard.com in PostHog). Earlier accounts are the owner's and testers'.
const ACCOUNTS_LAUNCH_DAY = '2026-10-04';

/** Same inbox? Gmail ignores dots and +tags; everyone else, +tags only. */
function inboxKey(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/**
 * 'ci-test' (dropped), 'test' (a fake address), 'owner' (the owner's own inbox,
 * +aliases included) or 'person'. Only this label leaves the module.
 */
function classifyAccount(email, ownerEmails) {
  if (typeof email !== 'string' || !email.includes('@')) return 'person'; // e.g. Apple with no email shared
  const e = email.trim().toLowerCase();
  if (e.endsWith(TEST_EMAIL_SUFFIX)) return 'ci-test';
  const owners = (Array.isArray(ownerEmails) ? ownerEmails : [ownerEmails]).filter(Boolean);
  if (owners.some((o) => inboxKey(e) === inboxKey(o))) return 'owner';
  const [local, domain] = [e.slice(0, e.lastIndexOf('@')), e.slice(e.lastIndexOf('@') + 1)];
  if (TEST_DOMAINS.has(domain) || TEST_TLDS.some((t) => domain.endsWith(t))) return 'test';
  if (TEST_LOCAL.test(local)) return 'test';
  return 'person';
}

// Things a signed-in person does, with the words the owner reads.
const ACTION_LABELS = {
  rating_submitted: 'Rated a show',
  rating_deleted: 'Deleted a rating',
  watchlist_add: 'Added to watchlist',
  watchlist_remove: 'Removed from watchlist',
  list_created: 'Created a list',
  list_item_added: 'Added a show to a list',
  list_item_removed: 'Removed a show from a list',
  list_updated: 'Edited a list',
  list_reordered: 'Reordered a list',
  list_shared: 'Shared a list',
  list_visibility_changed: 'Changed list privacy',
  list_deleted: 'Deleted a list',
  import_completed: 'Imported their shows',
  sign_out: 'Signed out',
  account_deleted: 'Deleted their account',
  // The welcome screen after a first sign-in (BRO-4619, WelcomeSheet.tsx).
  onboarding_shown: 'Saw the welcome screen',
  onboarding_step_completed: 'Finished a welcome step',
  onboarding_skipped: 'Skipped or closed the welcome screen',
  onboarding_completed: 'Finished the welcome screen',
  onboarding_search_pick: 'Searched for a show on the welcome screen',
  onboarding_market_switch: 'Switched Broadway / West End on the welcome screen',
  onboarding_import_source: 'Picked an app to import from on the welcome screen',
};
const ACTION_EVENTS = Object.keys(ACTION_LABELS);
// A sign-up "took" when the person saved something.
const ACTIVATION_EVENTS = ['rating_submitted', 'watchlist_add', 'list_created', 'list_item_added', 'import_completed'];
// Signed-out saves to this device (watchlist_add with local=true, BRO-4616)
// are not account activity: left in, "Added to watchlist" read 110 adds by 1
// person on 2026-10-08, and a device save counted as a sign-up that took.
const NOT_LOCAL = "coalesce(toString(properties.local), '') != 'true'";
// Welcome-screen picks are written straight to reviews / seen_unrated and fire
// no rating_submitted, so a saved pick counts on its own.
const WELCOME_PICKED = "event = 'onboarding_step_completed' AND toString(properties.step) = 'shows' AND toFloat(properties.shows_added) > 0";

// Where the sign-in prompt was opened (`source` on sign_in_prompt_shown,
// `context` on sign_in_started / sign_in_completed).
const SOURCE_LABELS = {
  header: 'Sign-in button (top of page)',
  menu: 'Menu',
  show_bookmark: 'Bookmark icon on a show',
  show_watchlist: 'Watchlist button on a show',
  show_add_to_list: 'Add to list on a show',
  show_rate_link: 'Rate link on a show',
  show_want_to_see: 'Want to see on a show',
  show_rating_save: 'Saving a rating',
  diary: 'Diary',
  delete_account_reauth: 'Re-sign-in to delete account',
  app: 'iPhone app',
  unknown: 'Unknown',
};

// ugc_error codes that are not failures worth an alert: offline / killed
// requests, a save with no session, a duplicate insert (already saved), and
// PostgREST's 0-rows answer. Mirrors QUIET_CODES / IGNORED_CODES in
// src/lib/ugc-analytics.ts.
const QUIET_ERROR_CODES = ['network', 'no_session', '23505', 'PGRST116'];

// Alert thresholds over the last 24 hours. Small on purpose: with a handful
// of sign-ups a day, three people starting and nobody finishing is already a
// broken sign-in. These three go to the owner's morning digest (abandoned
// sign-ins and offline phones make them noisy at this volume); only the
// synthetic Google/Apple check (signInRedirect) pages, per
// scripts/lib/page-worthy-alerts.js.
const THRESHOLDS = {
  stalledStarts: 3,         // sign_in_started events with zero sign_in_completed
  stalledStartDevices: 2,   // ...from at least this many devices (not one person retrying)
  saveFailures: 3,          // rating_save_failed events
  saveFailureDevices: 2,
  errorSpike: 10,           // non-quiet ugc_error events
  errorSpikeDevices: 3,
};

const ALERT_KEYS = {
  signInStalled: 'ugc:signin-stalled',
  saveFailures: 'ugc:save-failures',
  errorSpike: 'ugc:error-spike',
  signInRedirect: 'ugc:signin-redirect-broken:', // + provider
  signInCheckBlind: 'ugc:signin-check-blind:', // + provider; digest: the daily check could not tell
};

const sqlList = (xs) => xs.map((x) => `'${x}'`).join(', ');
const utcDay = 'toDate(toTimeZone(timestamp, \'UTC\'))';

/** HogQL statements, keyed by the name the runner stores each result under. */
function buildQueries() {
  const hasUser = "properties.user_id IS NOT NULL AND properties.user_id != ''";
  return {
    active: `
SELECT
  count(DISTINCT if(timestamp >= now() - INTERVAL 1 DAY, properties.user_id, NULL)) AS dau,
  count(DISTINCT if(timestamp >= now() - INTERVAL 7 DAY, properties.user_id, NULL)) AS wau,
  count(DISTINCT properties.user_id) AS mau
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY AND ${hasUser}`,
    daily: `
SELECT toString(${utcDay}) AS day, count(DISTINCT properties.user_id) AS signed_in_users
FROM events
WHERE timestamp >= now() - INTERVAL 60 DAY AND ${hasUser}
GROUP BY day ORDER BY day LIMIT 100`,
    actions: `
SELECT event,
  countIf(timestamp >= now() - INTERVAL 7 DAY) AS last7,
  count() AS last30,
  count(DISTINCT properties.user_id) AS users30
FROM events
WHERE event IN (${sqlList(ACTION_EVENTS)}) AND ${NOT_LOCAL} AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY event ORDER BY last30 DESC LIMIT 100`,
    // Inner columns are n_* because HogQL resolves an outer alias of the same
    // name inside WHERE (illegal_aggregation).
    // One row per device (distinct_id survives the Google redirect on the
    // same browser), attributed to the first place it met the sign-in prompt.
    // The iOS app sends no $host but does send $device_type 'Mobile', so it
    // gets its own 'App' bucket instead of inflating the phone funnel.
    // A finish with no start on the same device still counts (the iOS app
    // logs sign_in_completed under a different distinct_id than its start;
    // 2026-10-05: 3 app sign-ins finished, all on finish-only ids).
    funnel: `
SELECT src, dev,
  countIf(n_shown > 0) AS shown,
  countIf(n_started > 0) AS started,
  countIf(n_completed > 0) AS completed,
  countIf(n_completed > 0 AND n_acted > 0) AS acted
FROM (
  SELECT distinct_id,
    argMinIf(if(event = 'sign_in_prompt_shown', properties.source, properties.context), timestamp,
      event IN ('sign_in_prompt_shown', 'sign_in_started', 'sign_in_completed')) AS src,
    argMinIf(if(coalesce(properties.$host, '') = '', 'App', properties.$device_type), timestamp,
      event IN ('sign_in_prompt_shown', 'sign_in_started', 'sign_in_completed')) AS dev,
    countIf(event = 'sign_in_prompt_shown') AS n_shown,
    countIf(event = 'sign_in_started') AS n_started,
    countIf(event = 'sign_in_completed') AS n_completed,
    countIf((event IN (${sqlList(ACTIVATION_EVENTS)}) AND ${NOT_LOCAL}) OR (${WELCOME_PICKED})) AS n_acted
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY
    AND event IN ('sign_in_prompt_shown', 'sign_in_started', 'sign_in_completed', 'onboarding_step_completed', ${sqlList(ACTIVATION_EVENTS)})
  GROUP BY distinct_id
)
WHERE n_shown > 0 OR n_started > 0 OR n_completed > 0
GROUP BY src, dev ORDER BY shown DESC LIMIT 500`,
    // The welcome screen, one row per device that saw it, by device type.
    // closed_early = closed with the X before the last step (picks are still
    // saved on the way out, so a device can be both picked and closed_early).
    welcome: `
SELECT dev,
  count() AS shown,
  countIf(n_picked > 0) AS picked,
  countIf(n_skipped_shows > 0) AS skipped_shows,
  countIf(n_import_tapped > 0) AS import_tapped,
  countIf(n_imported > 0) AS imported,
  countIf(n_completed > 0) AS completed,
  countIf(n_closed > 0) AS closed_early,
  countIf(n_searched > 0) AS searched,
  countIf(n_switched > 0) AS switched_market
FROM (
  SELECT distinct_id,
    argMinIf(if(coalesce(properties.$host, '') = '', 'App', properties.$device_type), timestamp, event = 'onboarding_shown') AS dev,
    countIf(event = 'onboarding_shown') AS n_shown,
    countIf(${WELCOME_PICKED}) AS n_picked,
    countIf(event = 'onboarding_skipped' AND toString(properties.step) = 'shows' AND toString(properties.via) = 'skip') AS n_skipped_shows,
    countIf(event = 'onboarding_import_source') AS n_import_tapped,
    countIf(event = 'onboarding_step_completed' AND toString(properties.step) = 'import') AS n_imported,
    countIf(event = 'onboarding_completed') AS n_completed,
    countIf(event = 'onboarding_skipped' AND toString(properties.via) = 'close' AND toString(properties.step) != 'done') AS n_closed,
    countIf(event = 'onboarding_search_pick') AS n_searched,
    countIf(event = 'onboarding_market_switch') AS n_switched
  FROM events
  WHERE timestamp >= now() - INTERVAL 30 DAY AND event LIKE 'onboarding_%'
  GROUP BY distinct_id
)
WHERE n_shown > 0
GROUP BY dev ORDER BY shown DESC LIMIT 50`,
    // Health over the last 24 h, for the alerts. No Real Users lens: the
    // owner's own failed sign-in counts.
    health: `
SELECT
  countIf(event = 'sign_in_started') AS started,
  count(DISTINCT if(event = 'sign_in_started', distinct_id, NULL)) AS started_devices,
  countIf(event = 'sign_in_completed') AS completed,
  countIf(event = 'sign_in_failed' AND coalesce(toString(properties.reason), '') != 'cancelled') AS failed,
  countIf(event = 'rating_save_failed' AND ${saveFailureFilter()}) AS save_failed,
  count(DISTINCT if(event = 'rating_save_failed' AND ${saveFailureFilter()}, distinct_id, NULL)) AS save_failed_devices,
  countIf(event = 'ugc_error' AND ${quietErrorFilter()}) AS errors,
  count(DISTINCT if(event = 'ugc_error' AND ${quietErrorFilter()}, distinct_id, NULL)) AS error_devices
FROM events
WHERE timestamp >= now() - INTERVAL 24 HOUR
  AND event IN ('sign_in_started', 'sign_in_completed', 'sign_in_failed', 'rating_save_failed', 'ugc_error')`,
  };
}

// rating_save_failed carries only the message; a phone that lost signal says
// "Failed to fetch" / "Load failed" / "NetworkError…", which is not our bug.
function saveFailureFilter() {
  return "NOT match(lower(toString(properties.error_message)), 'failed to fetch|load failed|networkerror|network request failed')";
}

function quietErrorFilter() {
  return `coalesce(properties.error_code, '') NOT IN (${sqlList(QUIET_ERROR_CODES)}) AND coalesce(toString(properties.http_status), '') != '401'`;
}

/** PostHog {columns, results} → array of plain objects. */
function rowsToObjects(resp) {
  if (!resp || !Array.isArray(resp.columns) || !Array.isArray(resp.results)) return [];
  return resp.results.map((r) => Object.fromEntries(resp.columns.map((c, i) => [c, r[i]])));
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7;
  return isoDay(d.getTime() - (dow - 1) * DAY);
}

/**
 * Supabase auth users → only what the page needs. Emails are read here to
 * drop test accounts and go no further.
 */
function slimUsers(rawUsers, { ownerEmail, ownerEmails } = {}) {
  const out = [];
  for (const u of rawUsers || []) {
    if (!u || !u.id) continue;
    let kind = classifyAccount(u.email, [ownerEmail, ...(ownerEmails || [])]);
    if (kind === 'ci-test') continue;
    if (kind === 'person' && u.created_at && String(u.created_at).slice(0, 10) < ACCOUNTS_LAUNCH_DAY) kind = 'prelaunch';
    out.push({
      id: u.id,
      kind,
      createdAt: u.created_at || null,
      lastSignInAt: u.last_sign_in_at || null,
      provider: (u.app_metadata && u.app_metadata.provider) || 'unknown',
    });
  }
  return out;
}

/**
 * Account counts. `activity` = { ratings: [{user_id}], watchlist, lists, seen (seen_unrated) }
 * (rows from the service-role REST API; only user_id is read).
 */
function summarizeAccounts(allUsers, activity, now = Date.now(), days = 60) {
  // Every number below is real people only; the owner's and fake accounts are counted, not included.
  const users = allUsers.filter((u) => !u.kind || u.kind === 'person');
  const excluded = {
    yours: allUsers.filter((u) => u.kind === 'owner').length,
    test: allUsers.filter((u) => u.kind === 'test').length,
    prelaunch: allUsers.filter((u) => u.kind === 'prelaunch').length,
  };
  const ids = new Set(users.map((u) => u.id));
  const per = (rows) => {
    const owners = new Set();
    let n = 0;
    for (const r of rows || []) {
      if (!ids.has(r.user_id)) continue; // test accounts' rows
      owners.add(r.user_id);
      n++;
    }
    return { owners, n };
  };
  const ratings = per(activity.ratings);
  const watch = per(activity.watchlist);
  const lists = per(activity.lists);
  // "Seen it, no stars" (welcome-screen picks and My Shows' To Be Rated).
  const seen = per(activity.seen);
  const any = new Set([...ratings.owners, ...watch.owners, ...lists.owners, ...seen.owners]);

  const today = isoDay(now);
  const byDay = new Map();
  for (let i = days - 1; i >= 0; i--) byDay.set(isoDay(now - i * DAY), 0);
  const byWeek = new Map();
  const providers = {};
  let last7 = 0, last30 = 0, signedIn7 = 0, signedIn30 = 0;
  for (const u of users) {
    providers[u.provider] = (providers[u.provider] || 0) + 1;
    const c = u.createdAt ? Date.parse(u.createdAt) : NaN;
    if (Number.isFinite(c)) {
      const d = isoDay(c);
      if (byDay.has(d)) byDay.set(d, byDay.get(d) + 1);
      const w = mondayOf(d);
      byWeek.set(w, (byWeek.get(w) || 0) + 1);
      if (now - c < 7 * DAY) last7++;
      if (now - c < 30 * DAY) last30++;
    }
    const s = u.lastSignInAt ? Date.parse(u.lastSignInAt) : NaN;
    if (Number.isFinite(s)) {
      if (now - s < 7 * DAY) signedIn7++;
      if (now - s < 30 * DAY) signedIn30++;
    }
  }
  // Last 12 Mondays, oldest first, zero-filled.
  const weeks = [];
  const thisMonday = mondayOf(today);
  for (let i = 11; i >= 0; i--) {
    const w = isoDay(Date.parse(thisMonday + 'T00:00:00Z') - i * 7 * DAY);
    weeks.push({ week: w, newAccounts: byWeek.get(w) || 0, partial: w === thisMonday });
  }
  return {
    total: users.length,
    excluded,
    // One row per real account, newest first: dates and sign-in method only.
    people: users
      .map((u) => ({
        joined: u.createdAt ? isoDay(Date.parse(u.createdAt)) : null,
        lastSignIn: u.lastSignInAt ? isoDay(Date.parse(u.lastSignInAt)) : null,
        provider: u.provider,
        saved: any.has(u.id),
      }))
      .sort((x, y) => String(y.joined).localeCompare(String(x.joined))),
    newToday: byDay.get(today) || 0,
    newLast7: last7,
    newLast30: last30,
    signedInLast7: signedIn7,
    signedInLast30: signedIn30,
    providers,
    withRating: ratings.owners.size,
    withWatchlist: watch.owners.size,
    withList: lists.owners.size,
    withSeen: seen.owners.size,
    withAnything: any.size,
    ratings: ratings.n,
    watchlistItems: watch.n,
    lists: lists.n,
    daily: [...byDay.entries()].map(([date, newAccounts]) => ({ date, newAccounts })),
    weeks,
  };
}

const deviceGroup = (d) => {
  const s = String(d || '').toLowerCase();
  if (s === 'mobile' || s === 'tablet') return 'mobile';
  if (s === 'desktop') return 'desktop';
  return 'other'; // 'App' (the iOS app, no $host) or unknown
};

function emptyStep() { return { shown: 0, started: 0, completed: 0, acted: 0 }; }
function addStep(a, r) {
  a.shown += num(r.shown); a.started += num(r.started); a.completed += num(r.completed); a.acted += num(r.acted);
  return a;
}

/** Funnel rows (per source × device type) → per-source rows + mobile/desktop totals. */
function summarizeFunnel(rows) {
  const bySource = new Map();
  const totals = { mobile: emptyStep(), desktop: emptyStep(), other: emptyStep(), all: emptyStep() };
  for (const r of rows) {
    const src = r.src && SOURCE_LABELS[r.src] ? r.src : (r.src || (r.dev === 'App' ? 'app' : 'unknown'));
    const dev = deviceGroup(r.dev);
    const key = `${src}|${dev}`;
    if (!bySource.has(key)) bySource.set(key, { source: src, label: SOURCE_LABELS[src] || src, device: dev, ...emptyStep() });
    addStep(bySource.get(key), r);
    addStep(totals[dev], r);
    addStep(totals.all, r);
  }
  // A device that only "saved something" without any sign-in step is not part of the funnel table.
  const sources = [...bySource.values()]
    .filter((x) => x.shown > 0 || x.started > 0 || x.completed > 0)
    .sort((a, b) => b.shown - a.shown || b.started - a.started || b.completed - a.completed);
  return { sources, totals };
}

function summarizeActions(rows) {
  return rows
    .map((r) => ({ event: r.event, label: ACTION_LABELS[r.event] || r.event, last7: num(r.last7), last30: num(r.last30), users30: num(r.users30) }))
    .sort((a, b) => b.last30 - a.last30);
}

const WELCOME_STEPS = ['shown', 'picked', 'skipped_shows', 'import_tapped', 'imported', 'completed', 'closed_early', 'searched', 'switched_market'];

/** Welcome rows (per device type) → phone / computer / other / all totals. */
function summarizeWelcome(rows) {
  const blank = () => Object.fromEntries(WELCOME_STEPS.map((k) => [k, 0]));
  const totals = { mobile: blank(), desktop: blank(), other: blank(), all: blank() };
  for (const r of rows) {
    for (const t of [totals[deviceGroup(r.dev)], totals.all]) {
      for (const k of WELCOME_STEPS) t[k] += num(r[k]);
    }
  }
  return totals;
}

/** Merge Supabase new-accounts-per-day with PostHog signed-in-users-per-day. */
/** phDailyRows null = the PostHog query failed: signedInUsers is null (unknown), never 0. */
function mergeDaily(accountDaily, phDailyRows) {
  if (!phDailyRows) return accountDaily.map((d) => ({ ...d, signedInUsers: null }));
  const signedIn = new Map(phDailyRows.map((r) => [String(r.day), num(r.signed_in_users)]));
  return accountDaily.map((d) => ({ ...d, signedInUsers: signedIn.has(d.date) ? signedIn.get(d.date) : 0 }));
}

/**
 * Which alert conditions hold. `health` = the 24-hour health row; null means
 * the PostHog query failed (no PostHog alert either way: a query outage is
 * not a broken sign-in). Each entry: { key, firing, title, description }.
 */
function evaluateAlerts(health) {
  if (!health) return [];
  const h = {
    started: num(health.started), startedDevices: num(health.started_devices), completed: num(health.completed),
    failed: num(health.failed), saveFailed: num(health.save_failed), saveFailedDevices: num(health.save_failed_devices),
    errors: num(health.errors), errorDevices: num(health.error_devices),
  };
  const T = THRESHOLDS;
  return [
    {
      key: ALERT_KEYS.signInStalled,
      firing: h.started >= T.stalledStarts && h.startedDevices >= T.stalledStartDevices && h.completed === 0,
      // Clear only on a real completion (or no attempts at all). Starts aging
      // out of the 24 h window would otherwise resolve and re-open the alert.
      resolvable: h.completed > 0 || h.started === 0,
      title: 'Sign-in may be broken: people start signing in but nobody finishes',
      description: `In the last 24 hours ${h.started} sign-ins were started on ${h.startedDevices} devices and none finished` +
        (h.failed ? ` (${h.failed} ended in an error)` : '') + '.',
    },
    {
      key: ALERT_KEYS.saveFailures,
      firing: h.saveFailed >= T.saveFailures && h.saveFailedDevices >= T.saveFailureDevices,
      resolvable: h.saveFailed === 0,
      title: 'Saving ratings is failing',
      description: `In the last 24 hours ${h.saveFailed} rating saves failed on ${h.saveFailedDevices} devices.`,
    },
    {
      key: ALERT_KEYS.errorSpike,
      firing: h.errors >= T.errorSpike && h.errorDevices >= T.errorSpikeDevices,
      resolvable: h.errors < T.errorSpike,
      title: 'Accounts features are throwing errors',
      description: `In the last 24 hours the accounts features logged ${h.errors} errors on ${h.errorDevices} devices (offline and expired-session errors not counted).`,
    },
  ];
}

/** The JSON /admin/accounts reads (pushed to the private repo, never this public one). */
function buildDashboardData({ now = Date.now(), accounts, ph }) {
  const phOk = (k) => ph && ph[k] != null;
  const active = phOk('active') ? (ph.active[0] || {}) : null;
  return {
    generatedAt: new Date(now).toISOString(),
    accounts: accounts ? { ...accounts, daily: undefined } : null,
    daily: accounts ? mergeDaily(accounts.daily, phOk('daily') ? ph.daily : null) : [],
    weeks: accounts ? accounts.weeks : [],
    active: active ? { dau: num(active.dau), wau: num(active.wau), mau: num(active.mau) } : null,
    actions: phOk('actions') ? summarizeActions(ph.actions) : null,
    funnel: phOk('funnel') ? summarizeFunnel(ph.funnel) : null,
    welcome: phOk('welcome') ? summarizeWelcome(ph.welcome) : null,
    health: phOk('health') ? (ph.health[0] || {}) : null,
    failed: Object.entries(ph || {}).filter(([, v]) => v == null).map(([k]) => k),
  };
}

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Plain-English lines for the Monday email. */
function weeklySummaryLines(d) {
  const lines = [];
  const a = d && d.accounts;
  if (!a) return lines;
  const ex = a.excluded || {};
  const skipped = [ex.yours ? `${ex.yours} of yours` : '', ex.test ? `${ex.test} test` : '', ex.prelaunch ? `${ex.prelaunch} from before launch` : ''].filter(Boolean).join(', ');
  lines.push(`${plural(a.total, 'real account', 'real accounts')} in total, ${a.newLast7} new this past week${skipped ? ` (not counting ${skipped})` : ''}.`);
  if (d.active) lines.push(`${plural(d.active.wau, 'signed-in person', 'signed-in people')} used the site this week (${d.active.dau} in the last day, ${d.active.mau} in the last 30 days).`);
  const seenPart = a.withSeen ? `, ${a.withSeen} marked shows as seen without stars` : '';
  lines.push(`${plural(a.withAnything, 'account has', 'accounts have')} saved something: ${a.withRating} rated a show, ${a.withWatchlist} used the watchlist, ${a.withList} made a list${seenPart}.`);
  const f = d.funnel && d.funnel.totals;
  if (f && (f.all.shown || f.all.started || f.all.completed)) {
    const part = (s, name) => (s.shown || s.started || s.completed ? `${name}: ${s.shown} saw the sign-in box, ${s.started} started, ${s.completed} finished` : null);
    // The iPhone app has no sign-in box event, so it reports starts and finishes only.
    // "other" also holds finishes from a device whose start was not seen.
    const app = f.other && (f.other.started || f.other.completed) ? `iPhone app / other: ${f.other.started} started, ${f.other.completed} finished` : null;
    const parts = [part(f.mobile, 'Phones'), part(f.desktop, 'Computers'), app].filter(Boolean);
    if (parts.length) lines.push(`Sign-up funnel, last 30 days. ${parts.join('. ')}.`);
  }
  const w = d.welcome && d.welcome.all;
  if (w && w.shown) {
    lines.push(`Welcome screen, last 30 days: ${w.shown} saw it, ${w.picked} saved shows from it, ${w.imported} finished an import from another app, ${w.completed} reached the last step, ${w.closed_early} closed it early.`);
  }
  if (d.actions && d.actions.length) {
    // The welcome screen has its own line above; keep this one about what people saved.
    const top = d.actions.filter((x) => x.last7 > 0 && !x.event.startsWith('onboarding_')).slice(0, 3).map((x) => `${x.label.toLowerCase()} (${x.last7})`);
    if (top.length) lines.push(`Most common this week: ${top.join(', ')}.`);
  }
  return lines;
}

module.exports = {
  TEST_EMAIL_SUFFIX,
  ACTION_LABELS,
  ACTIVATION_EVENTS,
  SOURCE_LABELS,
  QUIET_ERROR_CODES,
  THRESHOLDS,
  ALERT_KEYS,
  buildQueries,
  rowsToObjects,
  slimUsers,
  ACCOUNTS_LAUNCH_DAY,
  classifyAccount,
  inboxKey,
  summarizeAccounts,
  summarizeFunnel,
  summarizeActions,
  summarizeWelcome,
  WELCOME_STEPS,
  mergeDaily,
  evaluateAlerts,
  buildDashboardData,
  weeklySummaryLines,
  deviceGroup,
};
