/**
 * Audience source configuration — single source of truth for source metadata.
 * Used by AudienceBuzzCard, SortableAudienceBuzzTable, and audience-buzz pages.
 *
 * Each source has a display name, volume label, icon color, and market applicability.
 * Markets: 'all' = appears everywhere, 'broadway' = BW only, 'west-end' = WE only.
 */

export interface AudienceSourceConfig {
  key: string;
  name: string;
  volumeLabel: string;
  iconColor: string;
  markets: ('broadway' | 'west-end')[];
  /** Whether this source shows starRating (X/5) instead of percentage */
  showStarRating?: boolean;
}

export const AUDIENCE_SOURCES: AudienceSourceConfig[] = [
  { key: 'showScore', name: 'Show Score', volumeLabel: 'reviews', iconColor: 'text-yellow-400', markets: ['broadway', 'west-end'] },
  { key: 'mezzanine', name: 'Mezzanine', volumeLabel: 'reviews', iconColor: 'text-purple-400', markets: ['broadway', 'west-end'], showStarRating: true },
  { key: 'seatplan', name: 'SeatPlan', volumeLabel: 'reviews', iconColor: 'text-cyan-400', markets: ['west-end'], showStarRating: true },
  { key: 'lbo', name: 'London Box Office', volumeLabel: 'reviews', iconColor: 'text-emerald-400', markets: ['west-end'], showStarRating: true },
  { key: 'theatr', name: 'Theatr', volumeLabel: 'votes', iconColor: 'text-teal-400', markets: ['broadway'] },
  { key: 'broadwayCom', name: 'Broadway.com', volumeLabel: 'reviews', iconColor: 'text-blue-400', markets: ['broadway'], showStarRating: true },
  { key: 'reddit', name: 'Reddit', volumeLabel: 'mentions', iconColor: 'text-orange-400', markets: ['broadway', 'west-end'] },
];

export function getSourcesForMarket(market: 'broadway' | 'west-end'): AudienceSourceConfig[] {
  return AUDIENCE_SOURCES.filter(s => s.markets.includes(market));
}

export function getSourceConfig(key: string): AudienceSourceConfig | undefined {
  return AUDIENCE_SOURCES.find(s => s.key === key);
}

export const SOURCE_DESCRIPTIONS: Record<string, string> = {
  showScore: 'Audience reviews with detailed 0-100 scores. Often the largest sample size.',
  mezzanine: 'iOS app with verified ticket holders rating shows 1-5 stars.',
  theatr: 'Broadway community app with three-way sentiment: like, dislike, or mixed.',
  broadwayCom: "Star ratings from verified ticket buyers on Broadway\u2019s largest ticket site.",
  reddit: 'Sentiment analysis from r/Broadway. Requires 50+ comments. Excluded for shows closed 3+ years.',
  seatplan: 'UK theater ticketing platform with 1K-8K verified audience reviews per show.',
  lbo: 'Verified purchase reviews from London Box Office ticket buyers via Feefo.',
};

export function getSourceNames(market: 'broadway' | 'west-end'): string {
  return getSourcesForMarket(market).map(s => s.name).join(', ');
}
