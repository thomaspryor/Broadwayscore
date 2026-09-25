import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { fetchPrivateJson } from '@/lib/private-data-repo';

/**
 * Admin traffic dashboard JSON API (BRO-4136).
 *
 * GET /api/admin/traffic-stats[?refresh=1]
 *
 * - Auth-gated via admin_token cookie (isAdmin → plain 404, same as finance-stats)
 * - The payload is built weekly by analyze-traffic-sources.yml
 *   (scripts/lib/traffic-metrics.js buildDashboardData) and pushed to the
 *   PRIVATE repo at analytics/traffic-dashboard.json. Traffic numbers never
 *   enter this public repo or the static build; read here at request time.
 * - Module-level cache, 5-minute TTL; ?refresh=1 busts it.
 */

export const dynamic = 'force-dynamic';

const DASHBOARD_PATH = 'analytics/traffic-dashboard.json';
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { data: unknown; expiresAt: number } | null = null;

export async function GET(request: NextRequest) {
  if (!isAdmin()) {
    return new NextResponse(null, { status: 404 });
  }
  const token = process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'REVIEW_TEXTS_TOKEN not configured on server' }, { status: 500 });
  }
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  if (!refresh && cache && cache.expiresAt > Date.now()) {
    return NextResponse.json({ ...(cache.data as object), cached: true });
  }
  try {
    const data = await fetchPrivateJson<Record<string, unknown> | null>(DASHBOARD_PATH, token, null);
    if (!data) {
      return NextResponse.json({ error: 'No traffic data yet: the weekly traffic report has not saved a dashboard.' }, { status: 404 });
    }
    cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    return NextResponse.json({ ...data, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
