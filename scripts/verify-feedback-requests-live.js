#!/usr/bin/env node

/**
 * Check every open user content request against the LIVE site and email the
 * owner the moment it is actually visible there.
 *
 * WHY (2026-08-05, owner request): "auto-dispatched" is not "fixed". The
 * pipeline's notifications all stopped at intent — a workflow was triggered —
 * and nothing ever confirmed the show appeared on broadwayscorecard.com. The
 * owner asked for two things this script provides:
 *   1. An email when a request is FULLY fixed, meaning live on the site.
 *   2. Confirmation of whether a systematic fix came with it — i.e. whether
 *      this ask shape now routes itself, or was a one-off.
 *
 * It also reports requests that have been open too long (STALE_AFTER_DAYS).
 * Those are never auto-closed: a request whose workflow silently failed is
 * precisely what used to disappear, so it gets louder, not quieter.
 *
 * Usage:
 *   node scripts/verify-feedback-requests-live.js [--dry-run] [--base=URL]
 *
 * Env: GH_TOKEN / GITHUB_TOKEN (optional — closes the tracking issue when live).
 *      RESEND_API_KEY / OWNER_EMAIL are only consulted if the router pages.
 *
 * DELIVERY (2026-08-05): reported via routeAlert(), not a direct Resend call.
 * Card #611 is the owner's standing mandate that senders do not email them
 * directly unless their conditionKey is listed in scripts/lib/page-worthy-
 * alerts.js; everything else reaches them through the daily digest. "A request
 * went live" / "a request is stuck" is not site-down, opening-night-dead, or
 * data-loss, so it is digest-tier — the owner is still told, within a day.
 * Promoting either to an immediate email is one line in page-worthy-alerts.js.
 *
 * Exit 0 when there is nothing to report. Exit 1 only on a delivery failure: an
 * alerting path that fails silently is the thing this replaces.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { postJSON } = require('./lib/email-templates.js'); // GitHub issue comments only
const { routeAlert } = require('./lib/owner-alert-router.js');
const {
  evaluateEntry,
  staleEntries,
  daysSince,
  STALE_AFTER_DAYS,
} = require('./lib/feedback-request-ledger.js');

const LEDGER_PATH = path.join(__dirname, '../data/audit/feedback-request-ledger.json');
const REPO = 'thomaspryor/Broadwayscore';

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `verify-feedback-requests-live.js — confirm open content requests are LIVE on the site

Usage:
  node scripts/verify-feedback-requests-live.js [--dry-run] [--base=URL]

  --dry-run    evaluate + print, never report and never close a tracking issue
  --base=URL   site to check against (default https://broadwayscorecard.com)

Reports through routeAlert() (digest-tier by default — see the header).
Env: GH_TOKEN / GITHUB_TOKEN (optional — closes the tracking issue when live)
`;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BASE = (args.find((a) => a.startsWith('--base=')) || '--base=https://broadwayscorecard.com').split('=')[1];

function getJSON(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    return { entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function saveLedger(ledger) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n');
}

/**
 * Resolve an entry to a show ID. missing-show entries have none at request time
 * (the show did not exist yet), so they are matched against the catalog by
 * title + market — the same market scoping the router uses, so a Broadway entry
 * never closes a request for the regional tryout.
 */
function resolveEntryShowId(entry, shows) {
  if (entry.showId) return entry.showId;
  if (!entry.title || !Array.isArray(shows)) return null;
  const { resolveShowMatches } = require('./lib/resolve-show.js');
  let matches = resolveShowMatches(entry.title, shows);
  if (entry.market) matches = matches.filter((s) => s && s.category === entry.market);
  if (matches.length === 0) return null;
  return [...matches].sort((a, b) =>
    String(b.openingDate || '').localeCompare(String(a.openingDate || ''))
  )[0].id;
}

function showUrl(entry, showId, shows) {
  const show = (shows || []).find((s) => s && s.id === showId);
  const slug = show?.slug || showId;
  return `${BASE}/shows/${slug}`;
}

/**
 * Build the routeAlert() payload for one verification pass.
 *
 * conditionKey names the exact requests being reported, so a request going live
 * (or newly going stale) is always a new incident that notifies, while a
 * re-run that finds the same state is silenced by the router's ledger.
 */
