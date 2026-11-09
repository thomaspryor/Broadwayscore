/**
 * How a critic (or outlet, or video critic) compares with their peers, in words.
 *
 * Owner 2026-11-04: "1805th most generous scorer" read as an insult and made no
 * sense. It ranked against every critic on the site, most of whom have one or
 * two reviews, and critics review shows; we do the scoring. So:
 * - positivity is compared only against peers with enough reviews (the critics
 *   list defaults to 5+), and shown as a plain phrase, never an ordinal;
 * - review volume is shown only when it is a compliment (top 50).
 */

export const POSITIVITY_MIN_REVIEWS = 5;
/** "Among the most/least positive" needs this many reviews; a 5-review average is too thin for an extreme. */
export const EXTREME_TIER_MIN_REVIEWS = 10;

export interface RankableProfile {
  reviewCount: number;
  avgScore: number;
  generosityRank: number;
  /** Size of the peer pool generosityRank was computed in (0 = not ranked). */
  generosityPool?: number;
  /** Median average of that peer pool, rounded. */
  peerMedianAvg?: number;
  /** 0 = most positive, 1 = least positive; tied averages share one value. */
  generosityShare?: number;
}

/** Rank by average (most positive = 1) among peers with minReviews+; others get 0. */
export function assignPositivityRanks<T extends RankableProfile>(profiles: T[], minReviews: number = POSITIVITY_MIN_REVIEWS): void {
  const pool = profiles.filter(p => p.reviewCount >= minReviews).sort((a, b) => b.avgScore - a.avgScore);
  const avgs = pool.map(p => p.avgScore).sort((a, b) => a - b);
  const median = avgs.length
    ? (avgs.length % 2 ? avgs[(avgs.length - 1) / 2] : (avgs[avgs.length / 2 - 1] + avgs[avgs.length / 2]) / 2)
    : 0;
  for (const p of profiles) { p.generosityRank = 0; p.generosityPool = 0; p.peerMedianAvg = 0; p.generosityShare = undefined; }
  pool.forEach(p => {
    // Competition ranking: tied averages get the same rank and the same words.
    const greater = pool.filter(q => q.avgScore > p.avgScore).length;
    const equal = pool.filter(q => q.avgScore === p.avgScore).length;
    p.generosityRank = greater + 1;
    p.generosityPool = pool.length;
    p.peerMedianAvg = Math.round(median);
    p.generosityShare = pool.length > 1 ? (greater + (equal - 1) / 2) / (pool.length - 1) : 0.5;
  });
}

/** "Less positive than most critics (typical average: 74)", or null when not ranked.
 *  The critic's own average is left out: the stat box above it changes with the
 *  market filter, and two different averages on one screen read as an error. */
export function positivityPhrase(p: RankableProfile, plural: string): string | null {
  const pool = p.generosityPool ?? 0;
  if (!p.generosityRank || pool < POSITIVITY_MIN_REVIEWS) return null;
  const share = p.generosityShare ?? (p.generosityRank - 1) / (pool - 1); // 0 = most positive
  const extremeOk = p.reviewCount >= EXTREME_TIER_MIN_REVIEWS;
  const phrase =
    share <= 0.1 && extremeOk ? `Among the most positive ${plural}`
    : share <= 0.4 ? `More positive than most ${plural}`
    : share < 0.6 ? `About as positive as most ${plural}`
    : share < 0.9 || !extremeOk ? `Less positive than most ${plural}`
    : `Among the least positive ${plural}`;
  return `${phrase} (typical average: ${p.peerMedianAvg})`;
}

/** Only a compliment: "Most reviews of any critic on the site", "Top 10 critics by number of reviews". */
export function volumePhrase(volumeRank: number, singular: string, plural: string): string | null {
  if (volumeRank === 1) return `Most reviews of any ${singular} on the site`;
  if (volumeRank > 1 && volumeRank <= 10) return `Top 10 ${plural} by number of reviews`;
  if (volumeRank > 10 && volumeRank <= 50) return `Top 50 ${plural} by number of reviews`;
  return null;
}

// ---- "You vs. the consensus" (BRO-6984) ----
// A review's score next to the show's Critic Score (the canonical
// compositeScore, never a raw mean), in plain words. The show's Critic Score
// includes this critic's own review; that is the number the site shows, so it
// is the number we compare against.

/** A show needs this many scored reviews before comparing with its Critic Score means anything. */
export const CONSENSUS_MIN_REVIEWS = 5;
/** Within this many points (either way) reads as "in line". */
export const CONSENSUS_IN_LINE_BAND = 5;
/** The "went against the crowd" summary needs this many compared shows... */
export const AGAINST_CROWD_MIN_REVIEWS = 5;
/** ...and only lists gaps at least this big. */
export const AGAINST_CROWD_MIN_GAP = 10;

/** The show's Critic Score (rounded, as displayed) and how many reviews it counts. */
export interface ShowConsensus { score: number; reviewCount: number }

export interface ConsensusComparison {
  /** Critic's score minus the show's Critic Score, both rounded as displayed. */
  diff: number;
  consensus: number;
  phrase: string;
}

/** "12 points above the show's Critic Score (71)", "In line with the show's Critic Score (68)", or null when there is no meaningful consensus. */
export function compareToConsensus(reviewScore: number, consensus: ShowConsensus | null | undefined): ConsensusComparison | null {
  if (!consensus || !Number.isFinite(consensus.score) || !Number.isFinite(reviewScore)) return null;
  if (consensus.reviewCount < CONSENSUS_MIN_REVIEWS) return null;
  const c = Math.round(consensus.score);
  const diff = Math.round(reviewScore) - c;
  const n = Math.abs(diff);
  const phrase = n <= CONSENSUS_IN_LINE_BAND
    ? `In line with the show's Critic Score (${c})`
    : `${n} points ${diff > 0 ? 'above' : 'below'} the show's Critic Score (${c})`;
  return { diff, consensus: c, phrase };
}

export interface CrowdGap { showSlug: string; showTitle: string; diff: number }

/**
 * The reviews where this critic was furthest from the consensus, biggest gap
 * first, one per show. Empty when fewer than AGAINST_CROWD_MIN_REVIEWS shows
 * can be compared or no gap reaches AGAINST_CROWD_MIN_GAP.
 */
export function againstTheCrowd(
  reviews: readonly { showSlug: string; showTitle: string; reviewScore: number }[],
  consensusBySlug: Readonly<Record<string, ShowConsensus>>,
  limit = 2,
): CrowdGap[] {
  const best = new Map<string, CrowdGap>();
  for (const r of reviews) {
    const cmp = compareToConsensus(r.reviewScore, consensusBySlug[r.showSlug]);
    if (!cmp) continue;
    const prev = best.get(r.showSlug);
    if (!prev || Math.abs(cmp.diff) > Math.abs(prev.diff)) best.set(r.showSlug, { showSlug: r.showSlug, showTitle: r.showTitle, diff: cmp.diff });
  }
  if (best.size < AGAINST_CROWD_MIN_REVIEWS) return []; // shows, not reviews
  return [...best.values()]
    .filter(g => Math.abs(g.diff) >= AGAINST_CROWD_MIN_GAP)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.showTitle.localeCompare(b.showTitle))
    .slice(0, limit);
}

/** "+18" / "-22" for the summary line (a real minus sign reads better than a hyphen). */
export function signedGap(diff: number): string {
  return diff > 0 ? `+${diff}` : diff < 0 ? `−${Math.abs(diff)}` : '0';
}
