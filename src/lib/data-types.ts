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
export type { GoldListType, GoldListConfig } from '@/config/gold-lists';

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

// Theater Tips structured data
export interface TheaterTipRestaurant {
  name: string;
  cuisine?: string;
  walkMinutes?: number;
  priceRange?: string;  // "$", "$$", "$$$", "$$$$"
  notes?: string;
}

export interface TheaterTipGarage {
  name: string;
  walkMinutes?: number;
  notes?: string;
}

export interface TheaterStructuredTips {
  lastUpdated: string;
  seating?: {
    bestSeats?: string;
    avoidSeats?: string;
    accessibility?: string;
  };
  parking?: {
    nearestGarages?: TheaterTipGarage[];
    streetParking?: string;
    tip?: string;
  };
  dining?: {
    preShow?: TheaterTipRestaurant[];
    postShow?: TheaterTipRestaurant[];
    quickBite?: TheaterTipRestaurant[];
  };
  logistics?: {
    entrance?: string;
    nearestSubway?: string;
    exitStrategy?: string;
    restrooms?: string;
  };
}

export interface TheaterVenueScores {
  sightlines?: number;  // 1-5
  sound?: number;       // 1-5
  comfort?: number;     // 1-5
  ambiance?: number;    // 1-5
  facilities?: number;  // 1-5
  overall?: number;     // computed average of non-null dimensions
  summary?: string;
  sources?: string[];
  lastResearched?: string;
}

export interface TheaterAccessibility {
  wheelchair?: boolean;
  hearingLoop?: boolean;
  elevator?: boolean;
  assistiveListening?: boolean;
  verified?: boolean;
  notes?: string;
}

export interface TheaterExternalLinks {
  seatplan?: string;
  aviewfrommyseat?: string;
}

export interface Theater {
  name: string;
  slug: string;
  address?: string;
  capacity?: number;
  yearBuilt?: number;
  operator?: string;
  formerNames?: string[];
  tips?: string;
  structuredTips?: TheaterStructuredTips;
  images?: {
    exterior?: string;
    interior?: string;
    attribution?: string;
  };
  venueScores?: TheaterVenueScores;
  accessibility?: TheaterAccessibility;
  externalLinks?: TheaterExternalLinks;
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

export type AudienceBuzzDesignation = 'Loving' | 'Liking' | 'Shrugging' | 'Disliking' | 'Loathing';

export interface AudienceBuzzSource {
  score: number;
  reviewCount: number;
  starRating?: number;
  totalPosts?: number;
  totalComments?: number;
  /** Resolved URL for the platform's audience review page (stored by scrapers) */
  url?: string;
}

export interface AudienceBuzzData {
  title: string;
  designation: AudienceBuzzDesignation;
  combinedScore: number;
  sources: Record<string, AudienceBuzzSource | null>;
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

