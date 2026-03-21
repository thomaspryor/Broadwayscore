import { createClient } from '@supabase/supabase-js';

/**
 * Server-side Supabase client for reading public data.
 * Used in server components (e.g., generateMetadata) where the browser client isn't available.
 * No auth needed — reads only data accessible via anon RLS policies.
 */
export function getServerSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
