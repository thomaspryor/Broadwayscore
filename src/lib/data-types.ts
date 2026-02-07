// Shared types for the data module split
// NO runtime code, NO JSON imports — types are erased at compile time

import type { ComputedShow } from './engine';
import type { BrowsePageConfig } from '@/config/browse-pages';

// Re-export engine types
export type {
  ComputedShow,
  ComputedReview,
  CriticScoreResult,
  AudienceScoreResult,
  BuzzScoreResult,
  ConfidenceResult,
  RawShow,
  RawReview,
  RawAudience,
  RawBuzzThread,
  ShowImages,
  TicketLink,
  CreativeMember,
  ComputedAudience,
} from './engine';

// Re-export config types
export type { BrowsePageConfig } from '@/config/browse-pages';
export type { CommercialDesignation, RecoupmentTrend, DesignationConfig } from '@/config/commercial';

// ============================================
// Core types
// ============================================

export interface Director {
  name: string;
  slug: string;
  shows: ComputedShow[];
  avgScore: number | null;
  showCount: number;
}

export interface Theater {
  name: string;
  slug: string;
  address?: string;
  currentShow?: ComputedShow;
  allShows: ComputedShow[];
  showCount: number;
}

export type BestOfCategory = 'musicals' | 'plays' | 'new-shows' | 'highest-rated' | 'family' | 'comedy' | 'drama';

export interface BestOfList {
  category: BestOfCategory;
  title: string;
  description: string;
  shows: ComputedShow[];
}

export interface BrowseList {
  config: BrowsePageConfig;
  shows: ComputedShow[];
}

// ============================================
// Grosses types
// ============================================

export interface ShowGrosses {
  thisWeek?: {
    gross: number | null;
    grossPrevWeek: number | null;
    grossYoY: number | null;
    capacity: number | null;
    capacityPrevWeek: number | null;
    capacityYoY: number | null;
    atp: number | null;
    atpPrevWeek: number | null;
    atpYoY: number | null;
    attendance: number | null;
    performances: number | null;
  };
  allTime: {
    gross: number | null;
    performances: number | null;
    attendance: number | null;
  };
  lastUpdated?: string;
}

// ============================================
// Awards types
// ============================================

export interface TonyAwards {
  season: string;
  ceremony: string;
  nominations?: number;
  wins?: string[];
  nominatedFor?: string[];
  eligible?: boolean;
  note?: string;
}

export interface DramaDeskAwards {
  season: string;
  wins: string[];
  nominations: string[] | number;
}

export interface OuterCriticsCircleAwards {
  season: string;
  wins: string[];
  nominations: number;
}

export interface DramaLeagueAwards {
  season: string;
  wins: string[];
}

export interface PulitzerPrize {
  year: number;
  category: string;
}

export interface ShowAwards {
  tony?: TonyAwards;
  dramadesk?: DramaDeskAwards;
  outerCriticsCircle?: OuterCriticsCircleAwards;
  dramaLeague?: DramaLeagueAwards;
  pulitzer?: PulitzerPrize;
  note?: string;
}

export type AwardsDesignation =
  | 'sweeper'
  | 'lavished'
  | 'recognized'
  | 'nominated'
  | 'shut-out'
  | 'pre-season';

// ============================================
// Audience Buzz types
// ============================================

export type AudienceBuzzDesignation = 'Loving' | 'Liking' | 'Shrugging' | 'Loathing';

export interface AudienceBuzzSource {
  score: number;
  reviewCount: number;
  starRating?: number;
}

export interface AudienceBuzzData {
  title: string;
  designation: AudienceBuzzDesignation;
  combinedScore: number;
  sources: {
    showScore: AudienceBuzzSource | null;
    mezzanine: AudienceBuzzSource | null;
    reddit: AudienceBuzzSource | null;
  };
}

// ============================================
// Commercial / Biz types
// ============================================

export type CostMethodologyType =
  | 'reddit-standard'
  | 'trade-reported'
  | 'sec-filing'
  | 'producer-confirmed'
  | 'deep-research'
  | 'industry-estimate';

