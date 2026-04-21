/**
 * Broadway Fantasy League — Configuration & Types
 *
 * Single source of truth for fantasy league scoring, types, and constants.
 * Scripts (generate-fantasy-config.js, compute-fantasy-scores.js) and
 * components both reference these definitions.
 */

// Import canonical tier labels from scoring.ts — never hardcode these
import { getCriticLabel } from './scoring';

// Re-export so consumers can use it
export { getCriticLabel };

// ===========================================
// SEASON CONFIG
// ===========================================

export const FANTASY_SEASON = '2025-2026';
export const FANTASY_BUDGET = 100;
export const FANTASY_TEAM_SIZE = 8;
export const DRAFT_DEADLINE = '2026-12-31T05:00:00Z'; // extended for prototype testing
export const SCORING_START = '2026-02-01';
export const SCORING_END = '2026-06-15'; // Tony Awards night

// ===========================================
// SCORING POINT MAPPINGS
// ===========================================

/**
 * CriticScore tier → fantasy points. Labels must match getCriticLabel() output.
 *
 * Calibrated so CriticScore is ~15-18% of a strong show's total points.
 * A "Critical Gold" show earns 30 pts (vs 180 possible from awards).
 */
export const CRITIC_SCORE_POINTS: Record<string, number> = {
  'Critical Gold': 30,
  'Recommended': 20,
  'Worth Seeing': 12,
  'Skippable': 4,
  'Stay Away': 0,
};

/**
 * AudienceGrade → fantasy points. Grades must match getAudienceGrade() output.
 *
 * Calibrated so AudienceGrade is ~10-12% of a strong show's total.
 */
export const AUDIENCE_GRADE_POINTS: Record<string, number> = {
  'A+': 25,
  'A': 20,
  'A-': 16,
  'B+': 10,
  'B': 6,
  'B-': 3,
  'C+': 1,
  'C': 0,
  'C-': 0,
  'D': 0,
  'F': 0,
};

/**
 * Box office: points per $100K weekly gross.
 *
 * At 0.30, a strong musical ($1M/week over 20 weeks) earns ~60 pts.
 * This makes box office ~25% of a Best Musical winner's total.
 */
export const BOX_OFFICE_POINTS_PER_100K = 0.30;

/**
 * Awards point values — Tonys + pre-Tony ceremonies.
 *
 * Multiple ceremonies create scoring events across 6 weeks (mid-May to mid-June),
 * not just one Tony night. Awards still ~45-50% of a strong show's total.
 *
 * Tony Awards (mid-June): biggest single event
 * Drama League (mid-May): noms + wins
 * Outer Critics Circle (late May): noms + wins, covers BW + OB
 * Drama Desk (late May/early June): noms + wins, covers BW + OB
 * NY Drama Critics' Circle (early May): wins only (best play, best musical)
 * Lucille Lortel Awards (early May): noms + wins, OB only
 * Obie Awards (late May): special citations, no nom/win format, OB + experimental
 */
export const AWARDS_POINTS = {
  // Tony Awards — wins weigh 4x a nom; Best Musical/Play 1.5x a regular win
  tonyNom: 5,
  tonyWin: 20,
  tonyBestMusical: 30,
  tonyBestPlay: 30,
  // Pre-Tony ceremonies
  dramaLeagueNom: 2,
  dramaLeagueWin: 5,
  outerCriticsNom: 2,
  outerCriticsWin: 5,
  dramaDeskNom: 3,
  dramaDeskWin: 6,
  // Additional ceremonies
  nydccWin: 5,         // NY Drama Critics' Circle — wins only, very prestigious
  lortelNom: 2,        // Lucille Lortel — OB awards, noms + wins
  lortelWin: 5,
  obieAward: 4,        // Obie — citations (no nom/win structure)
};

// ===========================================
// PRIZE
// ===========================================

export const PRIZE_DESCRIPTION = '$500 TodayTix voucher';

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
  criticScoreLocked: '★',   // CriticScore already set (opened before scoring start)
  offBroadway: '†',          // Off-Broadway (no box office, no Tonys)
};

// ===========================================
// TYPES
// ===========================================

export interface FantasyShowEligibility {
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
  /** Current CriticScore if available (for draft research) */
  criticScore?: number | null;
  /** Current AudienceGrade if available (for draft research) */
  audienceGrade?: string | null;
  slug: string;
  /** Thumbnail image path */
  image?: string | null;
}

export interface FantasyLeagueConfig {
  _meta: {
    season: string;
    draftDeadline: string;
    scoringStart: string;
    scoringEnd: string;
    budget: number;
    teamSize: number;
    generatedAt: string;
    pricing?: {
      method: 'ev' | 'heuristic';
      k?: number;
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
  rank: number;
  displayName: string; // team_name or masked email
  totalPoints: number;
  picks: Array<{
    showId: string;
    showTitle: string;
    price: number;
    points: number;
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
export function isDraftClosed(): boolean {
  return new Date() > new Date(DRAFT_DEADLINE);
}

/** Validate a set of picks against the config */
export function validatePicks(
  pickIds: string[],
  shows: Record<string, FantasyShow>,
): { valid: boolean; error?: string } {
  if (pickIds.length < 1) {
    return { valid: false, error: 'Must pick at least 1 show' };
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
