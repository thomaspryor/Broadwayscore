import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { computeLeaderboard } from '@/lib/data-fantasy';
import { FANTASY_SEASON } from '@/config/fantasy';
import type { FantasyEntry } from '@/config/fantasy';

/**
 * GET /api/fantasy/leaderboard — Fetch leaderboard data
 *
 * Query params:
 *   ?league=NAME — filter by league name (case-sensitive)
 *
 * Returns ranked entries with computed fantasy points.
 * Emails are masked in the response (privacy).
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

    const leagueName = request.nextUrl.searchParams.get('league')?.toLowerCase().trim() || null;

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

    // display_email is server-side masked by the view (no raw emails cross the wire).
    // maskEmail() is idempotent, so passing it through computeLeaderboard is safe.
    const typedEntries: FantasyEntry[] = (entries || []).map(e => ({
      id: e.id,
      email: e.display_email ?? '',
      team_name: e.team_name,
      league_name: e.league_name,
      picks: e.picks,
      total_cost: e.total_cost,
      season: e.season,
      created_at: e.created_at,
    }));

    const leaderboard = computeLeaderboard(typedEntries);

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
