/**
 * Shared Diary: read one share through get_shared_diary() (BRO-4566).
 * Outcomes, caching and the token check live in src/lib/share-links/load.ts.
 */
import { getServerSupabaseClient } from '@/lib/supabase-server';
import { loadShareWith, noStoreFetch, type LoadShareResult, type RpcClient } from '@/lib/share-links/load';
import type { SharedDiaryPayload } from './select';

export type LoadSharedDiaryResult = LoadShareResult<SharedDiaryPayload>;

function isEntry(v: unknown, showText: boolean): boolean {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.show_id === 'string'
    && (e.date_seen === null || typeof e.date_seen === 'string')
    && typeof e.rating === 'number'
    // A note may only arrive when the owner shares notes.
    && (e.text === undefined || (showText && typeof e.text === 'string'));
}

export function isSharedDiaryPayload(v: unknown): v is SharedDiaryPayload {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return typeof p.name === 'string'
    && typeof p.showText === 'boolean'
    && typeof p.capped === 'boolean'
    && Array.isArray(p.entries)
    && p.entries.every(e => isEntry(e, p.showText as boolean));
}

export function loadSharedDiaryWith(token: string, client: RpcClient | null): Promise<LoadSharedDiaryResult> {
  return loadShareWith(token, client, 'get_shared_diary', isSharedDiaryPayload);
}

export function loadSharedDiary(token: string): Promise<LoadSharedDiaryResult> {
  return loadSharedDiaryWith(token, getServerSupabaseClient({ fetch: noStoreFetch }));
}