export interface DeepResearchMetadata {
  verifiedFields: string[];
  verifiedDate: string;
  verifiedBy?: string;
  notes?: string;
}

export interface ShowCommercial {
  designation: import('@/config/commercial').CommercialDesignation;
  capitalization: number | null;
  capitalizationSource: string | null;
  capitalActual?: number;
  capitalActualSource?: string;
  weeklyRunningCost: number | null;
  recouped: boolean | null;
  recoupedDate: string | null;
  recoupedWeeks: number | null;
  recoupedSource?: string | null;
  nonprofitOrg?: string;
  notes?: string;
  estimatedRecoupmentPct?: [number, number] | null;
  estimatedRecoupmentSource?: string | null;
  estimatedRecoupmentDate?: string | null;
  weeklyRunningCostSource?: string | null;
  isEstimate?: {
    capitalization?: boolean;
    weeklyRunningCost?: boolean;
    recouped?: boolean;
  };
  productionType?: 'original' | 'tour-stop' | 'return-engagement';
  originalProductionId?: string;
  costMethodology?: CostMethodologyType;
  profitMargin?: number | null;
  investorMultiple?: number | null;
  insiderProfitSharePct?: number | null;
  sources?: Array<{
    type: 'trade' | 'reddit' | 'sec' | 'manual';
    url: string;
    date: string;
    excerpt?: string;
  }>;
  deepResearch?: DeepResearchMetadata;
}

export interface SeasonStats {
  season: string;
  capitalAtRisk: number;
  recoupedCount: number;
  totalShows: number;
  recoupedShows: string[];
}

export interface ApproachingRecoupmentShow {
  slug: string;
  title: string;
  season: string;
  capitalization: number;
  estimatedRecoupmentPct: [number, number];
  trend: import('@/config/commercial').RecoupmentTrend;
  weeklyGross: number | null;
}

export interface AtRiskShow {
  slug: string;
  title: string;
  season: string;
  capitalization: number;
  weeklyGross: number;
  weeklyRunningCost: number;
  trend: import('@/config/commercial').RecoupmentTrend;
}

export interface RecentRecoupmentShow {
  slug: string;
  title: string;
  season: string;
  weeksToRecoup: number;
  capitalization: number;
  recoupDate: string;
}

export interface RecentClosing {
  slug: string;
  title: string;
  closingDate: string;
  designation: import('@/config/commercial').CommercialDesignation;
  wasFlop: boolean;
}

export interface UpcomingClosing {
  slug: string;
  title: string;
  closingDate: string;
  designation: import('@/config/commercial').CommercialDesignation;
}

// ============================================
// Critic Consensus types
// ============================================

export interface CriticConsensus {
  text: string;
  lastUpdated: string;
  reviewCount: number;
}

// ============================================
// Lottery / Rush types
// ============================================

export interface LotteryInfo {
  type: string;
  platform: string;
  url: string;
  price: number;
  time: string;
  instructions: string;
}

export interface RushInfo {
  type: string;
  platform?: string;
  url?: string;
  price: number;
  time: string;
  location?: string;
  instructions: string;
}

export interface StandingRoomInfo {
  price: number;
  time: string;
  instructions: string;
}

export interface SpecialLotteryInfo {
  name: string;
  platform: string;
  url: string;
  price: number;
  instructions: string;
}

export interface ShowLotteryRush {
  lottery: LotteryInfo | null;
  rush: RushInfo | null;
  digitalRush?: RushInfo | null;
  studentRush?: RushInfo | null;
  standingRoom: StandingRoomInfo | null;
  specialLottery?: SpecialLotteryInfo | null;
}

// Cast Changes
export interface CastMember {
  name: string;
  role: string;
  since?: string;
}

export interface CastEvent {
  type: 'departure' | 'arrival' | 'absence' | 'note';
  name: string;
  role: string;
  date?: string;
  endDate?: string;
  dates?: string[];
  note?: string;
  sourceUrl?: string;
  sourceType?: string;
  addedDate?: string;
}

export interface ShowCastChanges {
  currentCast?: CastMember[];
  upcoming?: CastEvent[];
}
