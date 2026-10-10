import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
// Shared source of truth with scripts/affiliate-report.js. Lives under scripts/
// to keep server-only secrets (Impact/Partnerize/PostHog tokens) out of the
// Next.js client bundle graph. See memory/feedback_todaytix_affiliate_tracking.md
// for the inference logic behind the TodayTix new/existing mix.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getAffiliateStats } = require('../../../../../scripts/lib/affiliate-stats') as {
  getAffiliateStats: (opts: { days: number; includeWoW?: boolean }) => Promise<{ errors: unknown[] } & Record<string, unknown>>;
};

/**
 * Admin dashboard JSON API.
 *
 * GET /api/admin/affiliate-stats?days=7[&refresh=1]
 *
 * - Auth-gated via admin_token cookie (see src/lib/admin-auth.ts)
 * - days clamped to 1..45 (Impact API cap)
 * - Module-level Map cache with 5-minute TTL, keyed on `days`
 * - ?refresh=1 clears that key and fetches fresh
 * - Cache only populated on full success (errors.length === 0) so partial
 *   failures don't poison 5 minutes of dashboard reloads
 */

export const dynamic = 'force-dynamic';

interface CachedEntry {
  data: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<number, CachedEntry>();

export async function GET(request: NextRequest) {
  if (!isAdmin()) {
    return new NextResponse(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '7', 10);
  const refresh = searchParams.get('refresh') === '1';
  const includeWoW = searchParams.get('wow') === '1';

  const cacheKey = includeWoW ? -Math.abs(days) : Math.abs(days);

  if (refresh) {
    cache.delete(cacheKey);
  } else {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      return NextResponse.json({ ...(hit.data as object), cached: true });
    }
  }

  try {
    const stats = await getAffiliateStats({ days, includeWoW });
    // Only cache full successes
    if (Array.isArray(stats.errors) && stats.errors.length === 0) {
      cache.set(cacheKey, { data: stats, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return NextResponse.json({ ...stats, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
