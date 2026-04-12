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
 * At 0.15, a strong musical ($1M/week over 20 weeks) earns ~30 pts.
 * This makes box office ~11% of a Best Musical winner's total (vs 38% before).
 */
export const BOX_OFFICE_POINTS_PER_100K = 0.15;

/**
 * Awards point values — Tony Awards only for MVP.
 *
 * Awards are the majority of total points (~50-68%).
 * Best Musical/Play winner with 8 noms + 4 wins earns ~180 pts from awards alone.
 */
export const AWARDS_POINTS = {
  tonyNom: 10,
  tonyWin: 20,
  tonyBestMusical: 40,
  tonyBestPlay: 40,
};

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
  if (pickIds.length !== FANTASY_TEAM_SIZE) {
    return { valid: false, error: `Must pick exactly ${FANTASY_TEAM_SIZE} shows` };
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
