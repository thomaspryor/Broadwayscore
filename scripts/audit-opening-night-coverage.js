#!/usr/bin/env node
/**
 * Opening-Night Coverage Audit
 *
 * Checks recently-opened shows for missing T1/T2 reviews and optionally
 * sends Discord alerts + dispatches targeted collection workflows.
 *
 * Usage:
 *   node scripts/audit-opening-night-coverage.js                    # check last 3 days
 *   node scripts/audit-opening-night-coverage.js --days=7           # check last 7 days
 *   node scripts/audit-opening-night-coverage.js --show=SHOW_ID     # check specific show
 *   node scripts/audit-opening-night-coverage.js --dispatch         # auto-dispatch collection for gaps
 *   node scripts/audit-opening-night-coverage.js --alert            # send Discord alerts for gaps
 */

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./lib/venue-classification');
const { buildCensusFromArchives, censusVerdict, CI_UNFETCHABLE_OUTLETS } = require('./lib/review-census');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Expected-outlet authority: the multi-source aggregator CENSUS (review-census.js),
// not a hardcoded list. Every market — Broadway, Off-Broadway, West End — now flows
// through buildCensusFromArchives + censusVerdict. The old per-market hardcoded
// expected-outlet arrays (and the census-vs-legacy precedence ladder) were retired
// in S2-T2: they went stale, under-counted the long tail the roundups actually
// list, and disagreed with the WE census. The roundups ARE the expected list.

// Census sources that scrape review-link URLs rather than a critic-listing roundup.
// They frequently point at a DIFFERENT production's article (a pre-Broadway tryout's
// local critics), so an outlet named ONLY by these is treated as soft-missing:
// visible + blocks `complete`, but alert-only, never dispatchable (no gather storm).
const SUPPLEMENTARY_CENSUS_SOURCES = new Set(['playbill-verdict', 'show-score']);

// Opening-night floor: silent-failure detection for Broadway shows.
// FA (2026-04-19) landed 14/17 reviews because the BWW extractor silently
// dropped 3 outlets. The outlet-gap check didn't flag it because the missing
// outlets weren't all in core T1. A total-count floor catches this class.
// Window: 36-72h post-open. 36h lower bound chosen because late-drop T1s
// (WSJ, Observer) routinely publish 24-36h after opening; a 24h floor
// would false-alarm while the opening-night-poller is still ingesting.
// OB shows are exempt (floor constants are null for that market).
const BROADWAY_FLOOR_REVIEWS = 10;   // critic files captured
const BROADWAY_FLOOR_SCORED = 5;     // scored reviews
const WE_FLOOR_REVIEWS = 6;
const WE_FLOOR_SCORED = 3;
const FLOOR_WINDOW_MIN_HOURS = 36;
const FLOOR_WINDOW_MAX_HOURS = 72;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 3, dispatch: false, alert: false, showId: null };
  for (const arg of args) {
    if (arg.startsWith('--days=')) opts.days = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--show=')) opts.showId = arg.split('=')[1];
    if (arg === '--dispatch') opts.dispatch = true;
    if (arg === '--alert') opts.alert = true;
  }
  return opts;
}

function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`Missing data file: ${filepath}`);
    console.error('Run: npm run data:check');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

// Map a show category to the census market key (which roundup set to read).
function censusMarket(category) {
  if (isLondonMarket(category)) return 'west-end';
  if (category === 'off-broadway') return 'off-broadway';
  return 'broadway';
}

