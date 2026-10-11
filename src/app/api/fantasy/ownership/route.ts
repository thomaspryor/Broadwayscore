import { NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { FANTASY_SEASON } from '@/config/fantasy';
import { noStoreFetch } from '@/lib/share-links/load';
import { computePickOwnership } from '../../../../../scripts/lib/fantasy-ownership';

/**
 * GET /api/fantasy/ownership — "most picked" share per show for the current
 * season (BRO-4338). Only rosters are read (picks), from the same public view
 * the leaderboard uses; nothing about who picked what leaves the server.
 * Empty (published: false) until enough rosters exist; see
 * scripts/lib/fantasy-ownership.js.
 */
// Live counts: never prerender at build or keep in the Data Cache (it outlives
// deploys); the s-maxage header below is the only cache.
export const dynamic = 'force-dynamic';

const PAGE = 1000;

export async function GET() {
  const empty = { season: FANTASY_SEASON, totalEntries: 0, published: false, shows: {} };
  try {
    const supabase = getServerSupabaseClient({ fetch: noStoreFetch });
    if (!supabase) return NextResponse.json(empty);

    // PostgREST caps a response at 1000 rows, so page through every roster;
    // a silently truncated read would skew every percentage.
    const rows: { picks: unknown }[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('fantasy_entries_public')
        .select('picks')
        .eq('season', FANTASY_SEASON)
        .order('id')
        .range(from, from + PAGE - 1);
      if (error) {
        console.error('Fantasy ownership fetch error:', error);
        return NextResponse.json(empty);
      }
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    return NextResponse.json(
      { season: FANTASY_SEASON, ...computePickOwnership(rows) },
      { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' } },
    );
  } catch (err) {
    console.error('Fantasy ownership error:', err);
    return NextResponse.json(empty);
  }
}
