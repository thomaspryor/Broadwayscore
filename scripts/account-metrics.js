#!/usr/bin/env node
/**
 * account-metrics.js — builds the /admin/accounts payload and raises the
 * accounts alerts (BRO-4615). Run by .github/workflows/account-metrics.yml.
 *
 *   node scripts/account-metrics.js --out=account-metrics [--no-alerts] [--simulate=signin-stalled]
 *
 * Reads (never writes) Supabase with the service role key: the auth users
 * list plus user_id columns of reviews / watchlist / lists. Only counts and
 * dates are written out; emails never leave this process (scripts/lib/
 * account-metrics.js slimUsers). Reads PostHog with HogQL.
 *
 * Writes <out>/account-dashboard.json (the workflow pushes it to the PRIVATE
 * core-data repo at analytics/; /api/admin/account-stats reads it there) and a
 * plain-English summary to GITHUB_STEP_SUMMARY.
 *
 * Alerts go through owner-alert-router.js routeAlert(disposition:'human'),
 * whose ledger notifies once per incident; a condition that clears is
 * resolved so the next breakage pages again.
 *
 * --simulate=signin-stalled: dry run of the sign-in alert. Replaces the
 *   24-hour health numbers with "4 sign-ins started on 3 devices, none
 *   finished", prints the alert that would be sent, and sends nothing.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      POSTHOG_PERSONAL_API_KEY; for alerts RESEND_API_KEY, OWNER_EMAIL.
 *      The owner's other addresses live in the private data repo
 *      (analytics/owner-emails.json, a JSON array), never in this public one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const m = require('./lib/account-metrics');
const { hasHelpFlag } = require('./lib/cli-help.js');

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.length ? v.join('=') : true];
}));
const OUT = args.out || 'account-metrics';
const SIMULATE = args.simulate || null;
const SEND_ALERTS = !args['no-alerts'] && !SIMULATE;

const DASHBOARD_URL = 'https://broadwayscorecard.com/admin/accounts';

/** The owner's extra addresses, from the private data checkout. Missing file = none. */
function loadOwnerEmails() {
  const candidates = [process.env.OWNER_EMAILS_FILE, '/tmp/core-data-checkout/analytics/owner-emails.json'].filter(Boolean);
  for (const p of candidates) {
    try {
      const list = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(list)) return list.filter((x) => typeof x === 'string');
    } catch {
      // not there or not JSON: try the next one
    }
  }
  return [];
}

async function supabaseGet(urlPath, { range } = {}) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  if (range) headers.Range = range;
  const res = await fetch(`${base}${urlPath}`, { headers, signal: AbortSignal.timeout(60000) });
  // Never echo the body: an auth-admin error page can carry request details.
  if (!res.ok) throw new Error(`Supabase ${urlPath.split('?')[0]}: HTTP ${res.status}`);
  return res.json();
}

