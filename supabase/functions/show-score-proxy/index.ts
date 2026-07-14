/**
 * show-score-proxy — fetches a PUBLIC Show Score member profile server-side
 * and returns parsed, domain-ready review entries for the My Shows import.
 *
 * Why a proxy: the site is a static export (no API routes) and show-score.com
 * sends no CORS headers, so the browser cannot fetch it directly. Egress from
 * Supabase infra to show-score.com verified working 2026-07-13 (probe: 200,
 * 50 tiles).
 *
 * Security model:
 * - verify_jwt ON (platform-enforced): signed-in users only.
 * - The upstream URL is ALWAYS constructed here from a validated slug — the
 *   client never supplies a URL (no SSRF surface).
 * - Per-user rate limit (MAX_CALLS_PER_HOUR via import_fetch_log, service
 *   role) so the function can't be looped into a bulk Show Score scraper —
 *   sustained abuse traffic would get our shared egress IPs Cloudflare-blocked
 *   and break the import for everyone.
 *
 * Error contract (single channel — the client checks body.ok, never status):
 * HTTP 200 with {ok:false, error: 'invalid_slug'|'rate_limited'|'not_found'|
 * 'upstream_blocked'} for all handled failures; non-200 only for bugs.
 * Mirrored by ShowScoreProxyResponse in src/lib/show-import.ts.
 */
import { parseProfileHtml, parsePageCount, venueHintIsMarket, cleanVenueHint } from './parser.mjs';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/i;
const MAX_PAGES = 20; // ~50 reviews/page → 1000 reviews before truncated:true
// Failed attempts (typo'd slug → not_found) consume a slot too since logging
// is insert-first — 8 leaves headroom for a couple of typos plus real imports.
const MAX_CALLS_PER_HOUR = 8;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const ALLOWED_ORIGINS = [
  'https://broadwayscorecard.com',
  'https://www.broadwayscorecard.com',
  'https://demo.broadwayscorecard.com',
];
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCALHOST_RE = /^http:\/\/localhost:\d+$/; // dev servers use varying ports

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowed =
    ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin) || LOCALHOST_RE.test(origin)
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json' },
  });
}

/** The platform already verified the JWT signature (verify_jwt on); we only
 *  need the subject claim for rate limiting. */
function userIdFromJwt(req: Request): string | null {
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Insert-first, count-after: the audit row is written (and verified) BEFORE
 *  the limit check, so a failed insert fails CLOSED (throw → 500) instead of
 *  silently disabling the limiter, and concurrent calls each see one another
 *  in the count. Rejected calls consume a slot — fine, abusers burn their own. */
async function checkAndLogRateLimit(userId: string, slug: string): Promise<boolean> {
  const base = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) throw new Error('missing service credentials');
  const auth = { apikey: key, Authorization: `Bearer ${key}` };

  const insertRes = await fetch(`${base}/rest/v1/import_fetch_log`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, slug }),
  });
  if (!insertRes.ok) throw new Error(`rate-limit log insert failed: ${insertRes.status}`);

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const countRes = await fetch(
    `${base}/rest/v1/import_fetch_log?user_id=eq.${userId}&created_at=gte.${since}&select=id`,
    { headers: { ...auth, Prefer: 'count=exact', Range: '0-0' } },
  );
  const range = countRes.headers.get('content-range') || '/0';
  const count = parseInt(range.split('/')[1], 10) || 0;
  return count <= MAX_CALLS_PER_HOUR;
}

async function fetchProfilePage(slug: string, page: number): Promise<Response> {
  const url = `https://www.show-score.com/member/${slug}${page > 1 ? `?page=${page}` : ''}`;
  return await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'invalid_slug' }, 405);

  try {
    const { slug: rawSlug } = await req.json().catch(() => ({ slug: '' }));
    const slug = String(rawSlug || '').toLowerCase();
    if (!SLUG_RE.test(slug)) return json(req, { ok: false, error: 'invalid_slug' });

    // The anon key passes platform verify_jwt but has no sub claim — a real
    // signed-in user token is required. HTTP 200 like every handled error:
    // supabase-js invoke() throws on non-2xx, which would strand this code
    // in the client's generic "something went wrong" path instead of its
    // "sign in again" copy.
    const userId = userIdFromJwt(req);
    if (!userId) return json(req, { ok: false, error: 'unauthorized' });
    if (!(await checkAndLogRateLimit(userId, slug))) {
      return json(req, { ok: false, error: 'rate_limited' });
    }

    const first = await fetchProfilePage(slug, 1);
    if (first.status === 404) return json(req, { ok: false, error: 'not_found' });
    if (!first.ok) return json(req, { ok: false, error: 'upstream_blocked' });
    // Show Score soft-404s unknown members: 200 + redirect to a generic
    // landing page (verified live 2026-07-13). The redirect target no longer
    // contains /member/{slug}.
    if (!first.url.toLowerCase().includes(`/member/${slug}`)) {
      return json(req, { ok: false, error: 'not_found' });
    }
    const firstHtml = await first.text();

    const parsed = parseProfileHtml(firstHtml);
    // A Cloudflare challenge page 200s with zero tiles — treat a page with no
    // tiles AND no recognizable profile header as blocked.
    if (parsed.reviews.length === 0 && !parsed.displayName) {
      return json(req, { ok: false, error: 'upstream_blocked' });
    }

    const pageCount = parsePageCount(firstHtml);
    const pagesToFetch = Math.min(pageCount, MAX_PAGES);
    const reviews = [...parsed.reviews];
    let pagesFetched = 1;
    for (let page = 2; page <= pagesToFetch; page++) {
      const res = await fetchProfilePage(slug, page);
      if (!res.ok) break;
      const pageReviews = parseProfileHtml(await res.text()).reviews;
      if (pageReviews.length === 0) break;
      reviews.push(...pageReviews);
      pagesFetched = page;
    }

    return json(req, {
      ok: true,
      displayName: parsed.displayName,
      totalOnProfile: parsed.totalOnProfile,
      // Domain-ready entries: venue is null for market labels ("Broadway")
      // and stripped of production-year decorations, so the client can hand
      // it straight to venue-aware show matching without importing anything
      // from this directory.
      reviews: reviews.map((r) => ({
        ...r,
        venue: venueHintIsMarket(r.venueHint) ? null : cleanVenueHint(r.venueHint),
      })),
      unparsed: reviews.filter((r) => r.rating === null).length,
      truncated: pageCount > MAX_PAGES,
      // Mid-pagination upstream failure is NOT success-with-fewer-reviews —
      // the client must tell the user the import is partial (ship-check P1).
      incomplete: pagesFetched < pagesToFetch,
    });
  } catch (e) {
    console.error('show-score-proxy error:', e);
    return json(req, { ok: false, error: 'internal' }, 500);
  }
});
