/**
 * Shared Plans: read one share through get_shared_plans() (BRO-4481).
 * Outcomes, caching and the token check live in src/lib/share-links/load.ts.
 */
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { loadShareWith, noStoreFetch, type LoadShareResult, type RpcClient } from '@/lib/share-links/load';
import type { SharedPlansPayload } from './select';

export { noStoreFetch, type RpcClient } from '@/lib/share-links/load';

export type LoadSharedPlansResult = LoadShareResult<SharedPlansPayload>;

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

export function loadSharedPlansWith(token: string, client: RpcClient | null): Promise<LoadSharedPlansResult> {
  return loadShareWith(token, client, 'get_shared_plans', isPayload);
}

export function loadSharedPlans(token: string): Promise<LoadSharedPlansResult> {
  return loadSharedPlansWith(token, getServerSupabaseClient({ fetch: noStoreFetch }));
}