async function fetchAllUsers() {
  const all = [];
  const OWNER_EMAILS = loadOwnerEmails();
  // Counts only (no addresses) so a missing match shows in the run log.
  const ownerList = [process.env.OWNER_EMAIL, ...OWNER_EMAILS].filter(Boolean).map(m.inboxKey);
  const matches = ownerList.map(() => 0);
  // Stop on an empty page: if GoTrue caps per_page below what we ask for,
  // a short page is not the last page.
  for (let page = 1; page <= 1000; page++) {
    const r = await supabaseGet(`/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = Array.isArray(r) ? r : (r.users || []);
    if (users.length === 0) {
      console.log(`owner addresses: ${OWNER_EMAILS.length} from the private list${process.env.OWNER_EMAIL ? ' + OWNER_EMAIL' : ''}; accounts matched per address: [${matches.join(', ')}]`);
      return all;
    }
    for (const u of users) {
      const i = ownerList.indexOf(m.inboxKey(u && u.email));
      if (i >= 0) matches[i]++;
    }
    all.push(...m.slimUsers(users, { ownerEmail: process.env.OWNER_EMAIL, ownerEmails: OWNER_EMAILS }));
  }
  throw new Error('more than 100k users: raise the page cap');
}

// Range paging needs a unique sort key, or tied rows shift between pages and
// get skipped or counted twice.
const UNIQUE_ORDER = { reviews: 'id', lists: 'id', watchlist: 'user_id,show_id', seen_unrated: 'user_id,show_id' };

async function fetchUserIds(table) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; from < 2_000_000; from += PAGE) {
    const batch = await supabaseGet(`/rest/v1/${table}?select=user_id&order=${UNIQUE_ORDER[table]}`, { range: `${from}-${from + PAGE - 1}` });
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  throw new Error(`${table}: too many rows`);
}

async function collectAccounts() {
  const [users, ratings, watchlist, lists, seen] = await Promise.all([
    fetchAllUsers(), fetchUserIds('reviews'), fetchUserIds('watchlist'), fetchUserIds('lists'),
    // Newer table (BRO-4619): if it can't be read, lose only the "seen" count, not every account number.
    fetchUserIds('seen_unrated').catch((e) => {
      console.error(`[account-metrics] seen_unrated failed, counting it as empty: ${e.message}`);
      return [];
    }),
  ]);
  return m.summarizeAccounts(users, { ratings, watchlist, lists, seen });
}

async function collectPostHog() {
  const { phQueryFull } = require('./lib/posthog-query');
  const out = {};
  for (const [name, sql] of Object.entries(m.buildQueries())) {
    // One retry: a PostHog 504 is usually transient.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        out[name] = m.rowsToObjects(await phQueryFull(sql));
        break;
      } catch (e) {
        console.error(`[account-metrics] PostHog ${name} attempt ${attempt} failed: ${String(e.message).slice(0, 300)}`);
        out[name] = null;
      }
    }
  }
  return out;
}

async function routeAlerts(alerts) {
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  for (const a of alerts) {
    if (!a.firing) {
      if (!a.resolvable) continue; // e.g. a stall stays open until someone actually finishes signing in
      if (resolveCondition(a.key, { reason: 'condition cleared' })) console.log(`[account-metrics] resolved ${a.key}`);
      continue;
    }
    const r = await routeAlert({
      conditionKey: a.key,
      title: a.title,
      description: a.description,
      hint: `Open ${DASHBOARD_URL} for the numbers.`,
      severity: 'error',
      disposition: 'human',
      url: DASHBOARD_URL,
      cooldownHours: 24,
    });
    // These keys are not page-worthy: the router downgrades them to the
    // owner's morning digest by design (scripts/lib/page-worthy-alerts.js).
    const action = r && r.action;
    console.log(`[account-metrics] alert ${a.key}: ${action === 'digest' ? 'queued for the morning digest' : JSON.stringify(action || (r && r.status) || r).slice(0, 200)}`);
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let accounts = null;
  let ph = {};
  if (SIMULATE) {
    if (SIMULATE !== 'signin-stalled') throw new Error(`unknown --simulate=${SIMULATE}`);
    ph = { health: [{ started: 4, started_devices: 3, completed: 0, failed: 1 }] };
  } else {
    try {
      accounts = await collectAccounts();
    } catch (e) {
      console.error(`[account-metrics] Supabase failed: ${e.message}`);
    }
    ph = await collectPostHog();
  }

  const alerts = m.evaluateAlerts(ph.health ? ph.health[0] : null);
  const firing = alerts.filter((a) => a.firing);
  if (SIMULATE) {
    console.log(`SIMULATION (${SIMULATE}): nothing is sent.`);
    for (const a of firing) console.log(`WOULD ALERT [${a.key}] ${a.title}\n  ${a.description}\n  Route: ${require("./lib/page-worthy-alerts").isPageWorthy(a.key) ? "pages the owner now" : "owner's morning digest"}`);
    if (!firing.length) console.log('No alert would fire.');
    return firing.length ? 0 : 1;
  }

  const data = m.buildDashboardData({ accounts, ph });
  data.alerts = firing.map(({ key, title, description }) => ({ key, title, description }));
  if (accounts) {
    fs.writeFileSync(path.join(OUT, 'account-dashboard.json'), JSON.stringify(data, null, 2) + '\n');
  } else {
    console.error('[account-metrics] no account numbers this run; dashboard not refreshed');
  }

  const lines = m.weeklySummaryLines(data);
  const summary = [
    '## Accounts',
    ...lines.map((l) => `- ${l}`),
    data.failed.length ? `\nPostHog queries that failed this run: ${data.failed.join(', ')}` : '',
    firing.length ? `\n**Alerts firing:** ${firing.map((a) => a.title).join('; ')}` : '\nNo alerts firing.',
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');

  if (SEND_ALERTS) await routeAlerts(alerts);
  // Red run when Supabase failed or the alert query (health) failed, so
  // notify-failure and cron-health see it. Another PostHog query timing out
  // (504s are routine) only greys out that panel on the page: a warning, not
  // a red run, or check-cron-health would call a working job stale.
  if (!accounts || data.failed.includes('health')) return 1;
  if (data.failed.length) console.log(`::warning::[account-metrics] PostHog queries failed this run: ${data.failed.join(', ')}`);
  return 0;
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/account-metrics.js --out=account-metrics [--no-alerts] [--simulate=signin-stalled]');
    process.exit(0);
  }
  main().then((code) => process.exit(code), (e) => {
    console.error(`[account-metrics] ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = { main };
