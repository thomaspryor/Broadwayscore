import { createClient, SupabaseClient } from '@supabase/supabase-js';

let supabaseInstance: SupabaseClient | null = null;

/**
 * Returns a Supabase browser client singleton, or null if env vars are missing.
 * Safe to call during static build — returns null without throwing.
 */
export function getSupabaseClient(): SupabaseClient | null {
  if (typeof window === 'undefined') return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) return null;

  if (!supabaseInstance) {
    supabaseInstance = createClient(url, anonKey);
  }

  return supabaseInstance;
}
