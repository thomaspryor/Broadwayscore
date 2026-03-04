import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client singleton for browser use.
 *
 * CRITICAL: Returns null in two cases:
 * 1. During Node.js SSG build (typeof window === 'undefined')
 * 2. When env vars are missing (feature flag OFF or unconfigured)
 *
 * All consumers MUST handle null gracefully.
 * Uses localStorage for session persistence (works with static export).
 */

let supabaseClient: SupabaseClient | null = null;

/**
 * Simple in-process lock that replaces navigator.locks.
 * navigator.locks can deadlock in certain scenarios (e.g., when the
 * onAuthStateChange callback triggers a Supabase query during initialization).
 * This single-tab lock avoids the deadlock while still serializing access.
 */
const lockMap = new Map<string, Promise<unknown>>();
async function simpleLock<R>(name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> {
  const current = lockMap.get(name) ?? Promise.resolve();
  const next = current.then(() => fn(), () => fn());
  lockMap.set(name, next);
  try {
    return await next;
  } finally {
    // Clean up if this is the latest in the chain
    if (lockMap.get(name) === next) {
      lockMap.delete(name);
    }
  }
}

export function getSupabaseClient(): SupabaseClient | null {
  // Guard: Node.js SSG build
  if (typeof window === 'undefined') return null;

  // Guard: missing env vars
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  // Lazy singleton
  if (!supabaseClient) {
    supabaseClient = createClient(url, key, {
      auth: {
        persistSession: true,
        storageKey: 'bsc_auth',
        autoRefreshToken: true,
        detectSessionInUrl: true,
        lock: simpleLock,
      },
    });
  }

  return supabaseClient;
}
