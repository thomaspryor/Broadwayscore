import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { getFantasyShows } from '@/lib/data-fantasy';
import {
  FANTASY_BUDGET,
  FANTASY_TEAM_SIZE,
  DRAFT_DEADLINE,
  FANTASY_SEASON,
  validatePicks,
} from '@/config/fantasy';

// In-memory rate limiting — resets per Vercel serverless instance.
// Effective for burst protection but not persistent across deploys.
// For production: use Vercel KV or Upstash Redis.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

/**
 * POST /api/fantasy/draft — Submit a fantasy draft entry
 *
 * Body: { email, team_name?, league_name?, picks: string[] }
 * Validates picks, budget, deadline, then upserts to Supabase.
 */
export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkRateLimit(ip)) {
      return NextResponse.json(
        { error: 'Too many submissions. Please try again later.' },
        { status: 429 }
      );
    }

    // Check deadline
    if (new Date() > new Date(DRAFT_DEADLINE)) {
      return NextResponse.json(
        { error: 'The draft window has closed.' },
        { status: 400 }
      );
    }

    // Parse body
    const body = await request.json().catch(() => null);
    if (!body) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { email, team_name, league_name, picks, tiebreakers } = body;

    // Validate email
    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }
    const normalizedEmail = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return NextResponse.json({ error: 'Invalid email format' }, { status: 400 });
    }

    // Validate team_name and league_name (length limits, alphanumeric)
    const cleanTeamName = team_name ? String(team_name).trim().slice(0, 50) : null;
    const cleanLeagueName = league_name ? String(league_name).trim().toLowerCase().slice(0, 50) : null;
    // Fix P1: normalize league name to lowercase for case-insensitive matching

    // Validate picks
    if (!Array.isArray(picks)) {
      return NextResponse.json({ error: 'Picks must be an array' }, { status: 400 });
    }

    const shows = getFantasyShows();
    const validation = validatePicks(picks, shows);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Compute total cost
    const totalCost = picks.reduce((sum: number, id: string) => sum + shows[id].price, 0);

    // Supabase upsert
    const supabase = getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json(
        { error: 'Database unavailable. Please try again later.' },
        { status: 503 }
      );
    }

    const { error: dbError } = await supabase
      .from('fantasy_entries')
      .upsert(
        {
          email: normalizedEmail,
          team_name: cleanTeamName,
          league_name: cleanLeagueName,
          picks,
          tiebreakers: tiebreakers && typeof tiebreakers === 'object' ? tiebreakers : null,
          total_cost: totalCost,
          season: FANTASY_SEASON,
        },
        { onConflict: 'email,season' }
      );

    if (dbError) {
      console.error('Fantasy draft insert error:', dbError);
      return NextResponse.json(
        { error: 'Failed to save entry. Please try again.' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Draft submitted successfully!',
      team_name: cleanTeamName,
      total_cost: totalCost,
    });
  } catch (err) {
    console.error('Fantasy draft error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    );
  }
}
