#!/usr/bin/env node
/**
 * Turn a routed "missing-show" content-request action into a real shows.json
 * entry — WITHOUT a bespoke scraper and WITHOUT stubbing from memory
 * (CLAUDE.md §3: "Never add stub shows.json entries... regional feeder-venue
 * shows auto-promote off their PV/BWW roundup page").
 *
 * Flow (reuses the SAME pipeline the daily aggregator crawl uses, so the
 * acceptance bar is identical, not a looser ad hoc one):
 *   1. SERP-search for a BroadwayWorld Review Roundup for the title (the
 *      venue hint disambiguates a same-title collision).
 *   2. Fetch it via fetchPage() and classify it with the exact same
 *      classifyCandidate() the nightly crawl uses
 *      (scripts/lib/aggregator-candidate-extract.js) — same title/venue/date
 *      extraction, same rejection reasons.
 *   3. Stage the accepted candidate and promote it with
 *      promote-ob-venue-candidates.js --regional-only. Regional candidates
 *      auto-promote off the roundup page itself (CLAUDE.md §3) — this
 *      script never writes a shows.json entry directly.
 *
 * Any rejection (no roundup found, venue not a known feeder venue, title
 * mismatch, non-html fetch) exits non-zero with the reason. There is no
 * "stub it anyway" fallback.
 *
 * Origin: GH #505 / task #722 — "3 Summers of Lincoln" content request had
 * no Playbill /production/ page but does have a BWW Review Roundup, and its
 * venue (La Jolla Playhouse) is an already-configured regional feeder venue.
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');
const { classifyCandidate } = require('./lib/aggregator-candidate-extract');
const { writeStagingCandidates } = require('./lib/venue-listing-discover');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `add-requested-show.js — Stage + promote a user-requested show via its BWW Review Roundup.

Usage:
  node scripts/add-requested-show.js --title="<title>" [--venue_hint="<venue>"]
  node scripts/add-requested-show.js --help, -h    print this usage and exit

Only promotes regional feeder-venue shows (CLAUDE.md §3 auto-promotion path).
Never stubs shows.json directly and never writes without a real roundup page.
`;

function parseArgs(argv) {
  const out = { title: null, venueHint: null, dryRun: argv.includes('--dry-run') };
  for (const a of argv) {
    if (a.startsWith('--title=')) out.title = a.slice('--title='.length);
    else if (a.startsWith('--venue_hint=') || a.startsWith('--venue-hint=')) out.venueHint = a.slice(a.indexOf('=') + 1);
  }
  return out;
}

const ROUNDUP_URL_RE = /broadwayworld\.com\/article\/Review-Roundup/i;

/** Best-effort BWW Review Roundup URL for a title, or null. Tries a
 *  venue-scoped query first (disambiguates same-title collisions) then a
 *  bare title query. Never throws — a SERP failure just yields null so the
 *  caller reports "no roundup found" instead of crashing. */
async function findRoundupUrl(title, venueHint, log) {
  const queries = [
    venueHint ? `site:broadwayworld.com/article/Review-Roundup "${title}" "${venueHint}"` : null,
    `site:broadwayworld.com/article/Review-Roundup "${title}"`,
  ].filter(Boolean);
  for (const q of queries) {
    let results = null;
    try {
      results = await serpQuery(q, { nbResults: 5 });
    } catch (err) {
      log(`  SERP query failed (${q}): ${err.message}`);
      continue;
    }
    if (!Array.isArray(results)) continue;
    const hit = results.find((r) => ROUNDUP_URL_RE.test(r.url || ''));
    if (hit) return hit.url;
  }
  return null;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    process.exit(0);
  }
  const { title, venueHint, dryRun } = parseArgs(process.argv.slice(2));
  if (!title) {
    console.error('--title is required');
    console.error(USAGE);
    process.exit(1);
  }

  console.log(`Looking for a BWW Review Roundup for "${title}"${venueHint ? ` (venue hint: "${venueHint}")` : ''}...`);
  const roundupUrl = await findRoundupUrl(title, venueHint, console.log);
  if (!roundupUrl) {
    console.log('No BWW Review Roundup found via SERP — not staging. (Never stub shows.json from memory, CLAUDE.md §3.)');
    process.exit(1);
  }
  console.log(`Found candidate roundup: ${roundupUrl}`);

  let fetched;
  try {
    fetched = await fetchPage(roundupUrl);
  } catch (err) {
    console.log(`Fetch failed: ${err.message}`);
    process.exit(1);
  }
  if (!fetched || !fetched.content) {
    console.log('Fetch returned no content.');
    process.exit(1);
  }
  if (fetched.format !== 'html') {
    console.log(`Fetch returned '${fetched.format}', not 'html' — classifier needs real markup to parse title/venue/date.`);
    process.exit(1);
  }

  const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
  const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = showsRaw.shows || showsRaw;
  const existingSlugs = new Set(shows.map((s) => s && s.slug).filter(Boolean));

  const slug = roundupUrl.split('/').filter(Boolean).pop() || '';
  const classification = classifyCandidate({
    source: 'bww-roundup',
    record: { url: roundupUrl, slug, firstSeen: new Date().toISOString() },
    html: fetched.content,
    existingSlugs,
  });

  if (classification.status === 'reject') {
    console.log(`Rejected: ${classification.reason}${classification.detail ? ` (${classification.detail})` : ''}`);
    process.exit(1);
  }

  const { candidate } = classification;
  console.log(`Accepted candidate: title="${candidate.title}" venue="${candidate.venue}" category="${candidate.category}" date=${candidate.articlePublishedAt}`);

  if (candidate.category !== 'regional') {
    console.log(
      `Candidate classifies as "${candidate.category}", not "regional" — this script only promotes the ` +
      `regional feeder-venue auto-promotion path (CLAUDE.md §3). Off-Broadway/Broadway candidates need the ` +
      `operator-run promote-ob-venue-candidates.js path with Playbill/Lortel cross-validation, not this one.`
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log('--dry-run: staging + promotion skipped.');
    return;
  }

  writeStagingCandidates([candidate]);
  console.log('Staged. Promoting via promote-ob-venue-candidates.js --regional-only...');
  execFileSync('node', [path.join(__dirname, 'promote-ob-venue-candidates.js'), '--regional-only'], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
  });
}

main().catch((err) => {
  console.error('add-requested-show.js failed:', err.message);
  process.exit(1);
});
