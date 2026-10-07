import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { FANTASY_SEASON } from '@/config/fantasy';

/**
 * GET /api/fantasy/leagues/[code] — Fetch league metadata
 * Returns: { code, name, created_at, member_count }
 * Leaderboard data comes from GET /api/fantasy/leaderboard?league=[code]
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { code: string } }
) {
  const code = params.code?.toLowerCase().trim();
  if (!code || code.length > 20) {
    return NextResponse.json({ error: 'Invalid league code' }, { status: 400 });
  }

  const supabase = getServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  }

  const { data: league, error } = await supabase
    .from('fantasy_leagues')
    .select('code, name, created_at')
    .eq('code', code)
    .single();

  if (error || !league) {
    return NextResponse.json({ error: 'League not found' }, { status: 404 });
  }

  // Count members via public view — anon no longer has SELECT on fantasy_entries.
  const { data: members } = await supabase
    .from('fantasy_entries_public')
    .select('id')
    .eq('season', FANTASY_SEASON)
    .eq('league_name', code);

  return NextResponse.json({
    code: league.code,
    name: league.name,
    created_at: league.created_at,
    member_count: members?.length ?? 0,
  });
}
