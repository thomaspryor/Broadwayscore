/**
 * Direct Supabase REST API helpers using fetch().
 *
 * Bypasses the Supabase JS client's internal PostgREST wrapper which
 * can lose the auth token under certain session/lock timing conditions.
 * These functions explicitly pass the access_token from getSession()
 * in the Authorization header, ensuring RLS always sees auth.uid().
 */

import { getSupabaseClient } from './supabase';
import { instrumentedFetch, reportUgcError } from './ugc-analytics';
import { clearPendingAction } from './deferred-auth';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

interface RestResult<T = Record<string, unknown>> {
  data: T | null;
  error: { message: string; code?: string } | null;
}

/**
 * Get a valid access token, refreshing if necessary.
 * Uses getUser() to validate the token server-side, then reads the session.
 */
async function getAccessToken(op: string): Promise<string | RestResult<never>> {
  const client = await getSupabaseClient();
  if (!client) return noSession(op);

  // getUser() validates the token with Supabase auth server
  // and triggers a refresh if the access token is expired
  const { data: { user }, error: userErr } = await client.auth.getUser();
  if (userErr?.status === 401 || userErr?.code === 'user_not_found') {
    return accountGone(op, userErr.status);
  }
  if (userErr || !user) {
    // Try explicit refresh as last resort
    const { error: refreshErr } = await client.auth.refreshSession();
    if (refreshErr?.status === 401 || refreshErr?.code === 'user_not_found') {
      return accountGone(op, refreshErr.status);
    }
    if (refreshErr) return noSession(op);
  }

  // Now getSession() should have the refreshed token
  const { data: { session } } = await client.auth.getSession();
  return session?.access_token ?? noSession(op);
}

const NO_SESSION_MESSAGE = 'No valid session. Please sign in again.';
export const ACCOUNT_GONE_EVENT = 'bsc:account-gone';
export const ACCOUNT_GONE_MESSAGE = 'Your account no longer exists on this device; sign in again';
let signingOut: Promise<void> | null = null;

async function accountGone(op: string, status?: number): Promise<RestResult<never>> {
  reportUgcError(op, { message: ACCOUNT_GONE_MESSAGE, code: 'account_gone', status });
  // Several cards can fail together. Clear the draft before signOut emits
  // SIGNED_OUT, and show one notification for the shared recovery.
  if (!signingOut) {
    clearPendingAction();
    signingOut = getSupabaseClient().then(async client => {
      await client?.auth.signOut({ scope: 'local' });
    }).catch(() => {
      // A failed logout request must not replace the actionable save error.
    }).finally(() => {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(ACCOUNT_GONE_EVENT));
      signingOut = null;
    });
  }
  await signingOut;
  return { data: null, error: { message: ACCOUNT_GONE_MESSAGE, code: 'account_gone' } };
}

async function restError(res: Response, op: string): Promise<RestResult<never>> {
  const body = await res.json().catch(() => ({}));
  // Other FKs (show_id, list_id, etc.) are save errors, not deleted accounts.
  const missingUser = body.code === '23503'
    && /foreign key constraint "[^"\n]+_user_id_fkey"/.test(body.message || '');
  if (res.status === 401 || missingUser) return accountGone(op, res.status);
  return { data: null, error: { message: body.message || `HTTP ${res.status}`, code: body.code } };
}

/** The request never left the browser: the session expired or was revoked. */
function noSession(op: string): RestResult<never> {
  reportUgcError(op, { message: NO_SESSION_MESSAGE, code: 'no_session' });
  return { data: null, error: { message: NO_SESSION_MESSAGE } };
}

function headers(accessToken: string, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    'apikey': ANON_KEY,
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (prefer) h['Prefer'] = prefer;
  return h;
}

