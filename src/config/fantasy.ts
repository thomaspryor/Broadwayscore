/**
 * Broadway Fantasy League — Configuration & Types
 *
 * Season constants and point tables live in ./fantasy-season.json so the
 * site, the API routes and the weekly scripts (generate-fantasy-config.js,
 * compute-fantasy-scores.js) all read ONE file. The 2025-26 trial kept two
 * hand-copied sets of constants and they drifted (the draft deadline in
 * fantasy.ts said Dec 31 while the generator said Feb 7).
 */

// Import canonical tier labels from scoring.ts — never hardcode these
import { getCriticLabel } from './scoring';
import seasonConfig from './fantasy-season.json';

// Re-export so consumers can use it
export { getCriticLabel };

// ===========================================
// SEASON CONFIG
// ===========================================

export const FANTASY_SEASON: string = seasonConfig.season;
export const FANTASY_TONY_CEREMONY_YEAR: number = seasonConfig.tonyCeremonyYear;
export const FANTASY_TONY_WINDOW = seasonConfig.tonyWindow as { label: string; start: string; end: string };
export const FANTASY_BUDGET: number = seasonConfig.budget;
/** Maximum roster size. Fewer picks are allowed (the budget is the real constraint). */
export const FANTASY_TEAM_SIZE: number = seasonConfig.teamSize;
export const DRAFT_OPENS: string = seasonConfig.draftOpens;
export const DRAFT_DEADLINE: string = seasonConfig.draftDeadline;
export const SCORING_START: string = seasonConfig.scoringStart;
/**
 * Entries drafted on or before this date (New York time) score box office
 * from SCORING_START. Later entries score box office from the week they
 * draft. See scoringFromDate().
 */
export const EARLY_BIRD_CUTOFF: string = seasonConfig.earlyBirdCutoff;
export const SCORING_END: string = seasonConfig.scoringEnd; // Tony Awards night (provisional until announced)
export const PRIZE_DESCRIPTION: string = seasonConfig.prize;

// ===========================================
// SCORING POINT MAPPINGS
// ===========================================

/**
 * CriticScore tier → fantasy points. Labels must match getCriticLabel() output.
 *
 * Calibrated so CriticScore is ~15-18% of a strong show's total points.
 * A "Critical Gold" show earns 30 pts (vs 180 possible from awards).
 */
export const CRITIC_SCORE_POINTS: Record<string, number> = seasonConfig.scoring.criticScore;

/**
 * AudienceGrade → fantasy points. Grades must match getAudienceGrade() output.
 *
 * Calibrated so AudienceGrade is ~10-12% of a strong show's total.
 */
export const AUDIENCE_GRADE_POINTS: Record<string, number> = seasonConfig.scoring.audienceGrade;

/**
 * Box office: points per $100K weekly gross.
 *
 * At 0.30, a strong musical ($1M/week over 20 weeks) earns ~60 pts.
 * This makes box office ~25% of a Best Musical winner's total.
 */
export const BOX_OFFICE_POINTS_PER_100K: number = seasonConfig.scoring.boxOffice.pointsPer100K;

/**
 * Awards point values — Tonys + pre-Tony ceremonies.
 *
 * Multiple ceremonies create scoring events across 6 weeks (mid-May to mid-June),
 * not just one Tony night. Awards still ~45-50% of a strong show's total.
 *
 * Tony Awards (June): biggest single event — wins weigh 4x a nom;
 *   Best Musical/Play 1.5x a regular win
 * Drama League (mid-May): noms + wins
 * Outer Critics Circle (late May): noms + wins, covers BW + OB
 * Drama Desk (late May/early June): noms + wins, covers BW + OB
 * NY Drama Critics' Circle (early May): wins only (best play, best musical)
 * Lucille Lortel Awards (early May): noms + wins, OB only
 * Obie Awards (late May): special citations, no nom/win format, OB + experimental
 */
export const AWARDS_POINTS = seasonConfig.scoring.awards;

// ===========================================
// TIEBREAKERS
// ===========================================

export const TIEBREAKER_QUESTIONS = [
  { id: 'tony-noms-most', question: 'How many nominations will the most-nominated show receive?', type: 'number' as const },
  { id: 'best-musical-winner', question: 'Which show will win Best Musical?', type: 'show-best-musical' as const },
  { id: 'total-tony-noms', question: 'How many total Tony nominations will there be?', type: 'number' as const },
];

// ===========================================
// ELIGIBILITY MARKERS
// ===========================================

/** Shown on draft form next to show name */
export const ELIGIBILITY_MARKERS = {
  criticScoreLocked: '★',   // CriticScore already public (opened before the season's scoring start)
  offBroadway: '†',          // Off-Broadway (no box office, no Tonys)
};

// ===========================================
// TYPES
// ===========================================

export interface FantasyShowEligibility {
  /** False when the show opened before SCORING_START: its score was public before anyone could draft. */
  criticScore: boolean;
  audienceGrade: boolean;
  boxOffice: boolean;
  tonys: boolean;
}

export interface FantasyShow {
  price: number;
  eligible: FantasyShowEligibility;
  title: string;
  type: 'musical' | 'play' | 'special';
  category: 'broadway' | 'off-broadway';
  status: string;
  openingDate: string | null;
  closingDate?: string | null;
  isRevival?: boolean;
  /** Current CriticScore if available (for draft research) */
  criticScore?: number | null;
  /** Current AudienceGrade if available (for draft research) */
  audienceGrade?: string | null;
  slug: string;
  /** Thumbnail image path */
  image?: string | null;
  /** One-line pricing rationale shown in the Draft Guide */
  priceNote?: string | null;
}

