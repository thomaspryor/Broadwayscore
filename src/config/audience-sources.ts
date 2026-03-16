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
