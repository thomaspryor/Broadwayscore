// Fantasy League data module
// Imports: fantasy-league.json (~15 KB), fantasy-scores.json (~15 KB)
// Provides typed accessors for fantasy config, show data, and scoring.

import type {
  FantasyLeagueConfig,
  FantasyScoresData,
  FantasyShow,
  FantasyShowScore,
  FantasyEntry,
  LeaderboardEntry,
} from '@/config/fantasy';
import { maskEmail } from '@/config/fantasy';

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

    const picks = entry.picks.map(showId => {
      const show = config.shows[showId];
      const score = scores.showScores[showId];

      const points = score?.totalPoints ?? 0;
      if (score) {
        totalCritic += score.criticScorePoints;
        totalAudience += score.audienceGradePoints;
        totalBoxOffice += score.boxOfficePoints;
        totalAwards += score.awardsPoints;
      }

      return {
        showId,
        showTitle: show?.title ?? showId,
        price: show?.price ?? 0,
        points,
      };
    });

    const totalPoints = Math.round((totalCritic + totalAudience + totalBoxOffice + totalAwards) * 100) / 100;

    return {
      rank: 0, // computed below
      displayName: entry.team_name || maskEmail(entry.email),
      totalPoints,
      picks,
      pointBreakdown: {
        criticScore: totalCritic,
        audienceGrade: totalAudience,
        boxOffice: Math.round(totalBoxOffice * 100) / 100,
        awards: totalAwards,
      },
    };
  });

  // Sort by total points descending, assign ranks
  leaderboard.sort((a, b) => b.totalPoints - a.totalPoints);
  leaderboard.forEach((entry, i) => {
    entry.rank = i + 1;
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
    budget: config._meta.budget,
    teamSize: config._meta.teamSize,
    totalShows: Object.keys(config.shows).length,
    broadwayShows: Object.values(config.shows).filter(s => s.category === 'broadway').length,
    offBroadwayShows: Object.values(config.shows).filter(s => s.category === 'off-broadway').length,
    lastScored: scores._meta.lastUpdated,
    latestGrossesWeek: scores._meta.weekEnding,
  };
}
