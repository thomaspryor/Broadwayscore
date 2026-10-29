// Shared types for the data module split
// NO runtime code, NO JSON imports — types are erased at compile time

import type { ComputedShow } from './engine';
import type { BrowsePageConfig } from '@/config/browse-pages';

// Re-export engine types
export type {
  ComputedShow,
  ComputedShowWithReviews,
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

export type SeatingVerdict = 'sweet-spot' | 'solid' | 'skip';
export type SeatingPriceTier = 'budget' | 'mid' | 'premium' | 'top';
export type SeatingHazardType =
  | 'mezz-overhang'
  | 'pillar'
  | 'obstructed-view'
  | 'side-angle'
  | 'steep-rake'
  | 'tight-legroom'
  | 'distant'
  | 'partial-stage'
  | 'sound-dead-spot';

export interface SeatingHazard {
  type: SeatingHazardType;
  note?: string;
}

export type SeatingShowTag = 'musical' | 'play' | 'dance-heavy' | 'spectacle' | 'intimate-drama';

export interface SeatingSection {
  name: string;
  rowRange?: string;
  /** The single sweetest row within the range, if there's a clear pick (e.g. "Row L"). Only for sweet-spot sections. */
  bestRow?: string;
  verdict: SeatingVerdict;
  verdictLabel: string;
  priceTier?: SeatingPriceTier;
  /** Exactly one section per theater should be flagged true — best bang-for-buck, orthogonal to sweet-spot. */
  isValuePick?: boolean;
  rationale?: string;
  hazards?: SeatingHazard[];
  bestFor?: SeatingShowTag[];
  worstFor?: SeatingShowTag[];
  dataPoints?: number;
  evidenceUrls?: string[];
}

export interface TheaterStructuredTips {
  lastUpdated: string;
  seating?: {
    bestSeats?: string;
    avoidSeats?: string;
    accessibility?: string;
    sections?: SeatingSection[];
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
    nearestSubway?: string | null;
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
    /**
     * Offered seats for the week (per-perf offered × perfs). Sourced from BWW
     * column "ATTEND. / CAPACITY" second token. Varies with production
     * configuration — Circle in the Square's Just In Time offers ~690 seats/perf,
     * not the room's nominal max. RevPAS = gross ÷ seatsOffered.
     * Populated for weeks scraped on/after 2026-07-12; earlier weeks are null.
     */
    seatsOffered?: number | null;
    performances: number | null;
  };
  allTime: {
    gross: number | null;
    performances: number | null;
    attendance: number | null;
  };
  /** 'history' when allTime is this production's weekly League rows summed (BRO-5016). */
  allTimeSource?: 'history';
  /**
   * This production's own weekly League rows summed, when its all-time row
   * was a total over several runs (cleared) and the weekly history does not
   * reach back to its first preview. Totals since week ending `since`
   * (YYYY-MM-DD). Shown only on the show's own card, never ranked (BRO-5016).
   */
  partialRun?: {
    gross: number | null;
    performances: number | null;
    attendance: number | null;
    since: string;
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
  /** Tony-cat-matching nominations, populated by enrich-awards-with-precursors.js.
   *  Used by the Tony Predictions Awards Score formula.
   *  NOT a count of total DD nominations — for that use `nominations`. */
  nominatedFor?: string[];
  /** Total nominations across all DD categories (count, from canonical scrape). */
  nominations: string[] | number;
}

export interface OuterCriticsCircleAwards {
  season: string;
  wins: string[];
  /** See note on DramaDeskAwards.nominatedFor. */
  nominatedFor?: string[];
  nominations: number;
}

export interface DramaLeagueAwards {
  season: string;
  wins: string[];
  /** See note on DramaDeskAwards.nominatedFor. */
  nominatedFor?: string[];
  /** Per-award winner names (for awards that go to a specific performer
   *  rather than a show, e.g. "Distinguished Performance Award"). Used by
   *  the Tony Nominations Center chip-render to attribute the DL chip to
   *  the actual performer rather than every acting nominee from that show.
   *  Key = award category string (matches an entry in `wins`).
   *  Value = list of winner names (array for tie support). */
  winnerNames?: Record<string, string[]>;
}

/** NY Drama Critics' Circle Awards. Winners only — NYDCCC does not publish a
 *  full nominee list. `nominatedFor` is populated by the shared enrichment
 *  helper for symmetry with DD/OCC/DL types, and for NYDCCC it always equals
 *  `wins` (since every recognized show is a winner). Don't use it as a "they
 *  were nominated but didn't win" signal — that signal doesn't exist for NYDCCC. */
export interface NyDramaCriticsAwards {
  season: string;
  wins: string[];
  nominatedFor?: string[];
  /** True when the Critics' Circle voted to give no award in this category that
   *  year. When present, this entry contributes 0 to the awards score and the
   *  UI renders a "No award given" chip instead of a winner name. */
  noAward?: boolean;
}

/** Pulitzer Prize for Drama. Single category ("Drama"), so `wins` and
 *  `finalist` arrays will at most contain `["Drama"]`. `year` is the calendar
 *  year of the prize (matches Wikipedia ceremony year). */
export interface PulitzerPrize {
  wins?: string[];
  finalist?: string[];
  year?: number;
}

/** Obie Award (Village Voice Off-Broadway Theater Award, 1956–2019).
 *  Covers Off-Broadway and Off-Off-Broadway productions. */
export interface ObieAwards {
  season?: string;
  wins: string[];
  nominatedFor?: string[];
  nominations?: number;
}

/** Critics' Circle Theatre Award (UK/West End, 1990–present). */
export interface CriticsCircleAwards {
  season?: string;
  wins: string[];
  nominatedFor?: string[];
  nominations?: number;
}

/** Lucille Lortel Award (Off-Broadway Theater Award, 1986–present). */
export interface LortelAwards {
  season?: string;
  wins: string[];
  nominatedFor?: string[];
  nominations?: number;
}

/** Off Broadway Alliance Award (industry-voted, 2011–present, annual).
 *  Categories: Best New Musical, Best New Play, Best Revival (or split into
 *  Best Musical Revival / Best Play Revival in some years), Best Solo
 *  Performance, Best Unique Theatrical Experience, Best Family Show.
 *  Source: Playbill annual round-up articles; see scripts/scrape-off-broadway-alliance.js. */
export interface OffBroadwayAllianceAwards {
  season?: string;
  wins: string[];
  nominatedFor?: string[];
  nominations?: number;
}

/** Evening Standard Theatre Awards (UK/West End, 1955–present). Second-most
 *  prestigious WE award after the Olivier. Per-category Wikipedia pages
 *  exist for Best Play, Best Actor, Best Actress (no Best Musical page).
 *  Ceremonies identified by ordinal ("Nth"); see scripts/lib/evening-standard-parser.js. */
export interface EveningStandardAwards {
  season?: string;
  wins: string[];
  nominatedFor?: string[];
  nominations?: number;
}

/** WhatsOnStage Awards (UK, 2001–present). Audience-voted (not critic-voted)
 *  WE/OWE award. Per-year Wikipedia pages (one wikitable per ceremony) with
 *  paired-column category layout; see scripts/lib/whatsonstage-parser.js. */
export interface WhatsOnStageAwards {
  season?: string;
  wins: string[];
  nominatedFor?: string[];
  nominations?: number;
}

/** Olivier Award (UK/West End, 1976–present) — the West End's Tony
 *  equivalent. Source: scripts/enrich-olivier-awards.js (Wikipedia). */
export interface OlivierAwards {
  season?: string;
  ceremony?: string;
  wins?: string[];
  nominatedFor?: string[];
  nominations?: number;
  note?: string;
}

export interface ShowAwards {
  tony?: TonyAwards;
  olivier?: OlivierAwards;
  dramadesk?: DramaDeskAwards;
  outerCriticsCircle?: OuterCriticsCircleAwards;
  dramaLeague?: DramaLeagueAwards;
  nyDramaCritics?: NyDramaCriticsAwards;
  obie?: ObieAwards;
  lortel?: LortelAwards;
  oba?: OffBroadwayAllianceAwards;
  criticsCircle?: CriticsCircleAwards;
  eveningStandard?: EveningStandardAwards;
  whatsOnStage?: WhatsOnStageAwards;
  pulitzer?: PulitzerPrize;
  /** Legacy shape — newer entries fold finalists into pulitzer.finalist. Some
   *  pre-migration entries (e.g. Stereophonic 2024) still use this. */
  pulitzerFinalist?: { year?: number; note?: string };
  note?: string;
}

export type AwardsDesignation =
  | 'sweeper'
  | 'lavished'
  | 'recognized'
  | 'nominated'
  | 'shut-out'
  | 'pre-season'
  | 'ineligible';

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
  /**
   * Set by neutralize-contaminated-reddit-buzz.js when a generic-title source
   * (e.g. Reddit on "Fear & Wonder") is contaminated by unrelated matches. The
   * combined score is already recomputed without it; display layers must also
   * hide the tile. Self-clears on the next clean scrape.
   */
  suppressed?: boolean;
  suppressedReason?: string;
  suppressedAt?: string;
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
  /** Dated evidence for the return label; Trickle can fall back to its recoupment date. */
  returnSnapshotAsOf?: string | null;
  capitalization: number | null;
  capitalizationSource: string | null;
  /** What the figure is: a Form D/"up to" ceiling, the amount sold, or a stated capitalization (BRO-5660). Absent: read from the source wording. */
  capitalizationBasis?: 'maximum' | 'sold' | 'reported';
  capitalActual?: number;
  capitalActualSource?: string;
  weeklyRunningCost: number | null;
  recouped: boolean | null;
  recoupedDate: string | null;
  recoupedWeeks: number | null;
  recoupedSource?: string | null;
  /** Owner-reviewed editorial keep (Q3 policy) — survives CI merges. */
  humanReviewedDesignation?: boolean;
  /** What a loss label rests on (owner policy B, BRO-5020). Anything but 'reported-loss' prints a caveat (lossBasisCaveat). */
  designationBasis?: 'reported-loss' | 'no-recoupment-announced' | 'notes-stated' | 'model-estimate';
  /** likelyOutcomeLine() of the full record, set at load ("Likely: Flop"); never stored in commercial.json. */
  likelyOutcome?: string | null;
  /** What likelyOutcome rests on (likelyOutcomeBasis()): an outside estimate or our model. */
  likelyOutcomeBasis?: 'estimate' | 'model' | null;
  nonprofitOrg?: string;
  /** A nonprofit run's switch to a commercial run; date null when not reported (BRO-5508, scripts/lib/commercial-conversion.js). */
  commercialConversion?: { date: string | null; sourceUrl: string | null } | null;
  notes?: string;
  estimatedRecoupmentPct?: [number, number] | null;
  estimatedRecoupmentSource?: string | null;
  estimatedRecoupmentDate?: string | null;
  weeklyRunningCostSource?: string | null;
  /** What the cited weekly cost is: fixed running costs, a breakeven gross, or an all-in operating expense (BRO-5093). */
  weeklyRunningCostBasis?: 'running' | 'breakeven' | 'all-in';
  isEstimate?: {
    capitalization?: boolean;
    weeklyRunningCost?: boolean;
    recouped?: boolean;
    /** The recoupedDate is our estimate (the source reports the recoupment, not when): prints "~", no weeks counted (BRO-5568). */
    recoupedDate?: boolean;
  };
  productionType?: 'original' | 'tour-stop' | 'return-engagement' | 'enhancement' | 'international-transfer';
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
  /** Set when the display guard hid the model bar (BRO-4989): why. */
  modelDisplayHold?: 'no-model' | 'star-deal-unknown' | 'few-weeks' | 'out-of-bounds' | 'estimates-disagree' | 'too-uncertain' | 'awaiting-truth' | 'past-100-unannounced' | 'estimated-recouped';
  /** "% returned so far" run (scripts/lib/model-run-fields.js): a running show's NY tax credit only once cited. */
  modelReturnedExCreditPct?: [number, number, number] | null;
  /** Investor return multiple after the producers' share, same order (scripts/lib/model-run-fields.js). */
  modelInvestorMultiple?: [number, number, number] | null;
  /** NY tax credit inside modelReturnedExCreditPct ($); above 0 = post-credit. */
  modelTaxCreditCounted?: number | null;
  /** Tax-credit basis of the displayed model figure (displayBasis, BRO-5073); null/absent while running bars are off. */
  modelCreditBasis?: 'pre-credit' | 'post-credit' | null;
  /** The model central is below 0 (lost money running so far): shown as 0% with "losing money so far". */
  modelBelowCosts?: boolean;
  /** BRO-5313: a closed show's trade-reported % returned to investors (scripts/lib/reported-return.js); null/absent unless a named outlet states the figure. */
  reportedReturn?: { lo: number; hi: number; outlet: string; asOf: string | null } | null;
  /** Server-only: the range the display guard hid, for the At Risk rule. Pages get publicHeldRange's central figure only. */
  modelHeldRange?: [number, number, number] | null;
  /** u/Boring_Waltz_9545's newest "Estimated percentage recouped" [low, high] (scripts/lib/waltz-recoup-estimates.js, BRO-5502). */
  analystRecoupPct?: [number, number] | null;
  /** Date of the post that figure came from (YYYY-MM-DD). */
  analystRecoupAsOf?: string | null;
  /** That post. */
  analystRecoupUrl?: string | null;
  /** Our own estimate as a rounded [low, high] (BRO-6245). Used only when there is no analystRecoupPct; credited as "Our estimate". */
  ourEstimateRangePct?: [number, number] | null;
  /** Owner-set estimate, ahead of analyst/model figures; research never writes these (BRO-6215). */
  ourRecoupEstimatePct?: number | [number, number] | null;
  ourRecoupEstimateAsOf?: string | null;
  modelRecouped?: boolean | null;
  modelBreakeven?: number | null;
  modelCostBasis?: number | null;
  modelDataQuality?: 'high' | 'medium' | 'low';
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated';
  modelCategory?: string;
  modelLastRun?: string;
  modelWarnings?: string[];
  /** Model inputs that are guesses or fallbacks (BRO-5849); server-side, the page gets estimatedInputs. */
  /** Page-safe wording for the guessed inputs (estimatedInputNotes). */
  estimatedInputs?: string[];
  /** Model-only comparables guess standing in for a missing capitalization (BRO-5849); never `capitalization`. */
  modelCapitalizationEstimate?: { value: number; low: number; high: number; n: number };
  modelInputBasis?: Array<{ input: 'capitalization' | 'weeklyRunningCost'; basis: 'estimate' | 'ceiling' | 'type-default' | 'comparables' }>;
  modelDesignationFlag?: string;
}

export interface SeasonStats {
  season: string;
  /** Running (open/previews), unrecouped commercial shows. Unknown caps are counted as undisclosed, never $0. */
  capitalAtRisk: import('./commercial-metrics').CapitalSummary;
  /** Every commercial show in the season (nonprofits and tour stops excluded). */
  totalCapital: import('./commercial-metrics').CapitalSummary;
  recoupedCount: number;
  /** Commercial shows with a known outcome: the denominator of recoupedCount (BRO-6354). */
  totalShows: number;
  recoupedShows: string[];
}

export interface ApproachingRecoupmentShow {
  slug: string;
  title: string;
  season: string;
  capitalization: number | null;
  /** isEstimatedCapitalization(): true when the record flags its capitalization as an estimate or cites no publishable source (prints "~"). */
  capitalizationIsEstimate: boolean;
  /** A Form D maximum or "up to" figure: prints "up to $X" (BRO-5660). */
  capitalizationIsMaximum: boolean;
  /** Model [pessimistic, central, optimistic] that cleared the display quality floor; pessimistic >= 50. */
  modelRecoupmentPct: [number, number, number];
  modelMethod?: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
  trend: import('@/config/commercial').RecoupmentTrend;
  weeklyGross: number | null;
}

export interface AtRiskShow {
  slug: string;
  title: string;
  season: string;
  capitalization: number | null;
  /** isEstimatedCapitalization(): true when the record flags its capitalization as an estimate or cites no publishable source (prints "~"). */
  capitalizationIsEstimate: boolean;
  /** A Form D maximum or "up to" figure: prints "up to $X" (BRO-5660). */
  capitalizationIsMaximum: boolean;
  /** Trailing 4-week average gross. */
  avgWeeklyGross: number;
  /** getBreakEven(): model break-even above the quality floor, else weekly running cost. */
  breakEven: number;
  /** Model [pessimistic, central, optimistic]; optimistic < 30. */
  modelRecoupmentPct: [number, number, number];
  /** getModelHoldLabel(): set when the guard hid the model; the card prints it instead of the %. */
  modelHoldLabel: string | null;
  trend: import('@/config/commercial').RecoupmentTrend;
  /** shows.json closingDate (YYYY-MM-DD) when it is still ahead, else null (a passed date on an open show is not an announcement). */
  closingDate: string | null;
}

export interface RecentRecoupmentShow {
  slug: string;
  title: string;
  season: string;
  /** null when only the recoupment year is known (calculateWeeksToRecoup). */
  weeksToRecoup: number | null;
  /** weeksToRecoup is our estimate (RECOUPED_DURING_RUN_ESTIMATE), not a measured figure. */
  weeksIsEstimate: boolean;
  /** Per-show tooltip for the estimate (RECOUPED_DURING_RUN_ESTIMATE); null when weeksIsEstimate is false. */
  weeksEstimateNote: string | null;
  /** Recoupment reported after the Broadway run closed (recoupReportedAfterClosing): weeksToRecoup is null by design. */
  reportedAfterClosing: boolean;
  /** weeksToRecoup counts from the switch to a commercial run, not opening night (recoupClockStart). */
  fromCommercialRun: boolean;
  capitalization: number | null;
  /** isEstimatedCapitalization(): true when the record flags its capitalization as an estimate or cites no publishable source (prints "~"). */
  capitalizationIsEstimate: boolean;
  /** A Form D maximum or "up to" figure: prints "up to $X" (BRO-5660). */
  capitalizationIsMaximum: boolean;
  recoupDate: string;
  /** recoupDate is our estimate: prints "~" (BRO-5568). */
  recoupDateIsEstimate: boolean;
}

/** One row of the /biz and /biz/season tables (AllShowsTable). */
export interface CommercialShowRow {
  slug: string;
  title: string;
  /** shows.json status ('open' | 'previews' | 'closed' | ...). */
  status: string;
  designation: import('@/config/commercial').CommercialDesignation;
  capitalization: number | null;
  /** isEstimatedCapitalization(): true when the record flags its capitalization as an estimate or cites no publishable source (prints "~"). */
  capitalizationIsEstimate: boolean;
  /** A Form D maximum or "up to" figure: prints "up to $X" (BRO-5660). */
  capitalizationIsMaximum: boolean;
  /** Latest week's gross; null for closed shows. */
  weeklyGross: number | null;
  /** Latest week's capacity (%) and average ticket price; null for closed shows. */
  weeklyCapacity: number | null;
  weeklyAtp: number | null;
  /** Recorded weekly running cost (null when none). */
  weeklyCost: number | null;
  /** isEstimatedRunningCost(): prints "~". */
  weeklyCostIsEstimate: boolean;
  /** weeklyRunningCostBasis: breakeven and all-in figures get a caption (BRO-5109). */
  weeklyCostBasis: 'running' | 'breakeven' | 'all-in' | null;
  /** getNonprofitProducer(): nonprofit company behind the production, else null. */
  nonprofitOrg: string | null;
  /** ShowCommercial.commercialConversion: the nonprofit run became a commercial run (BRO-5508). */
  commercialConversion?: ShowCommercial['commercialConversion'];
  totalGross: number | null;
  modelRecoupmentPct: [number, number, number] | null;
  /** ShowCommercial.modelBelowCosts: the bar reads 0% with "losing money so far". */
  modelBelowCosts?: boolean;
  /** ShowCommercial.modelDisplayHold: why the guard hid the bar (getModelHoldLabel). */
  modelDisplayHold?: ShowCommercial['modelDisplayHold'];
  /** publicHeldRange: the held model's central figure, for the analyst + model range (getDisplayableEstimateRange). */
  modelHeldRange?: ShowCommercial['modelHeldRange'];
  /** 'enhancement' marks a nonprofit production with commercial money to recoup. */
  productionType?: ShowCommercial['productionType'] | null;
  /** The analyst's estimate (ShowCommercial.analystRecoupPct/AsOf/Url, BRO-5502). */
  analystRecoupPct?: ShowCommercial['analystRecoupPct'];
  analystRecoupAsOf?: string | null;
  analystRecoupUrl?: string | null;
  ourEstimateRangePct?: ShowCommercial['ourEstimateRangePct'];
  ourRecoupEstimatePct?: ShowCommercial['ourRecoupEstimatePct'];
  ourRecoupEstimateAsOf?: ShowCommercial['ourRecoupEstimateAsOf'];
  /** A closed show's trade-reported % returned (ShowCommercial.reportedReturn). */
  reportedReturn?: ShowCommercial['reportedReturn'];
  modelMethod: 'weekly-model' | 'simplified-lifetime' | 'ai-estimated' | null;
  modelDataQuality?: 'high' | 'medium' | 'low';
  /** Reported investor multiple from a cited record (getReportedInvestorMultiple); never modeled. */
  reportedMultiple: number | null;
  /** getEstimatedReturnRange: our model's [low, high] investor multiple for a win label (BRO-6555). */
  estimatedReturnRange?: [number, number] | null;
  /** recoupedSource after publicSourceText (null when it is internal research text). */
  recoupedSource: string | null;
  /** 'unknown' for closed shows. */
  trend: import('@/config/commercial').RecoupmentTrend;
  recouped: boolean | null;
  /** isUnannouncedRecoupment(): recouped, but never announced (the table says so, like the show page). */
  recoupmentNotAnnounced: boolean;
  recoupedWeeks: number | null;
  /** recoupedWeeks is our estimate (RECOUPED_DURING_RUN_ESTIMATE), not a measured figure. */
  recoupedWeeksIsEstimate: boolean;
  /** Recoupment reported after the run closed (recoupReportedAfterClosing): recoupedWeeks is null by design. */
  recoupReportedAfterClosing: boolean;
  /** lossBasisCaveat(): "Based on no recoupment being announced" for a loss label no source reported, else null. */
  lossCaveat: string | null;
  /** likelyOutcomeLine(): "Likely: Flop" / "Likely: Fizzle" (or "Likely: Recouped" when Undisclosed) where no source says and we have a reading, else null. */
  likelyOutcome: string | null;
  likelyOutcomeBasis: 'estimate' | 'model' | null;
  /** What a loss label rests on (lossOutcomePhrase reads it). */
  designationBasis: ShowCommercial['designationBasis'] | null;
}

export interface RecentClosing {
  slug: string;
  title: string;
  closingDate: string;
  designation: import('@/config/commercial').CommercialDesignation;
  designationBasis: ShowCommercial['designationBasis'] | null;
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
  type: 'departure' | 'arrival' | 'absence' | 'note' | 'closure';
  name: string;
  role: string;
  date?: string;
  endDate?: string;
  dates?: string[];
  note?: string;
  sourceUrl?: string;
  sourceType?: string;
  addedDate?: string;
  /** No usable date/endDate was extracted (an [AUTO-FLAGGED] cast-page diff
   * has none by design; an article extraction may simply have failed to find
   * one) — consumers should skip it as not-currently-newsworthy rather than
   * treat the missing date as a data bug. Not a claim that the date can
   * never be recovered. See BRO-1297. */
  incomplete?: boolean;
}

export interface CastHistoryEntry {
  name: string;
  role: string;
  since?: string;
  until?: string;
  note?: string;
  sourceUrl?: string;
  sourceType?: string;
}

export interface ShowCastChanges {
  currentCast?: CastMember[];
  upcoming?: CastEvent[];
  // Past stints no longer in currentCast, written by
  // scripts/scrape-cast-changes.js:cleanExpiredEvents. Surfaced on the show
  // page via getCastChanges() (data-cast.ts) + CastUpdatesCard's "Previously
  // in This Show" section — NOT read by the /cast-changes aggregator page,
  // which only shows live upcoming events.
  history?: CastHistoryEntry[];
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
  showCategory: string;
  outletId: string;
  outlet: string;
  outletSlug: string;
  criticName: string | null;
  criticSlug: string | null;
  url: string;
  publishDate: string | null;
  parsedDate: number | null;
  reviewScore: number;
  tier: 1 | 2 | 3 | 4;
  originalRating: string | null;
  quote: string | null;
}

export interface OutletProfile {
  name: string;
  slug: string;
  outletId: string;
  tier: 1 | 2 | 3 | 4;
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
