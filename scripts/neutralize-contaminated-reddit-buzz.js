#!/usr/bin/env node
/**
 * Neutralize generic-title Reddit contamination in audience-buzz.json.
 *
 * Companion to the scrape-reddit-sentiment.js fix (roundup/megathread guard +
 * market-anchored queries). The scraper fix prevents NEW contamination, but
 * already-stored records keep their inflated Reddit volume until the next
 * scheduled scrape (monthly). This script suppresses the contaminated Reddit
 * source on the shows the audit flags (REDDIT_GENERIC_VOLUME_INFLATION) so the
 * combined score is recomputed from the clean sources immediately.
 *
 * Suppression is non-destructive and self-clearing: it sets
 * reddit.suppressed=true (isRedditEligible drops it from weighting); the next
 * scrape overwrites the reddit object with a fresh, clean one and the flag
 * disappears. Nothing is deleted.
 *
 * Selection mirrors scripts/audit-audience-buzz-contamination.js exactly:
 *   generic/collision-prone title + reddit.reviewCount >= 80 + Reddit volume
 *   >= 2x the largest other source (or sole source) + show is score-eligible
 *   (not closed >3yr ago).
 *
 * Usage:
 *   node scripts/neutralize-contaminated-reddit-buzz.js            # dry run
 *   node scripts/neutralize-contaminated-reddit-buzz.js --apply    # write
 *   node scripts/neutralize-contaminated-reddit-buzz.js --apply --exclude=a,b
 */

const fs = require('fs');
const path = require('path');
const { isRedditVolumeInflated, otherSourceReviewCounts, REDDIT_INFLATION_MIN_RC } = require('./lib/reddit-post-filters');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { loadAudienceBuzz, saveAudienceBuzz } = require('./lib/audience-buzz-write-guard');

const ROOT = path.join(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');

const MIN_RC = REDDIT_INFLATION_MIN_RC;

const apply = process.argv.includes('--apply');
const excludeArg = process.argv.find((a) => a.startsWith('--exclude='));
const exclude = new Set(excludeArg ? excludeArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : []);

function main() {
  const buzz = loadAudienceBuzz();
  const shows = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8')).shows || [];
  const showById = new Map(shows.map((s) => [s.id, s]));
  const shows_ = buzz.shows || {};

  const acted = [];

  for (const [id, x] of Object.entries(shows_)) {
    if (!x || typeof x !== 'object') continue;
    if (exclude.has(id)) continue;
    const sources = x.sources || {};
    const reddit = sources.reddit;
    const rc = reddit && reddit.reviewCount ? reddit.reviewCount : 0;
    if (!reddit || rc < MIN_RC || reddit.suppressed) continue;

    const show = showById.get(id);
    const title = x.title || (show && show.title) || id.replace(/-(off-)?(broadway|west-end)?-?20\d{2}$/, '').replace(/-/g, ' ');

    // Score-eligibility — same date-precise cutoff as audience-weighting.js
    // isRedditEligible (closed < now-3yr); don't suppress Reddit the live score
    // already drops.
    if (show && show.status === 'closed' && show.closingDate) {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 3);
      if (new Date(show.closingDate) < cutoff) continue;
    }

    const otherCounts = otherSourceReviewCounts(sources);
    const maxOther = otherCounts.length ? Math.max(...otherCounts) : 0;
    // Title-independent contamination test (shared with the audit). Catches
    // multi-word generic phrases the old isGenericTitle gate missed.
    if (!isRedditVolumeInflated(rc, otherCounts, title)) continue;

    const before = x.combinedScore;
    // Project the post-suppression score (used for both the dry-run report and
    // the real recompute) by evaluating weighting on a reddit-suppressed copy.
    const showInfo = show ? { status: show.status, closingDate: show.closingDate } : undefined;
    const projectedSources = { ...sources, reddit: { ...reddit, suppressed: true } };
    const { score: projected } = calculateCombinedScore(projectedSources, showInfo);
    if (apply) {
      reddit.suppressed = true;
      reddit.suppressedReason = 'generic-title-contamination';
      reddit.suppressedAt = new Date().toISOString();
      x.combinedScore = projected;
      x.designation = projected == null ? null : getDesignation(projected);
    }
    acted.push({ id, title, rc, maxOther, before, after: projected });
  }

  acted.sort((a, b) => a.id.localeCompare(b.id));
  console.log(`[neutralize] ${acted.length} contaminated shows ${apply ? 'SUPPRESSED' : '(dry run — use --apply)'}\n`);
  for (const a of acted) {
    console.log(`  ${a.id} "${a.title}" reddit rc=${a.rc} maxOther=${a.maxOther} | combinedScore ${a.before} -> ${a.after}`);
  }

  if (apply && acted.length) {
    buzz._meta = buzz._meta || {};
    saveAudienceBuzz(buzz);
    console.log(`\nWrote data/audience-buzz.json`);
  }
}

main();
