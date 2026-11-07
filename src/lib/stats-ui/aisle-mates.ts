/**
 * Aisle Mates drill-down: the full history for ONE critic or outlet.
 *
 * Port of the iOS app's lib/stats-aisle-mates.ts (BRO-6170 prototype). The
 * aggregate ranking is the shared engine's alignCritics (@/lib/stats); this
 * answers the UI-only "everything about this one reviewer" question.
 */

import { LOW_ALIGNMENT_MAX, NO_CRITIC_INDEX, parseRating, ratingToHundred } from '@/lib/stats';
import type { AlignCriticsResult, Alignment, DiaryRow, StatsReviews } from '@/lib/stats';

/**
 * The critic to label "nemesis", or null. The shared reducer returns the
 * worst-aligned critic with enough shared shows even at 70%, and with a small
 * pool that can be the same person shown as a closest or rising match. Only a
 * genuinely low aligner who isn't listed above qualifies (ship-check, BRO-6170).
 */
export function displayNemesis(result: Pick<AlignCriticsResult, 'nemesis' | 'topMates' | 'rising'>): Alignment | null {
  const n = result.nemesis;
  if (!n || n.alignment >= LOW_ALIGNMENT_MAX) return null;
  const listed = new Set([...result.topMates, ...result.rising].map(a => a.name));
  return listed.has(n.name) ? null : n;
}

export type Reviewer = { kind: 'critic'; index: number } | { kind: 'outlet'; name: string };

export interface ReviewerDetail {
  shared: { showId: string; theirScore: number }[];
  biggestAgreementShowId: string | null;
  biggestFightShowId: string | null;
  /** Shows they scored that you have not rated, best score first. */
  unseen: { showId: string; theirScore: number }[];
}

const mean = (values: number[]) => values.reduce((s, v) => s + v, 0) / values.length;

function matches(row: [number, number, number], reviews: StatsReviews, who: Reviewer): boolean {
  const [criticIdx, outletIdx] = row;
  if (who.kind === 'critic') return criticIdx === who.index && criticIdx !== NO_CRITIC_INDEX;
  return reviews.outlets[outletIdx]?.[0] === who.name;
}

export function reviewerDetail(rows: DiaryRow[], reviews: StatsReviews, who: Reviewer): ReviewerDetail {
  const userRatings = new Map<string, number[]>();
  for (const row of rows) {
    const r = parseRating(row.rating);
    if (r === null) continue;
    const list = userRatings.get(row.show_id);
    if (list) list.push(ratingToHundred(r));
    else userRatings.set(row.show_id, [ratingToHundred(r)]);
  }

  const shared: ReviewerDetail['shared'] = [];
  const unseen: ReviewerDetail['unseen'] = [];
  let biggestAgreementShowId: string | null = null;
  let biggestFightShowId: string | null = null;
  let smallestDelta = Infinity;
  let largestDelta = -Infinity;

  for (const [showId, reviewRows] of Object.entries(reviews.shows ?? {})) {
    const theirScores = reviewRows.filter((r) => matches(r, reviews, who)).map((r) => r[2]);
    if (theirScores.length === 0) continue;
    const theirScore = mean(theirScores);
    const yourScores = userRatings.get(showId);
    if (!yourScores) {
      unseen.push({ showId, theirScore });
      continue;
    }
    shared.push({ showId, theirScore });
    const delta = Math.abs(mean(yourScores) - theirScore);
    if (delta < smallestDelta) {
      smallestDelta = delta;
      biggestAgreementShowId = showId;
    }
    if (delta > largestDelta) {
      largestDelta = delta;
      biggestFightShowId = showId;
    }
  }

  unseen.sort((a, b) => b.theirScore - a.theirScore);
  return { shared, biggestAgreementShowId, biggestFightShowId, unseen };
}
