/**
 * "Cite this score" (BRO-5982): the citation text a journalist or blogger
 * pastes, built from the same inputs as /api/badge/[slug] so the two never
 * disagree: Math.round(criticScore.score), criticScore.reviewCount, and the
 * isShowScoreTBD() decision (coverage floor included).
 */
import { isShowScoreTBD } from './show-score-tbd';
import { SITE_URL } from './site-url';
import { getMarketBrand } from '../config/branding';
import type { ComputedShow, CriticScoreResult } from './engine';


const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface CitableScore {
  title: string;
  slug: string;
  /** Opening year, or null when the date is missing/unparseable. */
  year: number | null;
  score: number;
  reviewCount: number;
  /** The market's own brand, e.g. "West End Scorecard". */
  siteName: string;
}

// criticScore.reviews is left out so the show page's slimmed review rows fit too.
type CitableShowFields = Pick<ComputedShow, 'id' | 'title' | 'slug' | 'openingDate' | 'category' | 'status' | 'scorePublicSince' | 'cov' | 'coverageAcked'> & {
  criticScore: Pick<CriticScoreResult, 'score' | 'reviewCount' | 'tier1Count' | 'tier2Count'> | null;
};

/** The show's citable score, or null when the badge would read TBD. */
export function getCitableScore(show: CitableShowFields): CitableScore | null {
  // isShowScoreTBD reads only the fields above; it is typed for the full result.
  if (isShowScoreTBD(show as Parameters<typeof isShowScoreTBD>[0])) return null;
  const raw = show.criticScore?.score;
  if (raw == null) return null;
  const y = /^(\d{4})/.exec(show.openingDate || '');
  return {
    title: show.title,
    slug: show.slug,
    year: y ? Number(y[1]) : null,
    score: Math.round(raw),
    reviewCount: show.criticScore?.reviewCount ?? 0,
    siteName: getMarketBrand(show.category).siteName,
  };
}

/** "22 October 2026", in UTC so the text does not depend on the reader's zone. */
export function formatRetrievedDate(d: Date): string {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function buildCitation(c: CitableScore, retrieved: Date): string {
  const head = c.year ? `${c.title} (${c.year})` : c.title;
  const n = c.reviewCount;
  return (
    `${head}. Critic Score ${c.score}/100 from ${n} ${n === 1 ? 'review' : 'reviews'}. ` +
    `${c.siteName}. ${SITE_URL}/show/${c.slug}. Retrieved ${formatRetrievedDate(retrieved)}.`
  );
}