/** INSERT a row via PostgREST, returning the inserted row (or nothing with returning: 'minimal'). */
export async function supabaseRestInsert<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
  opts: { returning?: 'representation' | 'minimal' } = {},
): Promise<RestResult<T>> {
  const accessToken = await getAccessToken(`insert ${table}`);
  if (typeof accessToken !== 'string') return accessToken;

  const res = await instrumentedFetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers(accessToken, `return=${opts.returning ?? 'representation'}`),
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    return restError(res, `insert ${table}`);
  }

  // return=minimal sends an empty 201: nothing to parse (and a column-grant
  // table like user_show_stubs would refuse the RETURNING read anyway).
  if (opts.returning === 'minimal') return { data: null, error: null };
  const data = await res.json();
  // PostgREST returns an array; take the first item
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}

/** UPSERT a row via PostgREST. Pass `ignoreDuplicates` to keep the existing row
 *  on conflict (Prefer resolution=ignore-duplicates) instead of merging. */
export async function supabaseRestUpsert(
  table: string,
  row: Record<string, unknown>,
  onConflict: string,
  opts?: { ignoreDuplicates?: boolean },
): Promise<RestResult> {
  const accessToken = await getAccessToken(`insert ${table}`);
  if (typeof accessToken !== 'string') return accessToken;

  const resolution = opts?.ignoreDuplicates ? 'ignore-duplicates' : 'merge-duplicates';
  const conflictParam = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
  const res = await instrumentedFetch(`${SUPABASE_URL}/rest/v1/${table}${conflictParam}`, {
    method: 'POST',
    headers: headers(accessToken, `return=representation,resolution=${resolution}`),
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    return restError(res, `insert ${table}`);
  }

  const data = await res.json();
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}

/** UPDATE rows via PostgREST PATCH with filters in query string. */
export async function supabaseRestUpdate<T = Record<string, unknown>>(
  table: string,
  filters: string,
  updates: Record<string, unknown>,
): Promise<RestResult<T>> {
  const accessToken = await getAccessToken(`update ${table}`);
  if (typeof accessToken !== 'string') return accessToken;

  const res = await instrumentedFetch(`${SUPABASE_URL}/rest/v1/${table}?${filters}`, {
    method: 'PATCH',
    headers: headers(accessToken, 'return=representation'),
    body: JSON.stringify(updates),
  });

  if (!res.ok) {
    return restError(res, `update ${table}`);
  }

  const data = await res.json();
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}

/** DELETE rows via PostgREST with filters in query string. */
export async function supabaseRestDelete(
  table: string,
  filters: string,
): Promise<RestResult> {
  const accessToken = await getAccessToken(`delete ${table}`);
  if (typeof accessToken !== 'string') return accessToken;

  // return=minimal: no caller reads the deleted rows, and representation would
  // force PostgREST to serialize every cascaded row back over the wire.
  const res = await instrumentedFetch(`${SUPABASE_URL}/rest/v1/${table}?${filters}`, {
    method: 'DELETE',
    headers: headers(accessToken, 'return=minimal'),
  });

  if (!res.ok) {
    return restError(res, `delete ${table}`);
  }

  return { data: null, error: null };
}

/** Call a Postgres function (RPC) via PostgREST. */
export async function supabaseRestRpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<RestResult<T>> {
  const accessToken = await getAccessToken(`rpc ${fn}`);
  if (typeof accessToken !== 'string') return accessToken;

  const res = await instrumentedFetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(accessToken),
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    return restError(res, `rpc ${fn}`);
  }

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { data: data as T, error: null };
}

/** SELECT rows via PostgREST with query string params. */
export async function supabaseRestSelect<T = Record<string, unknown>>(
  table: string,
  params: string,
): Promise<RestResult<T[]>> {
  const accessToken = await getAccessToken(`select ${table}`);
  if (typeof accessToken !== 'string') return accessToken;

  const res = await instrumentedFetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'GET',
    headers: headers(accessToken),
  });

  if (!res.ok) {
    return restError(res, `select ${table}`);
  }

  const data = await res.json();
  return { data: data as T[], error: null };
}
