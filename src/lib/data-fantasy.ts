// Fantasy League data module
// Imports: fantasy-league.json (~25 KB), fantasy-scores.json (~25 KB)
// Provides typed accessors for fantasy config, show data, and scoring.

import type {
  FantasyLeagueConfig,
  FantasyScoresData,
  FantasyShow,
  FantasyShowScore,
  FantasyEntry,
  LeaderboardEntry,
} from '@/config/fantasy';
import { maskEmail, scoringFromDate, isScoreLockedForEntry, SCORING_START } from '@/config/fantasy';

// Import JSON data (loaded at build time)
import fantasyLeagueData from '../../data/fantasy-league.json';
import fantasyScoresData from '../../data/fantasy-scores.json';

const config = fantasyLeagueData as unknown as FantasyLeagueConfig;
const scores = fantasyScoresData as unknown as FantasyScoresData;

// ── Config accessors ────────────────────────────────────────────────

export function getFantasyConfig(): FantasyLeagueConfig {
  return config;
}

export function getFantasyShows(): Record<string, FantasyShow> {
  return config.shows;
}

export function getFantasyShow(showId: string): FantasyShow | null {
  return config.shows[showId] ?? null;
}

/** Get all shows sorted by price (highest first) */
export function getFantasyShowsSorted(): Array<{ id: string } & FantasyShow> {
  return Object.entries(config.shows)
    .map(([id, show]) => ({ id, ...show }))
    .sort((a, b) => b.price - a.price);
}

/** Get Broadway shows only, sorted by price */
export function getFantasyBroadwayShows(): Array<{ id: string } & FantasyShow> {
  return getFantasyShowsSorted().filter(s => s.category === 'broadway');
}

/** Get Off-Broadway shows only, sorted by price */
export function getFantasyOffBroadwayShows(): Array<{ id: string } & FantasyShow> {
  return getFantasyShowsSorted().filter(s => s.category === 'off-broadway');
}

// ── Scores accessors ────────────────────────────────────────────────

export function getFantasyScores(): FantasyScoresData {
  return scores;
}

export function getShowScore(showId: string): FantasyShowScore | null {
  return scores.showScores[showId] ?? null;
}

// ── Per-entry scoring ───────────────────────────────────────────────

export interface EntryPickPoints {
  critic: number;
  audience: number;
  boxOffice: number;
  awards: number;
  total: number;
  locked: boolean;
}

/**
 * Points one entry earns from one drafted show. Mirrors
 * scripts/lib/fantasy-helpers.js entryPickPoints (parity test in
 * tests/unit/fantasy-leaderboard-parity.test.ts).
 *
 *  - Critic/audience points are locked when the show had opened on or before
 *    the day the entry drafted (reviews were already public).
 *  - Box office counts from the grosses week containing the entry's
 *    scoring-from date (season start for early birds, draft day otherwise).
 *  - Awards count for every entry.
 */
export function entryPickPoints(
  score: FantasyShowScore | null | undefined,
  openingDate: string | null | undefined,
  createdAtIso: string,
): EntryPickPoints {
  if (!score) return { critic: 0, audience: 0, boxOffice: 0, awards: 0, total: 0, locked: false };
  const locked = isScoreLockedForEntry(openingDate ?? score.openingDate, createdAtIso);
  const critic = locked ? 0 : (score.criticScorePoints || 0);
  const audience = locked ? 0 : (score.audienceGradePoints || 0);
  const from = scoringFromDate(createdAtIso);
  let boxOffice: number;
  if (score.weeklyBoxOffice && typeof score.weeklyBoxOffice === 'object') {
    boxOffice = 0;
    for (const [weekEnding, pts] of Object.entries(score.weeklyBoxOffice)) {
      if (weekEnding >= from) boxOffice += pts || 0;
    }
  } else {
    // Legacy snapshot without a weekly breakdown: all-or-nothing.
    boxOffice = from <= SCORING_START ? (score.boxOfficePoints || 0) : 0;
  }
  boxOffice = Math.round(boxOffice * 100) / 100;
  const awards = score.awardsPoints || 0;
  const total = Math.round((critic + audience + boxOffice + awards) * 100) / 100;
  return { critic, audience, boxOffice, awards, total, locked };
}

// ── Leaderboard computation ─────────────────────────────────────────

/**
 * Compute leaderboard from draft entries + fantasy scores.
 * Entries come from Supabase (passed in), scores from JSON (imported above).
 */
export function computeLeaderboard(entries: FantasyEntry[]): LeaderboardEntry[] {
  const leaderboard: LeaderboardEntry[] = entries.map(entry => {
    let totalCritic = 0;
    let totalAudience = 0;
    let totalBoxOffice = 0;
    let totalAwards = 0;
    const scoringFrom = scoringFromDate(entry.created_at);

    const picks = entry.picks.map(showId => {
      const show = config.shows[showId];
      const score = scores.showScores[showId];
      const p = entryPickPoints(score, show?.openingDate ?? score?.openingDate ?? null, entry.created_at);

      totalCritic += p.critic;
      totalAudience += p.audience;
      totalBoxOffice += p.boxOffice;
      totalAwards += p.awards;

      return {
        showId,
        showTitle: show?.title ?? showId,
        price: show?.price ?? 0,
        points: p.total,
        scoreLocked: p.locked,
      };
    });

    const totalPoints = Math.round((totalCritic + totalAudience + totalBoxOffice + totalAwards) * 100) / 100;

    return {
      id: entry.id,
      rank: 0, // computed below
      displayName: entry.team_name || maskEmail(entry.email),
      totalPoints,
      scoringFrom,
      picks,
      pointBreakdown: {
        criticScore: Math.round(totalCritic * 100) / 100,
        audienceGrade: Math.round(totalAudience * 100) / 100,
        boxOffice: Math.round(totalBoxOffice * 100) / 100,
        awards: Math.round(totalAwards * 100) / 100,
      },
    };
  });

  // Sort by total points descending, assign ranks (tied entries share a rank)
  leaderboard.sort((a, b) => b.totalPoints - a.totalPoints);
  leaderboard.forEach((entry, i) => {
    if (i === 0) {
      entry.rank = 1;
    } else {
      entry.rank = entry.totalPoints === leaderboard[i - 1].totalPoints
        ? leaderboard[i - 1].rank
        : i + 1;
    }
  });

  return leaderboard;
}

// ── Season metadata ─────────────────────────────────────────────────

export function getFantasySeasonInfo() {
  return {
    season: config._meta.season,
    draftDeadline: config._meta.draftDeadline,
    scoringStart: config._meta.scoringStart,
    scoringEnd: config._meta.scoringEnd,
    earlyBirdCutoff: config._meta.earlyBirdCutoff ?? null,
    budget: config._meta.budget,
    teamSize: config._meta.teamSize,
    totalShows: Object.keys(config.shows).length,
    broadwayShows: Object.values(config.shows).filter(s => s.category === 'broadway').length,
    offBroadwayShows: Object.values(config.shows).filter(s => s.category === 'off-broadway').length,
    lockedShows: Object.values(config.shows).filter(s => !s.eligible.criticScore).length,
    lastScored: scores._meta.lastUpdated,
    latestGrossesWeek: scores._meta.weekEnding,
  };
}
