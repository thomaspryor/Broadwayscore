#!/usr/bin/env node
/**
 * write-show-events.js (BRO-6219)
 *
 * Records closing-date changes for New York shows as show_events rows, which
 * the iOS app's "Closing date announced" alert reads. The pure decision lives
 * in scripts/lib/show-change-diff.js (planShowEvents); the table's unique key
 * (show_id, type, value) is the diff, so there is no baseline file to go stale.
 *
 * Source: public/data/mobile-shows.json, the same feed the app sender checks
 * a candidate against (id, cat, st, cd). Prints counts only.
 *
 * Usage:
 *   node scripts/write-show-events.js [--dry-run] [--feed=path]
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { planShowEvents } = require('./lib/show-change-diff');

const PAGE = 1000;
const FETCH_TIMEOUT_MS = 30_000;

function arg(name) {
  const hit = process.argv.slice(2).find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}

const MAX_FEED_AGE_MS = 2 * 24 * 60 * 60 * 1000;

function loadFeedShows(file) {
  const feed = JSON.parse(fs.readFileSync(file, 'utf8'));
  // The feed is rebuilt many times a day. One that is days old means the pipeline is stuck,
  // and recording "new" dates from it would be recording old news.
  const ts = Date.parse(feed._ts || '');
  if (Number.isNaN(ts) || Date.now() - ts > MAX_FEED_AGE_MS) {
    throw new Error(`mobile-shows.json is stale or undated (_ts=${feed._ts || 'missing'}); not recording events`);
  }
  return (feed.shows || []).map(s => ({
    id: s.id,
    status: s.st,
    category: s.cat,
    closingDate: s.cd || null,
  }));
}

function rest(base, key) {
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return {
    async existing() {
      const rows = [];
      for (let from = 0; ; from += PAGE) {
        const res = await fetch(`${base}/rest/v1/show_events?select=show_id,type,value&order=id`, {
          headers: { ...headers, Range: `${from}-${from + PAGE - 1}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`reading show_events failed: HTTP ${res.status}`);
        const page = await res.json();
        rows.push(...page);
        if (page.length < PAGE) return rows;
      }
    },
    async insert(events) {
      // on_conflict + ignore-duplicates: a rerun, or a second run racing this one, is harmless.
      const res = await fetch(`${base}/rest/v1/show_events?on_conflict=show_id,type,value`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(events),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`writing show_events failed: HTTP ${res.status}`);
    },
  };
}

async function main() {
  const dryRun = !!arg('dry-run');
  const feedPath = arg('feed') || path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json');
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');

  const db = rest(base, key);
  const shows = loadFeedShows(feedPath);
  const existing = await db.existing();
  const plan = planShowEvents({ shows, existing });

  if (plan.abort) throw new Error(`refusing to write: ${plan.abort}`);

  const announced = plan.events.filter(e => e.type === 'closing-announced').length;
  const moved = plan.events.length - announced;
  const line = `show_events: ${shows.length} shows read, ${existing.length} events on file, ` +
    `${plan.events.length} new (${announced} announced, ${moved} moved)` +
    `${plan.seededRun ? ', first run: all seeded (no alerts)' : ''}${plan.capped ? ', CAPPED: recorded silently' : ''}` +
    `${dryRun ? ' [dry run, nothing written]' : ''}`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (plan.capped) {
    console.log(`::warning::${plan.events.length} new closing dates in one run is more than normal; they were recorded as seeded so no alert goes out. Check the feed for a data glitch.`);
  }
  if (!dryRun && plan.events.length > 0) await db.insert(plan.events);
}

main().catch(err => {
  console.error(`::error::${err.message}`);
  process.exit(1);
});
