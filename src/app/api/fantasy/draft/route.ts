import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { getFantasyShows, getFantasyConfig } from '@/lib/data-fantasy';
import {
  FANTASY_BUDGET,
  FANTASY_TEAM_SIZE,
  FANTASY_SEASON,
  DRAFT_OPENS,
  SCORING_END,
  EARLY_BIRD_CUTOFF,
  isDraftClosed,
  isDraftOpen,
  isScoreLockedForEntry,
  nyDate,
  scoringFromDate,
  validatePicks,
} from '@/config/fantasy';

// In-memory rate limiting — resets per Vercel serverless instance.
// Effective for burst protection but not persistent across deploys.
// The database also caps inserts at 10 per email per 24h (migration
// 20260422c_fantasy_rate_limit_triggers.sql), which covers direct REST posts.
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

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = 'Broadway Fantasy League <fantasy@broadwayscorecard.com>';
const REPLY_TO_EMAIL = 'hi@broadwayscorecard.com';
const SITE = 'https://broadwayscorecard.com';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatLongDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Confirmation email: the roster the player just locked, the rules that
 * apply to their entry (scoring-from date, which picks are score-locked),
 * and where to find their team. Best-effort: the entry is already saved.
 */
function buildConfirmationHtml(opts: {
  teamName: string | null;
  leagueName: string | null;
  createdAt: string;
  picks: Array<{ title: string; price: number; locked: boolean; openingDate: string | null }>;
  totalCost: number;
}): string {
  const scoringFrom = scoringFromDate(opts.createdAt);
  const isEarlyBird = nyDate(opts.createdAt) <= EARLY_BIRD_CUTOFF;
  const lockedCount = opts.picks.filter(p => p.locked).length;
  const rows = opts.picks.map(p => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #1f1f1f;color:#ffffff;font-size:14px;">${escapeHtml(p.title)}${p.locked ? ' <span style="color:#a1a1aa;font-size:12px;">(already open: box office and awards only)</span>' : ''}</td>
          <td style="padding:8px 0;border-bottom:1px solid #1f1f1f;color:#6ee7b7;font-size:14px;font-weight:700;text-align:right;">$${p.price}</td>
        </tr>`).join('');

  const leagueLine = opts.leagueName
    ? `<p style="margin:0 0 12px;color:#a1a1aa;font-size:14px;">League: <a href="${SITE}/fantasy/league/${encodeURIComponent(opts.leagueName.toLowerCase())}" style="color:#d4a574;">${escapeHtml(opts.leagueName)}</a></p>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:32px 16px;">
    <div style="background:#111111;border:1px solid #1f1f1f;border-radius:16px;overflow:hidden;">
      <div style="padding:28px 28px 20px;border-bottom:1px solid #1f1f1f;text-align:center;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px;">Broadway Scorecard</div>
        <div style="font-size:24px;font-weight:900;color:#ffffff;letter-spacing:-0.03em;">Your team is locked in</div>
        <div style="font-size:13px;color:#6b7280;margin-top:4px;">Broadway Fantasy League &middot; ${escapeHtml(FANTASY_SEASON)} season</div>
      </div>
      <div style="padding:20px 28px;">
        ${opts.teamName ? `<p style="margin:0 0 12px;color:#ffffff;font-size:16px;font-weight:700;">${escapeHtml(opts.teamName)}</p>` : ''}
        ${leagueLine}
        <table style="width:100%;border-collapse:collapse;">
          ${rows}
          <tr>
            <td style="padding:10px 0 0;color:#a1a1aa;font-size:13px;">Total</td>
            <td style="padding:10px 0 0;color:#ffffff;font-size:14px;font-weight:700;text-align:right;">$${opts.totalCost} of $${FANTASY_BUDGET}</td>
          </tr>
        </table>
      </div>
      <div style="padding:0 28px 24px;color:#a1a1aa;font-size:13px;line-height:1.5;">
        <p style="margin:0 0 10px;">Box office points count from ${isEarlyBird ? `the season start (${formatLongDate(scoringFrom)}), because you drafted before the early-bird cutoff on ${formatLongDate(EARLY_BIRD_CUTOFF)}` : `the week of ${formatLongDate(scoringFrom)}, the week you drafted`}.</p>
        <p style="margin:0 0 10px;">Critic and audience points count for every pick that had not opened yet when you drafted.${lockedCount > 0 ? ` ${lockedCount === 1 ? 'One pick had' : `${lockedCount} picks had`} already opened, so ${lockedCount === 1 ? 'it earns' : 'they earn'} box office and awards points only.` : ''}</p>
        <p style="margin:0 0 10px;">Awards points arrive in May and June. Final standings post after the Tony Awards on ${formatLongDate(SCORING_END)}.</p>
        <p style="margin:0;">Picks are final. Standings update every Wednesday.</p>
      </div>
      <div style="padding:0 28px 28px;text-align:center;">
        <a href="${SITE}/fantasy/leaderboard" style="display:inline-block;padding:12px 28px;background:#d4a574;color:#09090b;text-decoration:none;border-radius:10px;font-size:13px;font-weight:700;">View the leaderboard</a>
        <div style="margin-top:10px;font-size:12px;color:#6b7280;">Search the leaderboard by this email address to find your team.</div>
      </div>
    </div>
    <div style="text-align:center;padding:20px 0 0;font-size:11px;color:#374151;">
      <a href="${SITE}/fantasy" style="color:#4b5563;text-decoration:none;">broadwayscorecard.com/fantasy</a>
    </div>
  </div>
</body>
</html>`;
}

/**
 * POST /api/fantasy/draft — Submit a fantasy draft entry
 *
 * Body: { email, team_name?, league_name?, picks: string[], tiebreakers? }
 * Validates picks, budget, roster size and the draft window, then inserts to
 * Supabase and sends a confirmation email (best-effort).
 * One submission per (email, season) — returns 409 on duplicate.
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

    // Draft window
    if (isDraftClosed()) {
      return NextResponse.json({ error: 'The draft window has closed.' }, { status: 400 });
    }
    if (!isDraftOpen()) {
      return NextResponse.json({ error: `The draft opens on ${formatLongDate(DRAFT_OPENS)}.` }, { status: 400 });
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

    // Validate team_name and league_name
    const cleanTeamName = team_name ? String(team_name).trim().slice(0, 50) : null;
    const cleanLeagueName = league_name ? String(league_name).trim().toLowerCase().slice(0, 50) : null;

    // If league_name looks like a 6-char code, validate it exists
    const supabase = getServerSupabaseClient();
    if (cleanLeagueName && /^[a-z0-9]{6}$/.test(cleanLeagueName)) {
      if (supabase) {
        const { data: league } = await supabase
          .from('fantasy_leagues')
          .select('code')
          .eq('code', cleanLeagueName)
          .single();
        if (!league) {
          return NextResponse.json({ error: 'League not found. Check the invite link and try again.' }, { status: 400 });
        }
      }
    }

    // Validate picks (count, roster limit, duplicates, ids, budget)
    if (!Array.isArray(picks)) {
      return NextResponse.json({ error: 'Picks must be an array' }, { status: 400 });
    }

    const shows = getFantasyShows();
    const validation = validatePicks(picks, shows);
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Compute total cost + snapshot per-pick prices at submission time.
    // Prices are frozen for the season — snapshot preserves what the user saw,
    // even if we ever roll out a mid-season recalibration.
    const totalCost = picks.reduce((sum: number, id: string) => sum + shows[id].price, 0);
    const picksPricesSnapshot: Record<string, number> = {};
    for (const id of picks as string[]) {
      picksPricesSnapshot[id] = shows[id].price;
    }
    const config = getFantasyConfig();
    const priceVersion = config._meta.pricing?.frozenAt || config._meta.pricing?.repricedAt || config._meta.generatedAt;

    if (!supabase) {
      return NextResponse.json(
        { error: 'Database unavailable. Please try again later.' },
        { status: 503 }
      );
    }

    // Insert only — one submission per (email, season). Duplicate email returns 409.
    const row = {
      email: normalizedEmail,
      team_name: cleanTeamName,
      league_name: cleanLeagueName,
      picks,
      tiebreakers: tiebreakers && typeof tiebreakers === 'object' ? tiebreakers : null,
      total_cost: totalCost,
      season: FANTASY_SEASON,
      picks_prices_snapshot: picksPricesSnapshot,
      price_version_at_submission: priceVersion,
    };

    const { data: inserted, error: dbError } = await supabase
      .from('fantasy_entries')
      .insert(row)
      .select('created_at')
      .single();

    if (dbError) {
      if (dbError.code === '23505') {
        return NextResponse.json(
          { error: 'This email has already submitted a team for this season. Picks are final.' },
          { status: 409 }
        );
      }
      console.error('Fantasy draft insert error:', dbError);
      return NextResponse.json(
        { error: 'Failed to save entry. Please try again.' },
        { status: 500 }
      );
    }

    const createdAt: string = inserted?.created_at || new Date().toISOString();
    const scoringFrom = scoringFromDate(createdAt);
    const pickSummary = (picks as string[]).map(id => ({
      title: shows[id].title,
      price: shows[id].price,
      openingDate: shows[id].openingDate ?? null,
      // Same rule as computeLeaderboard: opened on or before the New York draft day.
      locked: isScoreLockedForEntry(shows[id].openingDate, createdAt),
    }));

    // Confirmation email — best-effort; the entry is already stored above.
    let emailSent = false;
    if (RESEND_API_KEY) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: FROM_EMAIL,
            reply_to: REPLY_TO_EMAIL,
            to: [normalizedEmail],
            subject: `Your Broadway Fantasy League team${cleanTeamName ? `: ${cleanTeamName}` : ''}`,
            html: buildConfirmationHtml({
              teamName: cleanTeamName,
              leagueName: cleanLeagueName,
              createdAt,
              picks: pickSummary,
              totalCost,
            }),
          }),
        });
        if (res.ok) emailSent = true;
        else console.error('Fantasy confirmation email failed:', res.status, (await res.text()).slice(0, 200));
      } catch (emailErr) {
        console.error('Fantasy confirmation email threw:', emailErr instanceof Error ? emailErr.message : String(emailErr));
      }
    }

    return NextResponse.json({
      success: true,
      message: 'Draft submitted successfully!',
      team_name: cleanTeamName,
      total_cost: totalCost,
      scoring_from: scoringFrom,
      locked_picks: pickSummary.filter(p => p.locked).map(p => p.title),
      roster_limit: FANTASY_TEAM_SIZE,
      email_sent: emailSent,
    });
  } catch (err) {
    console.error('Fantasy draft error:', err);
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.' },
      { status: 500 }
    );
  }
}
