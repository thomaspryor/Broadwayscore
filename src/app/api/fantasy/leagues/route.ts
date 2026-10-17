import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { canonicalFantasyEmail } from '@/config/fantasy';

// Per-IP cap on top of the per-email one below: the email is unverified, so
// random addresses would otherwise create leagues without limit (BRO-5548
// audit). Same in-memory-per-instance shape as the draft route; counts
// created leagues only.
const ipLeagueMap = new Map<string, { count: number; resetAt: number }>();
const IP_LEAGUE_LIMIT = 10;
const IP_LEAGUE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function ipOverLeagueLimit(ip: string): boolean {
  const entry = ipLeagueMap.get(ip);
  return !!entry && Date.now() <= entry.resetAt && entry.count >= IP_LEAGUE_LIMIT;
}

function recordLeague(ip: string): void {
  const now = Date.now();
  const entry = ipLeagueMap.get(ip);
  if (!entry || now > entry.resetAt) ipLeagueMap.set(ip, { count: 1, resetAt: now + IP_LEAGUE_WINDOW_MS });
  else entry.count++;
}

function nanoid6(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  // Use crypto.getRandomValues if available (Edge/Node 18+), else Math.random
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    for (let i = 0; i < arr.length; i++) result += chars[arr[i] % chars.length];
  } else {
    for (let i = 0; i < 6; i++) result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * POST /api/fantasy/leagues — Create a named private league
 * Body: { name, created_by_email }
 * Returns: { code, name }
 */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (ipOverLeagueLimit(ip)) {
      return NextResponse.json({ error: 'Too many leagues created from this connection. Try again in an hour.' }, { status: 429 });
    }
    const body = await request.json().catch(() => null);
    if (!body) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

    const { name, created_by_email } = body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return NextResponse.json({ error: 'League name must be at least 2 characters' }, { status: 400 });
    }
    const cleanName = name.trim().slice(0, 60);

    if (typeof created_by_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(created_by_email.trim())) {
      return NextResponse.json({ error: 'Valid email required' }, { status: 400 });
    }
    // Same canonical form as draft entries, so name+1@gmail.com cannot dodge
    // the 5-a-day cap below or the database trigger (BRO-5548 audit).
    const cleanEmail = canonicalFantasyEmail(created_by_email);

    const supabase = getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
    }

    // Per-email rate cap: max 5 leagues per 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentLeagues } = await supabase
      .from('fantasy_leagues')
      .select('id')
      .eq('created_by', cleanEmail)
      .gte('created_at', since);

    if ((recentLeagues?.length ?? 0) >= 5) {
      return NextResponse.json({ error: 'You can create up to 5 leagues per day' }, { status: 429 });
    }

    // Generate a unique code (retry up to 3 times on collision)
    let code = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = nanoid6();
      const { data: existing } = await supabase
        .from('fantasy_leagues')
        .select('code')
        .eq('code', candidate)
        .single();
      if (!existing) { code = candidate; break; }
    }
    if (!code) {
      return NextResponse.json({ error: 'Could not generate league code, please try again' }, { status: 500 });
    }

    const { error: dbError } = await supabase
      .from('fantasy_leagues')
      .insert({ code, name: cleanName, created_by: cleanEmail });

    if (dbError) {
      console.error('Fantasy league create error:', dbError);
      return NextResponse.json({ error: 'Failed to create league' }, { status: 500 });
    }

    recordLeague(ip);
    return NextResponse.json({ code, name: cleanName });
  } catch (err) {
    console.error('Fantasy league POST error:', err);
    return NextResponse.json({ error: 'Unexpected error' }, { status: 500 });
  }
}
