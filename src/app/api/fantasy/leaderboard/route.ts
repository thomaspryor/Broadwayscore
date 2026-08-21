import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { computeLeaderboard } from '@/lib/data-fantasy';
import { FANTASY_SEASON } from '@/config/fantasy';
import type { FantasyEntry } from '@/config/fantasy';

interface FantasyEntryPublicRow {
  id: string;
  display_email: string | null;
  team_name: string | null;
  league_name: string | null;
  picks: string[];
  total_cost: number;
  season: string;
  created_at: string;
}

// display_email is server-side masked by the view/RPC (no raw emails cross
// the wire). maskEmail() is idempotent, so passing it through
// computeLeaderboard as `email` is safe.
function toFantasyEntries(rows: FantasyEntryPublicRow[]): FantasyEntry[] {
  return rows.map(e => ({
    id: e.id,
    email: e.display_email ?? '',
    team_name: e.team_name,
    league_name: e.league_name,
    picks: e.picks,
    total_cost: e.total_cost,
    season: e.season,
    created_at: e.created_at,
  }));
}

/**
 * GET /api/fantasy/leaderboard — Fetch leaderboard data
 *
 * Query params:
 *   ?league=NAME — filter by league name (case-sensitive)
 *   ?email=ADDR  — find one entry by the exact email it was drafted with
 *                  (via the find_fantasy_entry_by_email RPC — exact match
 *                  only, never a list, so it can't be used to enumerate
 *                  other players' emails). Takes priority over ?league.
 *
 * Returns ranked entries with computed fantasy points (rank is the entry's
 * global standing for the season, even when a filter narrows the response
 * to one row). Emails are masked in the response (privacy).
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json(
        { entries: [], error: 'Database unavailable' },
        { status: 200 } // still 200 — show empty leaderboard, not error page
      );
    }

    const emailQuery = request.nextUrl.searchParams.get('email')?.trim() || null;
    const leagueName = request.nextUrl.searchParams.get('league')?.toLowerCase().trim() || null;

    if (emailQuery) {
      // Rank is relative standing, so compute it against the full season
      // leaderboard, then narrow the response to the matched entry.
      const { data: allEntries, error: allError } = await supabase
        .from('fantasy_entries_public')
        .select('*')
        .eq('season', FANTASY_SEASON)
        .order('created_at', { ascending: true });

      if (allError) {
        console.error('Fantasy leaderboard fetch error:', allError);
        return NextResponse.json({ entries: [], error: 'Failed to load entries' }, { status: 200 });
      }

      const { data: matchRows, error: rpcError } = await supabase.rpc('find_fantasy_entry_by_email', {
        p_email: emailQuery,
        p_season: FANTASY_SEASON,
      });

      if (rpcError) {
        console.error('Fantasy email lookup error:', rpcError);
        return NextResponse.json({ entries: [], error: 'Failed to search for entry' }, { status: 200 });
      }

      const match = Array.isArray(matchRows) ? matchRows[0] : matchRows;
      if (!match) {
        return NextResponse.json({
          entries: [],
          meta: { totalEntries: 0, season: FANTASY_SEASON, notFound: true },
        });
      }

      const fullLeaderboard = computeLeaderboard(toFantasyEntries(allEntries || []));
      const matchedEntry = fullLeaderboard.find(e => e.id === match.id);

      return NextResponse.json({
        entries: matchedEntry ? [matchedEntry] : [],
        meta: { totalEntries: matchedEntry ? 1 : 0, season: FANTASY_SEASON },
      });
    }

    let query = supabase
      .from('fantasy_entries_public')
      .select('*')
      .eq('season', FANTASY_SEASON);

    if (leagueName) {
      query = query.eq('league_name', leagueName);
    }

    const { data: entries, error: dbError } = await query.order('created_at', { ascending: true });

    if (dbError) {
      console.error('Fantasy leaderboard fetch error:', dbError);
      return NextResponse.json(
        { entries: [], error: 'Failed to load entries' },
        { status: 200 }
      );
    }

    const leaderboard = computeLeaderboard(toFantasyEntries(entries || []));

    return NextResponse.json({
      entries: leaderboard,
      meta: {
        totalEntries: leaderboard.length,
        season: FANTASY_SEASON,
      },
    });
  } catch (err) {
    console.error('Fantasy leaderboard error:', err);
    return NextResponse.json(
      { entries: [], error: 'An unexpected error occurred' },
      { status: 200 }
    );
  }
}