function buildAlert(nowLive, stale) {
  const liveLines = nowLive.map((r) => [
    `[NOW LIVE ON THE SITE] ${r.entry.title || r.showId}`,
    `  They asked: "${r.entry.requestedMessage || '(no message)'}"`,
    `  Verified live: ${r.evidence} — ${r.url}`,
    `  Systematic fix: ${r.entry.systematicFix?.note || 'One-off — no standing route for this ask shape yet.'}`,
    `  Requested ${Math.round(daysSince(r.entry.requestedAt) * 10) / 10} day(s) ago${r.entry.issueNumber ? ` — https://github.com/${REPO}/issues/${r.entry.issueNumber}` : ''}`,
  ].join('\n'));

  const staleLines = stale.map((e) => [
    `[STILL NOT LIVE AFTER ${Math.round(daysSince(e.requestedAt))} DAY(S)] ${e.title || e.showId}`,
    `  Routed to ${e.workflow || 'nothing'} but the change has not reached production. The workflow likely failed.`,
    e.issueNumber ? `  https://github.com/${REPO}/issues/${e.issueNumber}` : '',
  ].filter(Boolean).join('\n'));

  const title = nowLive.length > 0 && stale.length > 0
    ? `${nowLive.length} user request(s) now live, ${stale.length} stuck`
    : nowLive.length > 0
    ? `${nowLive.length} user request(s) now live on the site`
    : `${stale.length} user request(s) stuck — not live after ${STALE_AFTER_DAYS} days`;

  const liveKeys = nowLive.map((r) => `live:${r.entry.key || r.showId}`);
  const staleKeys = stale.map((e) => `stale:${e.key || e.showId}`);

  return {
    conditionKey: `feedback-requests:${[...liveKeys, ...staleKeys].sort().join(',')}`,
    title,
    description: [...liveLines, ...staleLines].join('\n\n'),
    // A stuck request means a workflow silently failed — that is the condition
    // worth surfacing. All-live is good news, not an error.
    severity: stale.length > 0 ? 'error' : 'info',
    fields: [
      { name: 'Now live', value: String(nowLive.length) },
      { name: 'Stuck', value: String(stale.length) },
    ],
  };
}

async function closeIssue(issueNumber, evidence, url) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token || !issueNumber) return;
  try {
    await postJSON(`https://api.github.com/repos/${REPO}/issues/${issueNumber}/comments`, {
      body: `Now live on the site: ${evidence}\n\n${url}\n\n_Verified against production by scripts/verify-feedback-requests-live.js._`,
    }, { Authorization: `Bearer ${token}`, 'User-Agent': 'broadwayscorecard-feedback-verifier' });
  } catch (err) {
    console.log(`  Could not comment on #${issueNumber}: ${err.message}`);
  }
}

async function main() {
  const ledger = loadLedger();
  const open = ledger.entries.filter((e) => e.status === 'open');
  if (open.length === 0) {
    console.log('No open user requests to verify.');
    return;
  }

  let shows = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
    shows = raw.shows || raw;
  } catch (err) {
    // Without the catalog, missing-show entries cannot be resolved to an ID.
    // Say so rather than reporting them as "not live yet", which would read as
    // a failed request when it is really a missing checkout.
    console.error(`::warning::Could not read shows.json (${err.message}) — missing-show entries cannot be resolved this run.`);
  }

  const nowLive = [];
  for (const entry of open) {
    const showId = resolveEntryShowId(entry, shows);
    if (!showId) {
      console.log(`  ${entry.key}: not in the catalog yet`);
      continue;
    }
    const live = await getJSON(`${BASE}/data/shows/${showId}.json`);
    const { satisfied, evidence } = evaluateEntry(entry, live);
    console.log(`  ${entry.key}: ${satisfied ? 'LIVE' : 'waiting'} — ${evidence}`);
    if (!satisfied) continue;

    entry.status = 'live';
    entry.satisfiedAt = new Date().toISOString();
    entry.showId = showId;
    nowLive.push({ entry, showId, evidence, url: showUrl(entry, showId, shows) });
  }

  const stale = staleEntries(ledger);

  if (nowLive.length === 0 && stale.length === 0) {
    console.log('Nothing newly live, nothing stuck.');
    saveLedger(ledger);
    return;
  }

  const alert = buildAlert(nowLive, stale);

  if (DRY_RUN) {
    console.log(`[dry-run] would report: "${alert.title}"`);
    console.log(`[dry-run] ${nowLive.length} live, ${stale.length} stale`);
    return; // deliberately does NOT persist — a dry run must not mark things notified
  }

  let result;
  try {
    // See the header: routed, not sent directly (card #611). Do NOT persist the
    // status flip if routing threw — an unreported flip must be retried next
    // run, not silently marked delivered.
    result = await routeAlert({ ...alert, disposition: 'human' });
  } catch (err) {
    console.error(`::error::Failed to report live-request confirmations: ${err.message}`);
    process.exit(1);
  }

  if (result.action === 'human' && result.delivered === false) {
    console.error(`::error::Owner alert delivery FAILED for "${alert.title}" — nobody was told these went live.`);
    process.exit(1);
  }

  for (const r of nowLive) await closeIssue(r.entry.issueNumber, r.evidence, r.url);

  saveLedger(ledger);
  console.log(
    result.action === 'silent'
      ? `Already reported, not repeating: "${alert.title}"`
      : `Owner notified (${result.action}): "${alert.title}"`
  );
  console.log(`Ledger updated: ${nowLive.length} marked live, ${stale.length} still stuck.`);
}

module.exports = { buildAlert, resolveEntryShowId };

if (require.main === module) {
  // --help must short-circuit BEFORE main() does any network calls, ledger
  // reads, email sends, or GitHub issue closes (task #498 class).
  if (hasHelpFlag(args)) {
    console.log(USAGE);
  } else {
    main().catch((err) => {
      console.error(`::error::verify-feedback-requests-live crashed: ${err.message}`);
      process.exit(1);
    });
  }
}
