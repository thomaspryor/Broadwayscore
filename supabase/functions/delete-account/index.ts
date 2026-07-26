/**
 * delete-account — permanently deletes the calling user's account and all
 * associated rows (App Store Guideline 5.1.1(v): apps offering account
 * creation must offer in-app account deletion).
 *
 * Security model:
 * - verify_jwt ON (platform-enforced): signed-in users only.
 * - The target user is ALWAYS the caller's own id (from the verified JWT) —
 *   no userId is ever accepted from the request body, so there's no path to
 *   delete another account.
 * - Row deletes use the service-role key (RLS-bypassing) so a single call
 *   cleans up every table the client itself writes to, then the auth user
 *   is removed via the Admin API. Deletes run in dependent-first order;
 *   deleting rows for a user with no data at a given table is a no-op, so
 *   this doesn't assume any specific starting state.
 *
 * Error contract (single channel — the client checks body.ok, never status):
 * HTTP 200 with {ok:false, error: 'unauthorized'|'internal'} for handled
 * failures; non-200 only for bugs.
 */

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

/** The platform already verified the JWT signature (verify_jwt on); we only
 *  need the subject claim to scope every delete to the caller's own rows. */
function userIdFromJwt(req: Request): string | null {
  try {
    const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Delete every row in `table` matching `column = userId`. Missing rows are
 *  a no-op; only a real request failure throws. */
async function deleteRows(base: string, auth: Record<string, string>, table: string, column: string, userId: string): Promise<void> {
  const res = await fetch(`${base}/rest/v1/${table}?${column}=eq.${userId}`, {
    method: 'DELETE',
    headers: auth,
  });
  if (!res.ok) throw new Error(`delete ${table} failed: ${res.status}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'internal' }, 405);

  const userId = userIdFromJwt(req);
  if (!userId) return json(req, { ok: false, error: 'unauthorized' });

  const base = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!base || !serviceKey) return json(req, { ok: false, error: 'internal' });
  const auth = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  try {
    // list_items references lists.id, not the user directly — resolve the
    // caller's list ids first so their items are cleaned up before the lists.
    const listsRes = await fetch(`${base}/rest/v1/lists?user_id=eq.${userId}&select=id`, { headers: auth });
    if (!listsRes.ok) throw new Error(`fetch lists failed: ${listsRes.status}`);
    const lists: { id: string }[] = await listsRes.json();
    for (const { id } of lists) {
      await deleteRows(base, auth, 'list_items', 'list_id', id);
    }

    await deleteRows(base, auth, 'lists', 'user_id', userId);
    await deleteRows(base, auth, 'watchlist', 'user_id', userId);
    await deleteRows(base, auth, 'reviews', 'user_id', userId);
    await deleteRows(base, auth, 'push_tokens', 'user_id', userId);
    await deleteRows(base, auth, 'profiles', 'id', userId);

    const deleteUserRes = await fetch(`${base}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: auth,
    });
    if (!deleteUserRes.ok) throw new Error(`delete auth user failed: ${deleteUserRes.status}`);

    return json(req, { ok: true });
  } catch (e) {
    console.error('[delete-account] failed:', e instanceof Error ? e.message : e);
    return json(req, { ok: false, error: 'internal' });
  }
});