export interface FantasyLeagueConfig {
  _meta: {
    season: string;
    draftDeadline: string;
    scoringStart: string;
    scoringEnd: string;
    earlyBirdCutoff?: string;
    budget: number;
    teamSize: number;
    generatedAt: string;
    pricing?: {
      source?: 'frozen' | 'heuristic';
      method?: 'ev' | 'heuristic' | 'preseason-ev';
      k?: number | null;
      frozenAt?: string | null;
      targetTopPrice?: number;
      evSource?: string | null;
      evLastUpdated?: string | null;
      repricedAt?: string;
    };
  };
  shows: Record<string, FantasyShow>;
  scoring: {
    criticScore: Record<string, number>;
    audienceGrade: Record<string, number>;
    boxOffice: { pointsPer100K: number };
    awards: Record<string, number>;
  };
}

export interface FantasyShowScore {
  criticScorePoints: number;
  audienceGradePoints: number;
  boxOfficePoints: number;
  awardsPoints: number;
  totalPoints: number;
  /** Week-ending date → box office points for that week (season window only). */
  weeklyBoxOffice?: Record<string, number>;
  /** ISO opening date, used for the per-entry CriticScore lock. */
  openingDate?: string | null;
  breakdown: {
    criticTier: string | null;
    audienceGrade: string | null;
    boxOfficeWeeks: number;
    boxOfficeTotal: string;
    awards: string[];
  };
}

export interface FantasyScoresData {
  _meta: {
    lastUpdated: string;
    weekEnding: string;
    season: string;
  };
  showScores: Record<string, FantasyShowScore>;
}

export interface FantasyEntry {
  id: string;
  email: string;
  team_name: string | null;
  league_name: string | null;
  picks: string[]; // show IDs
  total_cost: number;
  season: string;
  created_at: string;
}

export interface LeaderboardEntry {
  id: string;
  rank: number;
  displayName: string; // team_name or masked email
  totalPoints: number;
  /** ISO date the entry's box office scoring starts (see scoringFromDate) */
  scoringFrom: string;
  picks: Array<{
    showId: string;
    showTitle: string;
    price: number;
    points: number;
    /** True when the show had already opened when this entry drafted it (no critic/audience points). */
    scoreLocked: boolean;
  }>;
  pointBreakdown: {
    criticScore: number;
    audienceGrade: number;
    boxOffice: number;
    awards: number;
  };
}

// ===========================================
// HELPERS
// ===========================================

/** Mask email for public display: tom@gmail.com → t***@gmail.com */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  if (local.length <= 1) return `${local}***@${domain}`;
  return `${local[0]}***@${domain}`;
}

/** Check if draft deadline has passed */
export function isDraftClosed(now: Date = new Date()): boolean {
  return now > new Date(DRAFT_DEADLINE);
}

/** Check if the draft is open: on or after DRAFT_OPENS (a New York calendar date) and before the deadline */
export function isDraftOpen(now: Date = new Date()): boolean {
  return nyDate(now.toISOString()) >= DRAFT_OPENS && !isDraftClosed(now);
}

/**
 * New York calendar date (YYYY-MM-DD) for an ISO timestamp. Fantasy rules are
 * stated in New York time: a show "opened" on its opening date, grosses weeks
 * end on Sundays, and an entry drafted at 11pm ET on opening night has seen
 * the reviews.
 */
export function nyDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
}

/** The draft deadline as a New York calendar date (the deadline is 11:59pm ET). */
export function draftDeadlineDate(): string {
  return nyDate(DRAFT_DEADLINE);
}

/**
 * The date an entry starts earning box office points. Early-bird entries
 * (drafted on or before EARLY_BIRD_CUTOFF) score from SCORING_START so the
 * launch cohort competes on equal footing; later entries score from the day
 * they draft. Same rule as BroadwayWorld's Producer Fantasy Game grace window.
 */
export function scoringFromDate(createdAtIso: string): string {
  const drafted = nyDate(createdAtIso);
  if (drafted <= EARLY_BIRD_CUTOFF) return SCORING_START;
  return drafted;
}

/**
 * Whether an entry can earn CriticScore / AudienceGrade points for a show.
 * Locked when the show had opened on or before the day the entry was drafted:
 * reviews drop on opening night, so anyone drafting from that day on already
 * knows the score. Shows with no opening date (TBA) are never locked.
 */
export function isScoreLockedForEntry(openingDate: string | null | undefined, createdAtIso: string): boolean {
  if (!openingDate) return false;
  return openingDate <= nyDate(createdAtIso);
}

/** Validate a set of picks against the config */
export function validatePicks(
  pickIds: string[],
  shows: Record<string, FantasyShow>,
): { valid: boolean; error?: string } {
  if (pickIds.length < 1) {
    return { valid: false, error: 'Must pick at least 1 show' };
  }

  if (pickIds.length > FANTASY_TEAM_SIZE) {
    return { valid: false, error: `Too many picks: ${pickIds.length} > ${FANTASY_TEAM_SIZE}` };
  }

  const uniqueIds = new Set(pickIds);
  if (uniqueIds.size !== pickIds.length) {
    return { valid: false, error: 'Duplicate picks not allowed' };
  }

  for (const id of pickIds) {
    if (!shows[id]) {
      return { valid: false, error: `Invalid show: ${id}` };
    }
  }

  const totalCost = pickIds.reduce((sum, id) => sum + shows[id].price, 0);
  if (totalCost > FANTASY_BUDGET) {
    return { valid: false, error: `Over budget: $${totalCost} > $${FANTASY_BUDGET}` };
  }

  return { valid: true };
}
