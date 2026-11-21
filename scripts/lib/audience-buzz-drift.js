/**
 * Aggregate drift between two audience-buzz.json snapshots (the pre-scrape
 * backup vs the post-scrape/recalculate result). Pure + testable so the CI
 * guard (scripts/audience-buzz-scrape-drift-guard.js) and its unit test share
 * one implementation.
 *
 * Purpose (CLAUDE.md rule 13): a full Reddit scrape re-scores many shows at
 * once with no built-in abort. The deterministic anchor pre-gate + neutralize
 * are EXPECTED to move some scores (contamination cleanup), so the thresholds
 * here are a CATASTROPHE FLOOR — they pass a normal run (a handful of generic-
 * title shows losing Reddit) but trip when a classifier/anchor bug mass-drops
 * or mass-shifts the corpus (e.g. the anchor regex breaks and every comment is
 * dropped, cratering hundreds of shows in one run).
 *
 * Scope: rates use the whole-corpus denominator, so this is a CORPUS-WIDE
 * catastrophe detector — a targeted `--show=X` run that craters one show is a
 * rounding error against ~500 shows and won't trip. That's intended (the guard
 * exists for the scheduled/bulk runs that move many shows at once); per-show
 * runs are low-blast-radius and manually initiated.
 */

// A show's Reddit source is "active" (contributes to the score) when it exists,
// isn't suppressed, and has volume. Mirrors isRedditEligible's spirit without
// needing the date context (drift is measured on the file as written).
function hasActiveReddit(entry) {
  const rd = entry && entry.sources && entry.sources.reddit;
  return !!(rd && !rd.suppressed && (rd.reviewCount || 0) > 0);
}

const DEFAULT_THRESHOLDS = {
  // Fraction of previously-active-Reddit shows that lost their Reddit source in
  // one run. A scheduled run touches ~50 open shows, a bulk run more; either
  // way, losing >25% of ALL active-Reddit shows at once means the gate is
  // over-dropping, not cleaning up.
  redditLossRate: 0.25,
  // Fraction of previously-scored shows whose combinedScore went null.
  combinedNulledRate: 0.25,
  // Mean absolute combinedScore movement across shows scored in BOTH snapshots.
  meanCombinedDrift: 12,
  // Fraction of show ENTRIES present before but gone after — a merge/scrape bug
  // that drops whole shows (not just their Reddit) is otherwise invisible to the
  // score/reddit metrics. A scrape never legitimately deletes shows, so the
  // floor is tight.
  removedRate: 0.05,
};

/**
 * @param {{shows: Record<string, object>}} before  pre-scrape snapshot (backup)
 * @param {{shows: Record<string, object>}} after   post-scrape snapshot
 * @param {object} [thresholds]  override DEFAULT_THRESHOLDS
 * @returns {{metrics: object, breaches: string[], catastrophe: boolean}}
 */
function computeScrapeDrift(before, after, thresholds = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const b = (before && before.shows) || {};
  const a = (after && after.shows) || {};

  let totalBefore = 0;         // show entries present before
  let removed = 0;             // present before, absent after
  let redditActiveBefore = 0;
  let redditLost = 0;          // active reddit before -> not active after
  let scoredBefore = 0;        // combinedScore non-null before
  let combinedNulled = 0;      // scored before -> null after
  let driftN = 0;              // shows scored in both
  let driftSum = 0;            // sum |Δ combinedScore|
  let bucketFlips = 0;         // designation changed (both non-null)
  const topDrifts = [];

  for (const [id, beforeEntry] of Object.entries(b)) {
    totalBefore++;
    const afterEntry = a[id];
    if (!afterEntry) { removed++; continue; } // whole entry dropped — caught by removedRate

    if (hasActiveReddit(beforeEntry)) {
      redditActiveBefore++;
      if (!hasActiveReddit(afterEntry)) redditLost++;
    }

    const bs = beforeEntry.combinedScore;
    const as = afterEntry.combinedScore;
    const bScored = bs != null;
    const aScored = as != null;
    if (bScored) scoredBefore++;
    if (bScored && !aScored) combinedNulled++;
    if (bScored && aScored) {
      const d = Math.abs(as - bs);
      driftN++;
      driftSum += d;
      if (d > 0) topDrifts.push({ id, before: bs, after: as, delta: +(as - bs).toFixed(2) });
      if (beforeEntry.designation !== afterEntry.designation) bucketFlips++;
    }
  }

  const redditLossRate = redditActiveBefore ? redditLost / redditActiveBefore : 0;
  const combinedNulledRate = scoredBefore ? combinedNulled / scoredBefore : 0;
  const meanCombinedDrift = driftN ? driftSum / driftN : 0;
  const removedRate = totalBefore ? removed / totalBefore : 0;

  topDrifts.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const metrics = {
    totalBefore,
    removed,
    removedRate: +removedRate.toFixed(4),
    redditActiveBefore,
    redditLost,
    redditLossRate: +redditLossRate.toFixed(4),
    scoredBefore,
    combinedNulled,
    combinedNulledRate: +combinedNulledRate.toFixed(4),
    driftN,
    meanCombinedDrift: +meanCombinedDrift.toFixed(2),
    bucketFlips,
    topDrifts: topDrifts.slice(0, 15),
  };

  const breaches = [];
  if (removedRate > t.removedRate) {
    breaches.push(`removedRate ${(removedRate * 100).toFixed(1)}% > ${(t.removedRate * 100).toFixed(0)}% (${removed}/${totalBefore} show entries dropped entirely)`);
  }
  if (redditLossRate > t.redditLossRate) {
    breaches.push(`redditLossRate ${(redditLossRate * 100).toFixed(1)}% > ${(t.redditLossRate * 100).toFixed(0)}% (${redditLost}/${redditActiveBefore} active-Reddit shows lost Reddit)`);
  }
  if (combinedNulledRate > t.combinedNulledRate) {
    breaches.push(`combinedNulledRate ${(combinedNulledRate * 100).toFixed(1)}% > ${(t.combinedNulledRate * 100).toFixed(0)}% (${combinedNulled}/${scoredBefore} scored shows went null)`);
  }
  if (meanCombinedDrift > t.meanCombinedDrift) {
    breaches.push(`meanCombinedDrift ${meanCombinedDrift.toFixed(2)}pts > ${t.meanCombinedDrift}pts (over ${driftN} shows scored in both)`);
  }

  return { metrics, breaches, catastrophe: breaches.length > 0, thresholds: t };
}

module.exports = { computeScrapeDrift, hasActiveReddit, DEFAULT_THRESHOLDS };
