/** Audience grade shape shared across all page client interfaces */
export interface AudienceGrade {
  grade: string;
  label: string;
  color: string;
  textColor: string;
  tooltip: string;
}

/**
 * Union type for show data passed to ShowListCard and MiniShowCard.
 * All 4 page clients (Home, OB, WE, Browse) pass objects conforming to this shape.
 * Optional fields cover market-specific data (isOffWestEnd for WE, performances for Browse).
 */
export interface ShowCardShow {
  id: string;
  slug: string;
  title: string;
  openingDate: string;
  closingDate?: string;
  status: string;
  type: string;
  isRevival?: boolean;
  reviewYearNote?: string;
  images?: { thumbnail?: string; poster?: string; hero?: string };
  criticScore?: { score?: number; reviewCount?: number; tier1Count?: number; tier2Count?: number };
  audienceCombinedScore: number | null;
  audienceGrade: AudienceGrade | null;
  category?: string; // undefined for legacy Broadway shows — defaults to 'broadway'
  subtitle?: string; // e.g. "$10 lottery" — shown below title on shelf cards
  subtitleColor?: string; // Tailwind text color class (default: emerald-400)
  // Market-specific optional fields
  isOffWestEnd?: boolean; // West End only
  performances?: number; // Browse only
}

export type ScoreModeParam = 'critics' | 'audience';