  // Model-calculated recoupment fields (from merge-model-recoupment.js)
  modelRecoupmentPct?: [number, number, number] | null; // [pessimistic, central, optimistic]
  modelRecouped?: boolean | null;
  modelBreakeven?: number | null;
  modelDataQuality?: 'high' | 'medium' | 'low';
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated';
  modelCategory?: string;
  modelLastRun?: string;
  modelWarnings?: string[];
  modelDesignationFlag?: string;
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
  modelRecoupmentPct?: [number, number, number] | null;
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
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

// Showtimes / Weekly Schedule
export interface DaySchedule {
  m: string | null;  // matinee "HH:MM" (24h) or null
  e: string | null;  // evening "HH:MM" (24h) or null
}
export type WeekSchedule = [DaySchedule, DaySchedule, DaySchedule, DaySchedule, DaySchedule, DaySchedule, DaySchedule];
export interface ShowSchedule {
  weeks: Record<string, WeekSchedule>;  // key = Monday date YYYYMMDD
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

// ============================================
// Gold List types
// ============================================

export interface GoldListEntry {
  showId: string;
  title: string;
  slug: string;
  rank: number;
  /** The metric value (critic score, audience score, gross/perf, capacity %) */
  value: number;
  /** Formatted display string for the value (e.g., "$182,450", "87.1", "98.2%") */
  displayValue: string;
  season: string;
  venue?: string;
  type?: string;
  thumbnail?: string | null;
}

export interface GoldListMembership {
  listType: import('@/config/gold-lists').GoldListType;
  season: string;
  rank: number;
}

// ============================================
// Outlet & Critic Profile types
// ============================================

export interface ProfileReview {
  showTitle: string;
  showSlug: string;
  showThumbnail: string | null;
  showVenue: string;
  showOpeningDate: string;
  showStatus: string;
  showType: string;
  outletId: string;
  outlet: string;
  outletSlug: string;
  criticName: string | null;
  criticSlug: string | null;
  url: string;
  publishDate: string | null;
  parsedDate: number | null;
  reviewScore: number;
  tier: 1 | 2 | 3;
  originalRating: string | null;
  quote: string | null;
}

export interface OutletProfile {
  name: string;
  slug: string;
  outletId: string;
  tier: 1 | 2 | 3;
  reviews: ProfileReview[];
  reviewCount: number;
  avgScore: number;
  highScore: number;
  lowScore: number;
  volumeRank: number;
  generosityRank: number;
  criticCount: number;
  logoDomain: string | null;
  logoColor: string | null;
  logoAbbrev: string | null;
}

export interface CriticProfile {
  name: string;
  slug: string;
  primaryOutlet: string;
  primaryOutletId: string;
  outlets: string[];
  isFreelancer: boolean;
  reviews: ProfileReview[];
  reviewCount: number;
  avgScore: number;
  highScore: number;
  lowScore: number;
  volumeRank: number;
  generosityRank: number;
}

// Creative team page types
export type CreativeCategory = 'director' | 'playwright' | 'composer' | 'lyricist';

export interface CreativeShowEntry {
  title: string;
  slug: string;
  venue: string;
  openingDate: string | null;
  closingDate: string | null;
  status: string;
  type: string;
  thumbnail: string | null;
  isRevival: boolean;
  season: string | null;
  score: number | null;
  role: string;
}

export interface CreativeProfile {
  name: string;
  slug: string;
  category: CreativeCategory;
  roles: string[];
  shows: CreativeShowEntry[];
  showCount: number;
  scoredShowCount: number;
  avgScore: number | null;
  highScore: number | null;
  lowScore: number | null;
  openShowCount: number;
  closedShowCount: number;
}

export interface UnifiedCreativeShowEntry {
  title: string;
  slug: string;
  showId: string;
  venue: string;
  openingDate: string | null;
  closingDate: string | null;
  status: string;
  type: string;
  thumbnail: string | null;
  isRevival: boolean;
  season: string | null;
  score: number | null;
  roles: string[];
}

export interface UnifiedCreativeProfile {
  name: string;
  slug: string;
  categories: CreativeCategory[];
  allRoles: string[];
  shows: UnifiedCreativeShowEntry[];
  showCount: number;
  scoredShowCount: number;
  avgScore: number | null;
  highScore: number | null;
  lowScore: number | null;
  openShowCount: number;
  closedShowCount: number;
}

// ============================================
// Cast Types
// ============================================

export interface CastMemberOBC {
  name: string;
  role: string;
  ibdbPersonId?: string;
  flags?: string[];  // "Broadway debut", "Alternate", "Standby", etc.
}

export interface ShowCastFile {
  showId: string;
  ibdbUrl?: string;
  scrapedAt: string;
  openingNightCast: CastMemberOBC[];
  currentCast?: CastMemberOBC[] | null;
  currentCastUpdatedAt?: string;
  replacements?: CastMemberOBC[] | null;
}

// ============================================
// Actor Profile Types
// ============================================

export interface ActorShowEntry {
  title: string;
  slug: string;
  showId: string;
  role: string;
  castType: 'obc' | 'replacement' | 'current';
  venue: string;
  openingDate: string | null;
  closingDate: string | null;
  status: string;
  type: string;
  thumbnail: string | null;
  isRevival: boolean;
  score: number | null;
  audienceScore: number | null;
  category?: string;
  wasObc?: boolean;
  flags?: string[];
}

export interface ActorProfile {
  name: string;
  slug: string;
  ibdbPersonId: string;
  headshot: string | null;
  shows: ActorShowEntry[];
  showCount: number;
  scoredShowCount: number;
  avgScore: number | null;
  highScore: { score: number; showTitle: string } | null;
  lowScore: { score: number; showTitle: string } | null;
  openShowCount: number;
  closedShowCount: number;
  hasBroadwayDebut: boolean;
}
