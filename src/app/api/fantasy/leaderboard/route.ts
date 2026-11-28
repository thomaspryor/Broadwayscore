import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { computeLeaderboard } from '@/lib/data-fantasy';
import { FANTASY_SEASON, canonicalFantasyEmail } from '@/config/fantasy';
import type { FantasyEntry } from '@/config/fantasy';
import { rostersPublic, hiddenStandings } from '@/lib/fantasy-roster-privacy';

// Email search confirms "does this exact email have an entry" — an
// existence oracle an attacker could otherwise run at unlimited scale
// against a breached email list. Same in-memory-per-instance rate limit
// shape as the draft route (src/app/api/fantasy/draft/route.ts), sized
// generously for a legit user checking a few emails (self + friends).
// Does not cover the RPC being callable directly via Supabase REST with
// the public anon key — same boundary every anon-grantable read in this
// schema already trusts (e.g. the unthrottled full-table
// fantasy_entries_public list this same route already exposes).
const emailSearchRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const EMAIL_SEARCH_RATE_LIMIT = 20;
const EMAIL_SEARCH_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkEmailSearchRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = emailSearchRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    emailSearchRateLimitMap.set(ip, { count: 1, resetAt: now + EMAIL_SEARCH_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= EMAIL_SEARCH_RATE_LIMIT) return false;
  entry.count++;
  return true;
}

const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// PostgREST returns at most 1000 rows per request; read every page so entry
// #1001 still ranks (and can win).
const PAGE_SIZE = 1000;
type SupabaseClient = NonNullable<ReturnType<typeof getServerSupabaseClient>>;
async function fetchSeasonEntries(
  supabase: SupabaseClient,
  leagueName: string | null,
): Promise<{ rows: FantasyEntryPublicRow[]; error: unknown }> {
  const rows: FantasyEntryPublicRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from('fantasy_entries_public')
      .select('*')
      .eq('season', FANTASY_SEASON);
    if (leagueName) query = query.eq('league_name', leagueName);
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error };
    rows.push(...((data || []) as FantasyEntryPublicRow[]));
    if (!data || data.length < PAGE_SIZE) return { rows, error: null };
  }
}

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
 *   ?league=NAME — filter by league name or code (lower-cased, like the draft route stores it)
 *   ?email=ADDR  — find one entry by the exact email it was drafted with
 *                  (via the find_fantasy_entry_by_email RPC — exact match
 *                  only, never a list, so it can't be used to enumerate
 *                  other players' emails). Takes priority over ?league.
 *
 * Returns ranked entries with computed fantasy points. With ?email the rank
 * is the entry's standing in the whole season; with ?league it is the
 * standing inside that league. Emails are masked in the response (privacy).
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
      if (!EMAIL_FORMAT_RE.test(emailQuery)) {
        return NextResponse.json({ entries: [], meta: { totalEntries: 0, season: FANTASY_SEASON, notFound: true } });
      }

      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
      if (!checkEmailSearchRateLimit(ip)) {
        return NextResponse.json({ entries: [], error: 'Too many searches. Please try again later.' }, { status: 429 });
      }

      // Rank is relative standing, so compute it against the full season
      // leaderboard, then narrow the response to the matched entry.
      const { rows: allEntries, error: allError } = await fetchSeasonEntries(supabase, null);

      if (allError) {
        console.error('Fantasy leaderboard fetch error:', allError);
        return NextResponse.json({ entries: [], error: 'Failed to load entries' }, { status: 200 });
      }

      const { data: matchRows, error: rpcError } = await supabase.rpc('find_fantasy_entry_by_email', {
        // Stored addresses are canonical (draft route): tom+bfl@gmail.com finds tom@gmail.com.
        p_email: canonicalFantasyEmail(emailQuery),
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

      if (!rostersPublic()) {
        return NextResponse.json(hiddenStandings({
          teams: [],
          totalEntries: matchedEntry ? 1 : 0,
          season: FANTASY_SEASON,
          notFound: !matchedEntry,
        }));
      }

      return NextResponse.json({
        entries: matchedEntry ? [matchedEntry] : [],
        meta: { totalEntries: matchedEntry ? 1 : 0, season: FANTASY_SEASON },
      });
    }

    const { rows: entries, error: dbError } = await fetchSeasonEntries(supabase, leagueName);

    if (dbError) {
      console.error('Fantasy leaderboard fetch error:', dbError);
      return NextResponse.json(
        { entries: [], error: 'Failed to load entries' },
        { status: 200 }
      );
    }

    const leaderboard = computeLeaderboard(toFantasyEntries(entries || []));

    if (!rostersPublic()) {
      return NextResponse.json(hiddenStandings({
        // Names only for a league's own page; the all-teams view needs just the count.
        teams: leagueName ? leaderboard.map(e => e.displayName) : [],
        totalEntries: leaderboard.length,
        season: FANTASY_SEASON,
      }));
    }

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
