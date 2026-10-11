import { NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { FANTASY_SEASON } from '@/config/fantasy';
import { computePickOwnership } from '../../../../../scripts/lib/fantasy-ownership';

/**
 * GET /api/fantasy/ownership — "most picked" share per show for the current
 * season (BRO-4338). Only rosters are read (picks), from the same public view
 * the leaderboard uses; nothing about who picked what leaves the server.
 * Empty (published: false) until enough rosters exist; see
 * scripts/lib/fantasy-ownership.js.
 */
export async function GET() {
  const empty = { season: FANTASY_SEASON, totalEntries: 0, published: false, shows: {} };
  try {
    const supabase = getServerSupabaseClient();
    if (!supabase) return NextResponse.json(empty);

    const { data, error } = await supabase
      .from('fantasy_entries_public')
      .select('picks')
      .eq('season', FANTASY_SEASON);
    if (error) {
      console.error('Fantasy ownership fetch error:', error);
      return NextResponse.json(empty);
    }

    return NextResponse.json(
      { season: FANTASY_SEASON, ...computePickOwnership(data || []) },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch (err) {
    console.error('Fantasy ownership error:', err);
    return NextResponse.json(empty);
  }
}