async function main() {
  const opts = parseArgs();

  // Load data
  const showsData = loadJSON('shows.json');
  const shows = showsData.shows || showsData;
  const reviewsData = loadJSON('reviews.json');
  const reviews = reviewsData.reviews || reviewsData;
  const outletRegistry = loadJSON('outlet-registry.json');
  const outlets = outletRegistry.outlets || outletRegistry;

  // Find recently-opened shows
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - opts.days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  let targetShows;
  if (opts.showId) {
    targetShows = shows.filter(s => s.id === opts.showId || s.slug === opts.showId);
    if (targetShows.length === 0) {
      console.error(`Show not found: ${opts.showId}`);
      process.exit(1);
    }
  } else {
    targetShows = shows.filter(s => {
      if (s.status !== 'open') return false;
      if (!s.openingDate) return false;
      return s.openingDate >= cutoffStr;
    });
  }

  if (targetShows.length === 0) {
    console.log(`No shows opened in the last ${opts.days} days.`);
    return;
  }

  console.log(`\n=== Opening-Night Coverage Audit ===`);
  console.log(`Checking ${targetShows.length} show(s) opened since ${cutoffStr}\n`);

  const gaps = [];
  const floorBreaches = [];

  for (const show of targetShows) {
    const showId = show.id || show.slug;
    const category = show.category || 'broadway';
    const showReviews = reviews.filter(r => r.showId === showId);
    const scoredReviews = showReviews.filter(r => r.assignedScore != null);

    // Get outlets that have reviews
    const coveredOutlets = new Set(showReviews.map(r => r.outletId).filter(Boolean));
    // Census completeness keys off SCORED outlets only — a discovered-but-unscored
    // review (assignedScore == null) is NOT live, so it must count as missing (the
    // MJ / All My Sons class). See cloud-memory postmortem 2026-06.
    const coveredScoredOutlets = new Set(scoredReviews.map(r => r.outletId).filter(Boolean));

    // Get outlet display names
    const getName = (id) => outlets[id]?.displayName || id;

    // Floor check — silent-failure detection (catches broken extractors when
    // no specific outlet gap stands out). Only runs in 36-72h post-open window.
    // `-04:00` is EDT (summer Broadway openings). hoursSinceOpen reported in
    // Discord may be off ±1h in winter; the 36h floor gives enough slack.
    const openingMs = show.openingDate ? Date.parse(show.openingDate + 'T23:00:00-04:00') : null;
    if (show.openingDate && !Number.isFinite(openingMs)) {
      console.warn(`  ⚠ Unparseable openingDate for ${showId}: "${show.openingDate}" — floor check skipped`);
    }
    const hoursSinceOpen = Number.isFinite(openingMs) ? (now - openingMs) / (1000 * 60 * 60) : null;
    const inFloorWindow = hoursSinceOpen != null
      && hoursSinceOpen >= FLOOR_WINDOW_MIN_HOURS
      && hoursSinceOpen <= FLOOR_WINDOW_MAX_HOURS;
    // Positive-match by market so regional/off-off/typos don't silently
    // inherit the Broadway floor (10 reviews) and false-breach.
    const isBroadway = category === 'broadway';
    const floorReviews = isBroadway ? BROADWAY_FLOOR_REVIEWS : (isLondonMarket(category) ? WE_FLOOR_REVIEWS : null);
    const floorScored = isBroadway ? BROADWAY_FLOOR_SCORED : (isLondonMarket(category) ? WE_FLOOR_SCORED : null);
    const belowReviewFloor = floorReviews != null && showReviews.length < floorReviews;
    const belowScoredFloor = floorScored != null && scoredReviews.length < floorScored;
    const floorBreached = inFloorWindow && (belowReviewFloor || belowScoredFloor);

    console.log(`${show.title} (${showId})`);
    console.log(`  Category: ${category} | Opened: ${show.openingDate}`);
    console.log(`  Reviews: ${showReviews.length} total, ${scoredReviews.length} scored`);
    console.log(`  Covered outlets: ${[...coveredOutlets].sort().join(', ')}`);

    if (floorBreached) {
      console.log(`  🚨 FLOOR BREACH: ${showReviews.length}/${floorReviews} reviews, ${scoredReviews.length}/${floorScored} scored at ${Math.round(hoursSinceOpen)}h post-open`);
    }

    // === Census-anchored completeness (multi-source roundup union) — SOLE authority ===
    // The roundups list EVERY critic; the census is the honest target. Every market
    // (Broadway / Off-Broadway / West End) flows through it. Three states:
    // complete / incomplete(list missing) / no-census-yet (no roundup published —
    // never falsely green). Census-missing outlets become real gaps.
    let census = null, cVerdict = null;
    const censusMissing = [];       // HARD: named by an authoritative roundup — dispatchable
    const censusMissingSoft = [];   // SOFT: only supplementary URL-sources — alert-only
    const censusSuppressed = [];
    let censusExtractorBroken = false;
    {
      try { census = buildCensusFromArchives(showId, { show, market: censusMarket(category) }); } catch (e) { console.warn(`  ⚠ census build failed for ${showId}: ${e.message}`); }
      if (census) {
        // Pass the CI-unfetchable block list so paywalled-from-CI outlets (WSJ /
        // New Yorker) stay visible + block `complete` but don't drive endless
        // re-dispatch of a gather that can never satisfy them.
        cVerdict = censusVerdict(census, coveredScoredOutlets, { suppressed: CI_UNFETCHABLE_OUTLETS });
        for (const m of cVerdict.missing) {
          // Soft-missing: the outlet is named ONLY by supplementary URL-scraped
          // sources (Playbill Verdict / Show Score), never by an authoritative
          // critic-listing roundup (BWW / DTLI / theatre.reviews / WET / The Stage).
          // These URL-sources routinely cite a DIFFERENT production's roundup — a
          // pre-Broadway tryout's local critics (Beaches → Chicago Tribune / Sun-Times).
          // Keeping them dispatchable would re-fire a FULL gather every run for a
          // gap a NYC gather can never close (dispatch storm). So: visible + blocks
          // `complete`, but alert-only, not dispatchable, not major-severity.
          const srcs = m.sources || [];
          const isSoft = srcs.length > 0 && srcs.every((s) => SUPPLEMENTARY_CENSUS_SOURCES.has(s));
          const bucket = isSoft ? censusMissingSoft : censusMissing;
          if (!bucket.includes(m.outletId)) bucket.push(m.outletId);
        }
        for (const m of cVerdict.suppressedMissing) {
          if (!censusSuppressed.includes(m.outletId)) censusSuppressed.push(m.outletId);
        }
        // An archive present but extracting 0 reviews = a silently-broken parser
        // masquerading as no-census-yet. Surface it — the monitor must catch its
        // own blindness, not go quiet exactly when coverage is unverifiable.
        if (census.zeroExtract && census.zeroExtract.length) {
          censusExtractorBroken = true;
          console.log(`  🚨 CENSUS EXTRACTOR BROKEN: archive present but 0 reviews extracted from [${census.zeroExtract.join(', ')}] — parser likely broke (DOM drift).`);
        }
        // Parser worked but every entry was a DIFFERENT show → the archived roundup is
        // the wrong show's (mis-saved combined roundup). Alert so it gets re-fetched;
        // reuse the same flag so it's surfaced + never silently no-census-yet.
        if (census.wrongRoundup && census.wrongRoundup.length) {
          censusExtractorBroken = true;
          console.log(`  🚨 WRONG-SHOW ROUNDUP: [${census.wrongRoundup.join(', ')}] archive is for a different show (combined roundup) — re-fetch this show's roundup.`);
        }
        if (census.hadAnySource) {
          console.log(`  Census (${census.sourcesPresent.join('+')}): ${census.count} outlets; verdict=${cVerdict.verdict}`);
          if (censusMissing.length) {
            const hard = cVerdict.missing.filter(m => censusMissing.includes(m.outletId));
            console.log(`  CENSUS-MISSING (${censusMissing.length}): ${hard.map(m => `${m.outletId}${m.url ? ' '+m.url : ''}`).join(' | ')}`);
          }
          if (censusMissingSoft.length) {
            console.log(`  CENSUS-MISSING (soft, supplementary-source only, alert-only): ${censusMissingSoft.join(', ')}`);
          }
          if (cVerdict.suppressedMissing.length) {
            console.log(`  CENSUS-BLOCKED (unfetchable from CI, alert-only): ${censusSuppressed.join(', ')}`);
          }
        } else {
          console.log(`  Census: no roundup published yet → no-census-yet (holding at floor check)`);
        }
      }
    }

    // Status — census verdict is the sole authority. No census published yet means
    // the floor is met but the long tail is unverified (never falsely "complete").
    if (floorBreached) {
      console.log(`  Status: FLOOR BREACH (silent extractor failure likely)`);
    } else if (cVerdict && census.hadAnySource) {
      console.log(`  Status: ${cVerdict.verdict.toUpperCase().replace(/-/g, ' ')}`);
    } else {
      console.log(`  Status: NO CENSUS YET (no roundup published — long tail unverified)`);
    }
    console.log('');

    if (floorBreached) {
      floorBreaches.push({
        showId,
        title: show.title,
        category,
        openingDate: show.openingDate,
        hoursSinceOpen: Math.round(hoursSinceOpen),
        reviewCount: showReviews.length,
        scoredCount: scoredReviews.length,
        reviewFloor: floorReviews,
        scoredFloor: floorScored,
        belowReviewFloor,
        belowScoredFloor,
      });
    }

    // A census-incomplete show is a gap even if the review-count floor is met (the
    // whole point: the floor missed the long tail the census enumerates).
    const censusIncomplete = !!(cVerdict && census && census.hadAnySource && cVerdict.verdict === 'incomplete');
    // Dispatchable = there is something we can actually go fetch (NON-suppressed
    // census-missing). A show that's incomplete ONLY because of suppressed/
    // unfetchable outlets, or whose extractor broke, is still alert-worthy but must
    // NOT re-fire a gather that can't change the outcome.
    const dispatchable = censusMissing.length > 0;
    // Only surface a gap when there's a HARD (dispatchable) census-missing outlet or
    // a broken extractor. A show whose only census-missing outlets are soft
    // (supplementary-source tryout noise) is honestly "incomplete" but not a gap to
    // act on — recording it as a gap would storm-dispatch a gather that can't help.
    if (censusMissing.length > 0 || censusExtractorBroken) {
      gaps.push({
        showId,
        title: show.title,
        category,
        openingDate: show.openingDate,
        reviewCount: showReviews.length,
        scoredCount: scoredReviews.length,
        censusMissing,
        censusMissingSoft,
        censusSuppressed,
        censusExtractorBroken,
        censusVerdict: cVerdict ? cVerdict.verdict : null,
        dispatchable,
        severity: (censusMissing.length >= 3 || censusExtractorBroken) ? 'major' : 'minor',
      });
    }
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Shows checked: ${targetShows.length}`);
  console.log(`Shows with gaps: ${gaps.length}`);
  const majorGaps = gaps.filter(g => g.severity === 'major');
  if (majorGaps.length > 0) {
    console.log(`Major gaps (3+ census-missing outlets or broken extractor): ${majorGaps.length}`);
  }
  if (floorBreaches.length > 0) {
    console.log(`🚨 Floor breaches (silent extractor failure): ${floorBreaches.length}`);
  }

  // Discord alert
  if (opts.alert && (gaps.length > 0 || floorBreaches.length > 0)) {
    await sendDiscordAlert(gaps, floorBreaches);
  }

  // Auto-dispatch collection — ONLY for gaps with something fetchable. A show
  // that's incomplete only because of suppressed (unfetchable-from-CI) outlets,
  // or whose extractor broke, is alerted above but not re-gathered (a gather
  // can't satisfy a CI-blocked outlet — re-firing it every run is the storm).
  if (opts.dispatch && (gaps.length > 0 || floorBreaches.length > 0)) {
    const dispatchableGaps = gaps.filter(g => g.dispatchable);
    const toDispatch = [
      ...dispatchableGaps,
      ...floorBreaches.filter(b => !dispatchableGaps.some(g => g.showId === b.showId)),
    ];
    if (toDispatch.length) await dispatchCollection(toDispatch);
    const skipped = gaps.length - dispatchableGaps.length;
    if (skipped > 0) console.log(`\n⏭️  ${skipped} gap(s) alert-only (suppressed/unfetchable or broken extractor) — not dispatched.`);
  }

  // Machine-readable output
  const report = {
    timestamp: new Date().toISOString(),
    daysChecked: opts.days,
    showsChecked: targetShows.length,
    gaps,
    floorBreaches,
  };
  console.log('\n' + JSON.stringify(report, null, 2));

  // Exit with non-zero if major gaps or floor breaches found (useful for CI)
  if (majorGaps.length > 0 || floorBreaches.length > 0) {
    process.exit(1);
  }
}

async function sendDiscordAlert(gaps, floorBreaches = []) {
  try {
    const { sendAlert } = require('./lib/discord-notify');

    // Floor breaches take priority — they indicate a silent extractor failure.
    if (floorBreaches.length > 0) {
      const fields = floorBreaches.map(b => ({
        name: `🚨 ${b.title} (${b.openingDate})`,
        value: `**${b.reviewCount}/${b.reviewFloor} reviews, ${b.scoredCount}/${b.scoredFloor} scored** at ${b.hoursSinceOpen}h post-open\nLikely silent extractor failure (BWW RR sanitizer, DTLI, aggregator parse). Check latest gather-reviews logs.`,
      }));
      await sendAlert({
        title: '🚨 Opening-Night Review Floor Breach',
        description: `${floorBreaches.length} show(s) below minimum review count 24-72h post-open`,
        severity: 'error',
        fields: fields.slice(0, 10),
      });
      console.log('\nDiscord floor-breach alert sent.');
    }

    if (gaps.length > 0) {
      const fields = gaps.map(g => {
        const lines = [`${g.reviewCount} reviews, ${g.scoredCount} scored`];
        if (g.censusMissing && g.censusMissing.length) lines.push(`Census-missing (roundup lists, we lack/unscored): ${g.censusMissing.join(', ')}`);
        else if (g.censusVerdict === 'no-census-yet') lines.push(`Census: no roundup published yet`);
        if (g.censusSuppressed && g.censusSuppressed.length) lines.push(`⛔ Blocked (unfetchable from CI — needs manual grab): ${g.censusSuppressed.join(', ')}`);
        if (g.censusExtractorBroken) lines.push(`🚨 Census extractor broke (archive present, 0 extracted) — check roundup parser`);
        return { name: `${g.title} (${g.openingDate})`, value: lines.join('\n') };
      });
      await sendAlert({
        title: 'Opening-Night Coverage Gaps',
        description: `${gaps.length} show(s) have missing T1/T2 reviews`,
        severity: gaps.some(g => g.severity === 'major') ? 'error' : 'warning',
        fields: fields.slice(0, 10),
      });
      console.log('\nDiscord gap alert sent.');
    }
  } catch (e) {
    console.error('Failed to send Discord alert:', e.message);
  }
}

async function dispatchCollection(gaps) {
  const { execSync } = require('child_process');
  // Per-show in-flight dedup so a still-incomplete show (slow roundups keep it
  // incomplete for DAYS) doesn't re-fire FULL gather on every 2x-daily run — a
  // dispatch storm. Reuses the gather-idempotency run-name match (same as
  // opening-night-reviews.yml's dispatch step). Codex ship-check #2.
  let activeRuns = [];
  try {
    const out = execSync('gh run list --workflow=gather-reviews.yml --json status,displayTitle --limit 100', { encoding: 'utf8' });
    activeRuns = JSON.parse(out || '[]');
  } catch (_) { /* if we can't list, fall through and dispatch (fail-open) */ }
  let showsNeedingGather = null;
  try { ({ showsNeedingGather } = require('./lib/gather-idempotency')); } catch (_) {}
  const wanted = gaps.map((g) => g.showId);
  const needing = showsNeedingGather ? new Set(showsNeedingGather(activeRuns, wanted)) : new Set(wanted);

  for (const gap of gaps) {
    if (!needing.has(gap.showId)) {
      console.log(`\n⏭️  ${gap.showId}: gather already in-flight — skipping dispatch (no storm).`);
      continue;
    }
    try {
      // FULL gather (aggregators_only=false, max_tier=3) so the per-outlet SERP
      // pass searches the long tail the census flagged — not just aggregators.
      // collect-review-texts (chain=true, below) then triggers rebuild → score,
      // so the recovered reviews reach reviews.json and the broadcast re-fires.
      console.log(`\nDispatching FULL gather-reviews for ${gap.showId}...`);
      execSync(
        `gh workflow run gather-reviews.yml -f shows="${gap.showId}" -f max_tier=3 -f aggregators_only=false`,
        { stdio: 'inherit' }
      );

      console.log(`Dispatching collect-review-texts for ${gap.showId}...`);
      execSync(
        `gh workflow run "Collect Review Texts" -f show_filter="${gap.showId}" -f max_reviews=0 -f chain=true`,
        { stdio: 'inherit' }
      );
    } catch (e) {
      console.error(`Failed to dispatch for ${gap.showId}:`, e.message);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
