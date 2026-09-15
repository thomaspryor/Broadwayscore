#!/usr/bin/env node
/**
 * OB discovery S7 — ticket links + affiliate coverage for new shows /
 * off-off-broadway (BRO-166).
 *
 * The OB discovery sprint (S0-S6) covers scoring, broadcast, browse and
 * sitemap for newly-discovered Off-Broadway / off-off-broadway shows, but
 * never gave them a buy button. Two other enrichers already try to attach an
 * affiliate-able ticketLinks entry (enrich-todaytix-data.js,
 * enrich-fallback-ticket-links.js); this script picks up whatever's left —
 * shows with NEITHER a ticketLinks entry NOR an officialUrl — and fills
 * officialUrl via two fallback layers so nothing ever dead-ends with no buy
 * button at all (owner decision 2026-08-04, Option A: an unmonetized
 * "Official Site" link beats no link):
 *
 *   1. SERP discovery of the show's own dedicated website
 *      (scripts/lib/official-url-discovery.js, shared with
 *      enrich-official-urls.js).
 *   2. Known OB venue homepage fallback (scripts/lib/venue-listing-discover.js
 *      OB_VENUE_CONFIGS) — for shows at a recognized OB non-profit whose own
 *      site SERP can't find, the venue's own site (which lists the show) is
 *      still a genuine, unmonetized "Official Site" link.
 *
 * Usage:
 *   node scripts/ob-discovery-ticket-links.js [--dry-run] [--limit=N] [--time-budget-min=N]
 */

const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `ob-discovery-ticket-links.js — Official Site fallback for OB/OOB shows with no buy button.

Usage:
  node scripts/ob-discovery-ticket-links.js [--dry-run] [--limit=N] [--time-budget-min=N]
  node scripts/ob-discovery-ticket-links.js --help, -h    print this usage and exit

Options:
  --dry-run             discover but do not write shows.json
  --limit=N             max shows to attempt this run (default 15, bounds SERP spend)
  --time-budget-min=N   wall-clock budget in minutes (0/omitted = unlimited)
`;

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(USAGE);
  process.exit(0);
}

const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { discoverOfficialUrl } = require('./lib/official-url-discovery');
const { OB_VENUE_CONFIGS } = require('./lib/venue-listing-discover');
const { findDeadEndShows, venueFallbackUrl } = require('./lib/ob-ticket-link-gaps');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 15;
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

async function main() {
  const showsData = loadShows();
  const shows = Array.isArray(showsData) ? showsData : showsData.shows;

  let targets = findDeadEndShows(shows);
  console.log(`OB/off-west-end shows with no buy button at all: ${targets.length}`);

  if (targets.length > LIMIT) {
    // Day-of-month rotation (same idiom as enrich-fallback-ticket-links.js) so
    // a permanently-unfindable show at the head of the list can't starve the
    // tail forever — every gap show gets attempts across successive runs.
    const offset = (new Date().getUTCDate() * LIMIT) % targets.length;
    targets = targets.slice(offset).concat(targets.slice(0, offset)).slice(0, LIMIT);
    console.log(`Attempting ${LIMIT} this run (--limit, rotation offset ${offset}); the cron cycles the rest.`);
  }

  const canSerp = Boolean(process.env.SCRAPINGBEE_API_KEY);
  if (!canSerp) {
    console.log('⚠ SCRAPINGBEE_API_KEY not set — skipping SERP discovery, trying venue fallback only');
  }

  let serpFound = 0;
  let venueFound = 0;
  let stillMissing = 0;

  for (const show of targets) {
    if (timeBudget.exceeded()) {
      console.log(`\n⏱ Time budget (${timeBudget.minutes} min) reached — remaining shows deferred to next run.`);
      break;
    }

    process.stdout.write(`${show.id}: `);

    let url = canSerp ? await discoverOfficialUrl(show) : null;
    if (url) {
      console.log(`✓ official site (SERP): ${url}`);
      serpFound++;
    } else {
      url = venueFallbackUrl(show, OB_VENUE_CONFIGS);
      if (url) {
        console.log(`✓ venue fallback: ${url}`);
        venueFound++;
      } else {
        console.log('✗ no official/venue URL found — still dead-ends');
        stillMissing++;
        continue;
      }
    }

    if (!DRY_RUN) show.officialUrl = url;

    if (canSerp) await new Promise((r) => setTimeout(r, 500));
  }

  console.log(
    `\nResults: ${serpFound} via SERP, ${venueFound} via venue fallback, ${stillMissing} still missing.`
  );

  if (!DRY_RUN && serpFound + venueFound > 0) {
    saveShows(showsData);
    console.log('shows.json updated.');
  } else if (DRY_RUN) {
    console.log('(dry run — nothing written)');
  } else {
    console.log('No changes needed.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

module.exports = { findDeadEndShows, venueFallbackUrl };
