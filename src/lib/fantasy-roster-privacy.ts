import { isDraftClosed, draftDeadlineDate } from '@/config/fantasy';

/**
 * The game is guessing, so nobody sees another team's picks (or the "% picked"
 * crowd signal) while the draft is open. Rosters become public when the draft
 * closes. The database hides them too (20261019_fantasy_hide_rosters_until_draft_closes.sql);
 * this is the API-side half, so the response is correct even before that
 * migration runs and after the deadline moves.
 */
/** What the database puts in `picks`, once per pick, while the draft is open. Not a show id. */
export const HIDDEN_PICK = 'hidden';

/** True for a roster the database hid: at least one pick, every one the placeholder. */
export function isHiddenRoster(picks: unknown): boolean {
  return Array.isArray(picks) && picks.length > 0 && picks.every(p => p === HIDDEN_PICK);
}

export function rostersPublic(now: Date = new Date()): boolean {
  return isDraftClosed(now);
}

export interface HiddenStandings {
  entries: [];
  teams: string[];
  meta: {
    totalEntries: number;
    season: string;
    picksHidden: true;
    /** NY calendar date rosters and standings appear (the draft deadline day). */
    revealsOn: string;
    notFound: boolean;
  };
}

/** Response body used instead of the leaderboard while the draft is open: team names only. */
export function hiddenStandings(opts: { teams: string[]; totalEntries: number; season: string; notFound?: boolean }): HiddenStandings {
  return {
    entries: [],
    teams: opts.teams,
    meta: {
      totalEntries: opts.totalEntries,
      season: opts.season,
      picksHidden: true,
      revealsOn: draftDeadlineDate(),
      notFound: !!opts.notFound,
    },
  };
}
