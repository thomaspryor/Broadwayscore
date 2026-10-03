/**
 * Shared Plans: read one share through get_shared_plans() (BRO-4481).
 *
 * Three outcomes the page must keep apart:
 *   ok           — render it
 *   not-shared   — unknown, stopped or reset link → the neutral 404 page
 *   unavailable  — the database (or its config) failed → a "try again" 503.
 *                  Never a 404: a blip must not look like the owner turned
 *                  sharing off.
 *
 * Reads are never cached: a share that was just stopped must stop showing.
 */
import { getServerSupabaseClient } from '@/lib/supabase-server';
import type { SharedPlansPayload } from './select';

export type LoadSharedPlansResult =
  | { status: 'ok'; payload: SharedPlansPayload }
  | { status: 'not-shared' }
  | { status: 'unavailable' };

/** Same format the database CHECKs; anything else can't be a real link. */
export const SHARE_TOKEN_RE = /^[a-f0-9]{32}$/;

/** A fetch that opts out of Next's fetch/Data Cache. */
export const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: 'no-store' });

/** The slice of a Supabase client this module uses (injectable for tests). */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

function isPayload(v: unknown): v is SharedPlansPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.name === 'string'
    && typeof p.showBooked === 'boolean'
    && typeof p.showUnbooked === 'boolean'
    && Array.isArray(p.entries)
    && p.entries.every(e => e && typeof e === 'object'
      && typeof (e as Record<string, unknown>).show_id === 'string'
      && ((e as Record<string, unknown>).planned_date === null || typeof (e as Record<string, unknown>).planned_date === 'string')
      && typeof (e as Record<string, unknown>).logged === 'boolean');
}

export async function loadSharedPlansWith(token: string, client: RpcClient | null): Promise<LoadSharedPlansResult> {
  // Malformed tokens never touch the database.
  if (!SHARE_TOKEN_RE.test(token)) return { status: 'not-shared' };
  if (!client) return { status: 'unavailable' };
  try {
    // supabase-js calls RPCs with POST, so the token travels in the body and
    // never in a URL (the function refuses GET: 20261002_plan_shares_refuse_get).
    const { data, error } = await client.rpc('get_shared_plans', { p_token: token });
    if (error) return { status: 'unavailable' };
    if (data === null || data === undefined) return { status: 'not-shared' };
    if (!isPayload(data)) return { status: 'unavailable' };
    return { status: 'ok', payload: data };
  } catch {
    return { status: 'unavailable' };
  }
}

export function loadSharedPlans(token: string): Promise<LoadSharedPlansResult> {
  return loadSharedPlansWith(token, getServerSupabaseClient({ fetch: noStoreFetch }));
}
