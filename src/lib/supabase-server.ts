import { createClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client for reading public data.
 * Used in server components (e.g., generateMetadata) where the browser client isn't available.
 * No auth needed — reads only data accessible via anon RLS policies.
 *
 * `fetch` lets a caller control caching. Next 14 caches fetches made during
 * server rendering by default and its Data Cache outlives deploys, so a
 * caller reading live, revocable data (e.g. Shared Plans) passes a
 * `cache: 'no-store'` fetch here.
 */
export function getServerSupabaseClient(options?: { fetch?: typeof fetch }) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false },
    ...(options?.fetch ? { global: { fetch: options.fetch } } : {}),
  });
}
