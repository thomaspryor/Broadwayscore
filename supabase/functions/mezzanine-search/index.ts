/**
 * mezzanine-search — live search against Mezzanine's (theaterdiary.com) full
 * production catalog, for the "can't find it? search the wider catalog"
 * Add-show affordance and the per-row import "find it" button (Notion
 * 39d637c5, card 174 — Phase 2 of the self-heal loop started by #170/#173).
 *
 * Security model (same as show-score-proxy):
 * - verify_jwt ON (platform-enforced): signed-in users only.
 * - Per-user rate limit via mezzanine_search_log (service role) — a sibling
 *   table to import_fetch_log so this budget doesn't contend with Show Score
 *   profile imports.
 * - The client sends either a free-text query OR a known mezzShowId (from a
 *   Mezzanine-export unmatched-import row) — never an upstream URL, so
 *   there's no SSRF surface.
 *
 * Error contract (single channel — the client checks body.ok, never status):
 * HTTP 200 with {ok:false, error: 'invalid_query'|'unauthorized'|
 * 'rate_limited'|'upstream_auth'|'internal'} for all handled failures;
 * non-200 only for bugs. Mirrored by MezzanineSearchResponse in
 * src/lib/mezzanine-search.ts.
 */
import { findShowsByTitle, findProductionsForShow } from './parse-client.mjs';
import { productionToCandidate, rankCandidates, normalizeQuery } from './classify.mjs';

const MAX_CALLS_PER_HOUR = 20;
const MAX_QUERY_LEN = 100;

const ALLOWED_ORIGINS = [
  'https://broadwayscorecard.com',
  'https://www.broadwayscorecard.com',
  'https://demo.broadwayscorecard.com',
];
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCALHOST_RE = /^http:\/\/localhost:\d+$/;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowed =
    ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin) || LOCALHOST_RE.test(origin)
      ? origin
      : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

function userIdFromJwt(req: Request): string | null {
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Insert-first, count-after — see show-score-proxy/index.ts for the full
 *  rationale (fails closed on a log-insert error, concurrent calls see each
 *  other, rejected calls still consume a slot). */
async function checkAndLogRateLimit(userId: string, query: string): Promise<boolean> {
  const base = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !key) throw new Error('missing service credentials');
  const auth = { apikey: key, Authorization: `Bearer ${key}` };

  const insertRes = await fetch(`${base}/rest/v1/mezzanine_search_log`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, query: query.slice(0, MAX_QUERY_LEN) }),
  });
  if (!insertRes.ok) throw new Error(`rate-limit log insert failed: ${insertRes.status}`);

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const countRes = await fetch(
    `${base}/rest/v1/mezzanine_search_log?user_id=eq.${userId}&created_at=gte.${since}&select=id`,
    { headers: { ...auth, Prefer: 'count=exact', Range: '0-0' } },
  );
  const range = countRes.headers.get('content-range') || '/0';
  const count = parseInt(range.split('/')[1], 10) || 0;
  return count <= MAX_CALLS_PER_HOUR;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'invalid_query' }, 405);

  const appId = Deno.env.get('MEZZANINE_APP_ID');
  const sessionToken = Deno.env.get('MEZZANINE_SESSION_TOKEN');
  if (!appId || !sessionToken) return json(req, { ok: false, error: 'internal' }, 500);

  try {
    const { query: rawQuery, mezzShowId } = await req.json().catch(() => ({ query: '' }));
    const query = String(rawQuery || '').trim();
    const exactShowId = typeof mezzShowId === 'string' && /^[a-zA-Z0-9]{1,40}$/.test(mezzShowId) ? mezzShowId : null;
    if (!exactShowId && (query.length < 2 || query.length > MAX_QUERY_LEN)) {
      return json(req, { ok: false, error: 'invalid_query' });
    }
    // Mezzanine's searchableName field keeps a single space between words
    // (verified live 2026-07-14: 'cocktailmagique' finds nothing,
    // 'cocktail magique' does) — do NOT strip spaces before the regex.
    // Validated (and rejected if empty) BEFORE the rate-limit check below —
    // a punctuation-only raw query ("!!", length 2) would otherwise still
    // burn a rate-limit slot before normalizing down to nothing.
    const normalized = exactShowId ? null : normalizeQuery(query);
    if (!exactShowId && !normalized) return json(req, { ok: false, error: 'invalid_query' });

    const userId = userIdFromJwt(req);
    if (!userId) return json(req, { ok: false, error: 'unauthorized' });
    if (!(await checkAndLogRateLimit(userId, exactShowId || query))) {
      return json(req, { ok: false, error: 'rate_limited' });
    }

    let productions: unknown[] = [];
    if (exactShowId) {
      productions = await findProductionsForShow(exactShowId, appId, sessionToken);
    } else {
      const shows = await findShowsByTitle(normalized as string, appId, sessionToken);
      // Cap fan-out: each show needs its own Productions query, so a broad
      // regex hit (common short titles) can't turn one search into dozens of
      // upstream calls per request.
      for (const show of shows.slice(0, 5)) {
        const prods = await findProductionsForShow((show as { objectId: string }).objectId, appId, sessionToken);
        productions.push(...prods);
      }
    }

    const candidates = productions
      .map((p) => productionToCandidate(p as Record<string, unknown>))
      .filter((c): c is NonNullable<typeof c> => c !== null);
    const ranked = rankCandidates(candidates, 10);

    return json(req, { ok: true, candidates: ranked, truncated: candidates.length > ranked.length });
  } catch (e) {
    if ((e as { authFailed?: boolean }).authFailed) {
      console.error('mezzanine-search upstream auth failure:', e);
      return json(req, { ok: false, error: 'upstream_auth' });
    }
    console.error('mezzanine-search error:', e);
    return json(req, { ok: false, error: 'internal' }, 500);
  }
});
