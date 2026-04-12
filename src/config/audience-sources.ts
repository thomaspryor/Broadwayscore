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
  /** Short name for compact card display (falls back to name) */
  shortName?: string;
  volumeLabel: string;
  iconColor: string;
  markets: ('broadway' | 'west-end' | 'off-broadway' | 'off-west-end')[];
  /** Whether this source shows starRating (X/5) instead of percentage */
  showStarRating?: boolean;
}

export const AUDIENCE_SOURCES: AudienceSourceConfig[] = [
  { key: 'showScore', name: 'Show Score', volumeLabel: 'reviews', iconColor: 'text-yellow-400', markets: ['broadway', 'west-end', 'off-broadway', 'off-west-end'] },
  { key: 'mezzanine', name: 'Mezzanine', volumeLabel: 'reviews', iconColor: 'text-purple-400', markets: ['broadway', 'west-end', 'off-broadway', 'off-west-end'], showStarRating: true },
  { key: 'seatplan', name: 'SeatPlan', volumeLabel: 'reviews', iconColor: 'text-cyan-400', markets: ['west-end', 'off-west-end'], showStarRating: true },
  { key: 'lbo', name: 'London Box Office', shortName: 'London BO', volumeLabel: 'reviews', iconColor: 'text-emerald-400', markets: ['west-end', 'off-west-end'], showStarRating: true },
  { key: 'ltd', name: 'London Theatre Direct', shortName: 'London TD', volumeLabel: 'reviews', iconColor: 'text-rose-400', markets: ['west-end', 'off-west-end'], showStarRating: true },
  { key: 'theatr', name: 'Theatr', volumeLabel: 'votes', iconColor: 'text-teal-400', markets: ['broadway', 'off-broadway'] },
  { key: 'broadwayCom', name: 'Broadway.com', shortName: 'Bway.com', volumeLabel: 'reviews', iconColor: 'text-blue-400', markets: ['broadway', 'off-broadway'], showStarRating: true },
  { key: 'reddit', name: 'Reddit', volumeLabel: 'mentions', iconColor: 'text-orange-400', markets: ['broadway', 'west-end', 'off-broadway', 'off-west-end'] },
];

export function getSourcesForMarket(market: 'broadway' | 'west-end' | 'off-broadway' | 'off-west-end'): AudienceSourceConfig[] {
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
  reddit: 'Sentiment analysis from Reddit theatre communities (r/Broadway, r/TheWestEnd). Requires 50+ comments. Excluded for shows closed 3+ years.',
  seatplan: 'UK theatre ticketing platform with 1K-8K verified audience reviews per show.',
  lbo: 'Verified purchase reviews from London Box Office ticket buyers via Feefo.',
  ltd: 'Verified purchase reviews from London Theatre Direct, a major UK ticket reseller with 1K-14K reviews per show.',
};

export function getSourceNames(market: 'broadway' | 'west-end' | 'off-broadway' | 'off-west-end'): string {
  return getSourcesForMarket(market).map(s => s.name).join(', ');
}
