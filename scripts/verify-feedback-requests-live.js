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
 * Env: RESEND_API_KEY, OWNER_EMAIL (required unless --dry-run)
 *      GH_TOKEN / GITHUB_TOKEN (optional — closes the tracking issue when live)
 *
 * Exit 0 when there is nothing to report. Exit 1 only on a send failure: an
 * alerting path that fails silently is the thing this replaces.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { postJSON } = require('./lib/email-templates.js');
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

  --dry-run    evaluate + print, never email and never close a tracking issue
  --base=URL   site to check against (default https://broadwayscorecard.com)

Env: RESEND_API_KEY, OWNER_EMAIL (required unless --dry-run)
     GH_TOKEN / GITHUB_TOKEN (optional — closes the tracking issue when live)
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

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildEmail(nowLive, stale) {
  const liveCards = nowLive.map((r) => `
    <div style="border:1px solid #e5e5e5;border-left:4px solid #15803d;border-radius:6px;padding:14px 16px;margin:0 0 12px;">
      <div style="font:600 12px/1.4 -apple-system,Segoe UI,sans-serif;color:#15803d;letter-spacing:.04em;">NOW LIVE ON THE SITE</div>
      <div style="font:600 16px/1.4 -apple-system,Segoe UI,sans-serif;color:#171717;margin:6px 0 2px;">${escapeHtml(r.entry.title || r.showId)}</div>
      <div style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#404040;">
        They asked: &ldquo;${escapeHtml(r.entry.requestedMessage || '(no message)')}&rdquo;
      </div>
      <div style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#404040;margin-top:8px;">
        <strong>Verified live:</strong> ${escapeHtml(r.evidence)} &middot;
        <a href="${escapeHtml(r.url)}" style="color:#0a7ea4;">see the page</a>
      </div>
      <div style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#404040;margin-top:6px;">
        <strong>Systematic fix:</strong> ${escapeHtml(r.entry.systematicFix?.note || 'One-off — no standing route for this ask shape yet.')}
      </div>
      <div style="font:400 12px/1.5 -apple-system,Segoe UI,sans-serif;color:#737373;margin-top:8px;">
        Requested ${escapeHtml(String(Math.round(daysSince(r.entry.requestedAt) * 10) / 10))} day(s) ago${r.entry.issueNumber ? ` &middot; <a href="https://github.com/${REPO}/issues/${r.entry.issueNumber}" style="color:#0a7ea4;">issue #${escapeHtml(r.entry.issueNumber)}</a>` : ''}
      </div>
    </div>`).join('');

  const staleCards = stale.map((e) => `
    <div style="border:1px solid #e5e5e5;border-left:4px solid #b45309;border-radius:6px;padding:14px 16px;margin:0 0 12px;">
      <div style="font:600 12px/1.4 -apple-system,Segoe UI,sans-serif;color:#b45309;letter-spacing:.04em;">STILL NOT LIVE AFTER ${escapeHtml(Math.round(daysSince(e.requestedAt)))} DAY(S)</div>
      <div style="font:600 16px/1.4 -apple-system,Segoe UI,sans-serif;color:#171717;margin:6px 0 2px;">${escapeHtml(e.title || e.showId)}</div>
      <div style="font:400 13px/1.5 -apple-system,Segoe UI,sans-serif;color:#404040;">
        Routed to <code>${escapeHtml(e.workflow || 'nothing')}</code> but the change has not reached production. The workflow likely failed.
      </div>
      ${e.issueNumber ? `<div style="font:400 12px/1.5 -apple-system,Segoe UI,sans-serif;color:#737373;margin-top:8px;"><a href="https://github.com/${REPO}/issues/${e.issueNumber}" style="color:#0a7ea4;">issue #${escapeHtml(e.issueNumber)}</a></div>` : ''}
    </div>`).join('');

  const subject = nowLive.length > 0 && stale.length > 0
    ? `${nowLive.length} user request(s) now live, ${stale.length} stuck`
    : nowLive.length > 0
    ? `${nowLive.length} user request(s) now live on the site`
    : `${stale.length} user request(s) stuck — not live after ${STALE_AFTER_DAYS} days`;

  const html = `
    <div style="max-width:640px;margin:0 auto;padding:24px 16px;background:#ffffff;">
      <h1 style="font:700 20px/1.3 -apple-system,Segoe UI,sans-serif;color:#171717;margin:0 0 16px;">User requests: shipped &amp; stuck</h1>
      ${liveCards}
      ${staleCards}
    </div>`;

  return { subject, html };
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

  const { subject, html } = buildEmail(nowLive, stale);

  if (DRY_RUN) {
    console.log(`[dry-run] would send: "${subject}"`);
    console.log(`[dry-run] ${nowLive.length} live, ${stale.length} stale`);
    return; // deliberately does NOT persist — a dry run must not mark things notified
  }

  const resendKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!resendKey || !ownerEmail) {
    console.error('::error::RESEND_API_KEY or OWNER_EMAIL missing — owner NOT told that requests went live.');
    process.exit(1);
  }

  try {
    await postJSON('https://api.resend.com/emails', {
      from: 'Broadway Scorecard Pipeline <updates@broadwayscorecard.com>',
      to: [ownerEmail],
      subject,
      html,
    }, { Authorization: `Bearer ${resendKey}` });
    console.log(`Owner notified: "${subject}"`);
  } catch (err) {
    // Do NOT persist the status flip — an unsent notification must be retried
    // next run, not silently marked delivered.
    console.error(`::error::Failed to email live-request confirmations: ${err.message}`);
    process.exit(1);
  }

  for (const r of nowLive) await closeIssue(r.entry.issueNumber, r.evidence, r.url);

  saveLedger(ledger);
  console.log(`Ledger updated: ${nowLive.length} marked live, ${stale.length} still stuck.`);
}

module.exports = { buildEmail, resolveEntryShowId };

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
