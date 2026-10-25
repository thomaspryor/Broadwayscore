import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { FANTASY_SEASON } from '@/config/fantasy';
import { isValidLeaderboardEntry } from '@/lib/data-fantasy';

/**
 * GET /api/fantasy/leagues/[code] — Fetch league metadata
 * Returns: { code, name, created_at, member_count }
 * Leaderboard data comes from GET /api/fantasy/leaderboard?league=[code]
 */
export async function GET(_request: NextRequest, props: { params: Promise<{ code: string }> }) {
  const params = await props.params;
  let raw = params.code ?? '';
  try { raw = decodeURIComponent(raw); } catch { /* already decoded */ }
  const code = raw.toLowerCase().trim();
  // 50 = the draft route's league_name cap (free-text leagues use the name as the code).
  if (!code || code.length > 50) {
    return NextResponse.json({ error: 'Invalid league code' }, { status: 400 });
  }

  const supabase = getServerSupabaseClient();
  if (!supabase) {
    return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  }

  const { data: league } = await supabase
    .from('fantasy_leagues')
    .select('code, name, created_at')
    .eq('code', code)
    .maybeSingle();

  // Count members via public view — anon no longer has SELECT on fantasy_entries.
  const { data: members } = await supabase
    .from('fantasy_entries_public')
    .select('picks, created_at')
    .eq('season', FANTASY_SEASON)
    .eq('league_name', code);
  // Count only entries the league's standings list (isValidLeaderboardEntry).
  const memberCount = (members ?? []).filter(m => isValidLeaderboardEntry(m as { picks: string[]; created_at: string })).length;

  if (!league) {
    // Free-text league: players typed the same league name on the draft form
    // (FAQ "What are leagues?"). It has no fantasy_leagues row, so it exists
    // once someone has drafted into it.
    if (memberCount === 0) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }
    return NextResponse.json({ code, name: code, created_at: null, member_count: memberCount });
  }

  return NextResponse.json({
    code: league.code,
    name: league.name,
    created_at: league.created_at,
    member_count: memberCount,
  });
}
