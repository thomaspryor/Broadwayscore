#!/usr/bin/env node
'use strict';
/**
 * BRO-7808: tells the opening-night coordinator when an unwatched Broadway show shows a press-night signal.
 * Runs every 30 minutes as one advisory step of check-opening-night-drift.yml. The decision is scripts/lib/late-press-night.js;
 * this file reads the inputs (shows, reviews, lane lease store, the live BWW homepage) and delivers the alert.
 *
 *   node scripts/late-press-night-watch.js [--dry-run] [--now=ISO]
 *
 * Alerts go to the coordinator card (coordinator-registry opening-night) and Discord (DISCORD_WEBHOOK_ALERTS), once per
 * show and signal day: the marker line is searched for in recent Linear comments before posting (no state file).
 * Routing only, never starts a lane. LATE_PRESS_NIGHT_OFF=1 turns it off.
 */
const fs = require('fs');
const path = require('path');
const LPN = require('./lib/late-press-night');

const ROOT = path.join(__dirname, '..');
const MAX_SHOW_AGE_DAYS = 14; // a roundup or burst for a show opened longer ago is not a press night
const DEDUPE_DAYS = 4;

const flag = (n) => process.argv.includes(`--${n}`);
const arg = (n) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

function readLeaseState() {
  try { return { state: require('./lib/opening-night-lane/lease-store').readRemote({ repoDir: ROOT }).state }; } catch (e) {
    console.log(`::warning::late-press-night: lease state unreadable (${String(e.message).slice(0, 120)}); no alerts for shows that need it`);
    return { unknown: true };
  }
}

async function homepageHtml() {
  try {
    const { fetchPage } = require('./lib/scraper');
    const url = 'https://www.broadwayworld.com/';
    // Free direct request only: this runs every 30 minutes, a paid fallback would be ~1,400 paid fetches a month.
    const r = await fetchPage(url, { directOnly: true });
    if (!r || !r.content) throw new Error('empty response');
    return r.content;
  } catch (e) {
    console.log(`::warning::late-press-night: BWW homepage unreadable (${String(e.message).slice(0, 120)}); only the review-burst signal runs`);
    return null;
  }
}

async function postDiscord(webhook, content) {
  const res = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content.slice(0, 1900) }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`discord HTTP ${res.status}`);
}

async function main() {
  if (process.env.LATE_PRESS_NIGHT_OFF === '1') { console.log('late-press-night: off (LATE_PRESS_NIGHT_OFF=1)'); return 0; }
  const dryRun = flag('dry-run');
  const nowMs = arg('now') ? Date.parse(arg('now')) : Date.now();
  const raw = readJson('data/shows.json');
  const shows = (Array.isArray(raw.shows) ? raw.shows : raw)
    .filter((s) => s && s.openingDate && (s.category || 'broadway') === 'broadway' && ['open', 'previews'].includes(s.status || 'open'))
    .filter((s) => { const t = Date.parse(`${s.openingDate}T12:00:00Z`); return nowMs - t > LPN.MIN_PRESS_NIGHT_AGE_DAYS * 864e5 && nowMs - t <= MAX_SHOW_AGE_DAYS * 864e5; });
  if (!shows.length) { console.log('late-press-night: no open Broadway show with a press night 2 to 14 days old'); return 0; }

  let reviewsRaw;
  try { reviewsRaw = readJson('data/reviews.json'); } catch (e) { console.log(`::warning::late-press-night: reviews.json unreadable (${e.message})`); reviewsRaw = []; }
  const allReviews = Array.isArray(reviewsRaw) ? reviewsRaw : (reviewsRaw.reviews || []);
  const byShow = new Map();
  for (const r of allReviews) { if (!byShow.has(r.showId)) byShow.set(r.showId, []); byShow.get(r.showId).push(r); }

  const leases = readLeaseState();
  const lease = require('./lib/opening-night-lane/lease');
  if (leases.unknown) { console.log('::warning::late-press-night: lease store unreadable, nothing can be decided this run'); return 0; }
  const unwatched = shows.filter((s) => leases.unknown || !lease.activeLeaseFor(leases.state, s.id, { now: nowMs }));
  if (!unwatched.length) { console.log('late-press-night: every candidate show has an active lane lease'); return 0; }
  const html = await homepageHtml();
  const { findBWWRoundupLinkOnHomepage } = require('./lib/bww-homepage-scan');
  const { getTier } = require('./lib/outlet-tiers');
  const tierOf = (r) => getTier(r.outletId || r.outlet, { showCategory: 'broadway' });

  const decisions = [];
  for (const show of shows) {
    const roundupUrl = html ? findBWWRoundupLinkOnHomepage(html, show.title, { openingDate: show.openingDate, showId: show.id, category: show.category }) : null;
    const showLease = leases.unknown ? { unknown: true } : lease.activeLeaseFor(leases.state, show.id, { now: nowMs });
    const d = LPN.decideLatePressNight({ show, reviews: byShow.get(show.id) || [], roundupUrl, lease: showLease, nowMs, tierOf });
    console.log(`late-press-night: ${show.id}: ${d.action}${d.signal ? ` (${d.signal} ${d.day})` : ''}${d.action === 'none' ? ` - ${d.reason}` : ''}`);
    if (d.action === 'route-coordinator') decisions.push({ show, d });
  }
  if (!decisions.length) return 0;

  const linear = process.env.LINEAR_API_KEY ? require('./lib/linear-client') : null;
  const card = require('./lib/press-night-signals-notify').coordinatorCard();
  for (const { show, d } of decisions) {
    const text = LPN.alertText(show, d);
    if (dryRun) { console.log(`dry-run: would alert\n${text}`); continue; }
    // The card comment is the record that dedupes later runs, so every failure here skips this run and retries on the next
    // (silence for 30 minutes beats a repeat alert every 30 minutes).
    if (!linear || !card) { console.log(`::error::late-press-night: ${d.marker} not sent, no LINEAR_API_KEY or coordinator card`); continue; }
    try {
      const sinceIso = new Date(nowMs - DEDUPE_DAYS * 864e5).toISOString();
      if ((await linear.listRecentCommentsContaining({ sinceIso, text: d.marker })).length) { console.log(`late-press-night: ${d.marker} already sent, skipping`); continue; }
      const issue = await linear.getIssue(card);
      if (!issue || !issue.id) throw new Error(`card ${card} not found`);
      await linear.createComment(issue.id, text);
    } catch (e) { console.log(`::error::late-press-night: ${d.marker} not sent (${String(e.message).slice(0, 120)}); retries next run`); continue; }
    if (process.env.DISCORD_WEBHOOK_ALERTS) {
      try { await postDiscord(process.env.DISCORD_WEBHOOK_ALERTS, text); } catch (e) { console.log(`::warning::late-press-night: discord failed (${String(e.message).slice(0, 120)})`); }
    }
    console.log(`::warning title=Late press night::${show.id}: ${d.reason}`);
  }
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.log(`::warning::late-press-night failed: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`); process.exit(0); });
