/**
 * Direct Supabase REST API helpers using fetch().
 *
 * Bypasses the Supabase JS client's internal PostgREST wrapper which
 * can lose the auth token under certain session/lock timing conditions.
 * These functions explicitly pass the access_token from getSession()
 * in the Authorization header, ensuring RLS always sees auth.uid().
 */

import { getSupabaseClient } from './supabase';

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
async function getAccessToken(): Promise<string | null> {
  const client = getSupabaseClient();
  if (!client) return null;

  // getUser() validates the token with Supabase auth server
  // and triggers a refresh if the access token is expired
  const { data: { user }, error: userErr } = await client.auth.getUser();
  if (userErr || !user) {
    // Try explicit refresh as last resort
    const { error: refreshErr } = await client.auth.refreshSession();
    if (refreshErr) return null;
  }

  // Now getSession() should have the refreshed token
  const { data: { session } } = await client.auth.getSession();
  return session?.access_token ?? null;
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

/** INSERT a row via PostgREST, returning the inserted row. */
export async function supabaseRestInsert<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
): Promise<RestResult<T>> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { data: null, error: { message: 'No valid session. Please sign in again.' } };
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers(accessToken, 'return=representation'),
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { data: null, error: { message: body.message || `HTTP ${res.status}`, code: body.code } };
  }

  const data = await res.json();
  // PostgREST returns an array; take the first item
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}

/** UPSERT a row via PostgREST. */
export async function supabaseRestUpsert(
  table: string,
  row: Record<string, unknown>,
  onConflict: string,
): Promise<RestResult> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { data: null, error: { message: 'No valid session. Please sign in again.' } };
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      ...headers(accessToken, 'return=representation,resolution=merge-duplicates'),
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { data: null, error: { message: body.message || `HTTP ${res.status}`, code: body.code } };
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
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { data: null, error: { message: 'No valid session. Please sign in again.' } };
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filters}`, {
    method: 'PATCH',
    headers: headers(accessToken, 'return=representation'),
    body: JSON.stringify(updates),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { data: null, error: { message: body.message || `HTTP ${res.status}`, code: body.code } };
  }

  const data = await res.json();
  return { data: Array.isArray(data) ? data[0] : data, error: null };
}

/** SELECT rows via PostgREST with query string params. */
export async function supabaseRestSelect<T = Record<string, unknown>>(
  table: string,
  params: string,
): Promise<RestResult<T[]>> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    return { data: null, error: { message: 'No valid session. Please sign in again.' } };
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    method: 'GET',
    headers: headers(accessToken),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { data: null, error: { message: body.message || `HTTP ${res.status}`, code: body.code } };
  }

  const data = await res.json();
  return { data: data as T[], error: null };
}
