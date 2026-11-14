import type { SupabaseClient } from '@supabase/supabase-js';
import { instrumentedFetch, reportUgcError } from './ugc-analytics';

/**
 * Supabase client singleton for browser use.
 *
 * The SDK (~45kB gzipped) is loaded with a dynamic import on first use, so
 * it stays out of the bundle every page ships. Anonymous visitors never load
 * it: AuthProvider only asks for the client when a stored session or an
 * OAuth return is present, or when sign-in starts.
 *
 * CRITICAL: Resolves to null in two cases:
 * 1. During Node.js SSG build (typeof window === 'undefined')
 * 2. When env vars are missing (feature flag OFF or unconfigured)
 *
 * All consumers MUST handle null gracefully.
 * Uses localStorage for session persistence (works with static export).
 */

export const SUPABASE_STORAGE_KEY = 'bsc_auth';

let supabaseClient: SupabaseClient | null = null;
let clientPromise: Promise<SupabaseClient | null> | null = null;
const readyListeners = new Set<(client: SupabaseClient) => void>();

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

/** True in the browser when the Supabase env vars are set. Sync, loads nothing. */
export function isSupabaseConfigured(): boolean {
  if (typeof window === 'undefined') return false;
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

/** True when this browser holds a saved sign-in (read without loading the SDK). */
export function hasStoredSupabaseSession(): boolean {
  try {
    return window.localStorage.getItem(SUPABASE_STORAGE_KEY) !== null;
  } catch {
    // Storage blocked: the SDK could not have saved a session either.
    return false;
  }
}

/**
 * True when the URL carries an OAuth result the SDK must read
 * (detectSessionInUrl). Mirrors auth-js's implicit-flow check (this client
 * uses the default implicit flow, so a ?code= is not ours): a token or an
 * error, in the hash or the query. GoTrue sends people to site_url (the
 * homepage) when redirectTo is not allow-listed, so this cannot be limited
 * to the callback pages.
 */
const AUTH_RESULT_PARAM_RE = /(^|[#?&])(access_token|error|error_code|error_description)=/;
export function urlHasAuthResult(): boolean {
  try {
    const { hash, search } = window.location;
    return AUTH_RESULT_PARAM_RE.test(hash) || AUTH_RESULT_PARAM_RE.test(search);
  } catch {
    return false;
  }
}

/**
 * Run `cb` once the client exists, without loading it. Fires at once when it
 * is already loaded. Returns an unsubscribe.
 */
export function onSupabaseClientReady(cb: (client: SupabaseClient) => void): () => void {
  if (supabaseClient) {
    cb(supabaseClient);
    return () => {};
  }
  readyListeners.add(cb);
  return () => { readyListeners.delete(cb); };
}

/** The shared client, loading the SDK on first call. */
export function getSupabaseClient(): Promise<SupabaseClient | null> {
  if (!isSupabaseConfigured()) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import('@supabase/supabase-js').then(({ createClient }) => {
      if (!supabaseClient) {
        supabaseClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
          auth: {
            persistSession: true,
            storageKey: SUPABASE_STORAGE_KEY,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            lock: simpleLock,
          },
          // Every REST/auth/functions call reports its failures (ugc-analytics.ts),
          // including the ones a call site handles quietly.
          global: { fetch: instrumentedFetch },
        });
        // Synchronously, before any caller gets the client, so AuthProvider's
        // auth listener is attached before a sign-in can fire SIGNED_IN.
        const client = supabaseClient;
        readyListeners.forEach(cb => {
          try {
            cb(client);
          } catch (err) {
            reportUgcError('supabase.ready_listener', { message: err instanceof Error ? err.message : String(err), code: 'exception' });
          }
        });
        readyListeners.clear();
      }
      return supabaseClient;
    }).catch((err: unknown) => {
      // A failed chunk load (offline, deploy swap) or a createClient throw
      // resolves null like a missing config, which every caller handles, and
      // does not stick: the next call tries again.
      clientPromise = null;
      reportUgcError('supabase.load', { message: err instanceof Error ? err.message : String(err), code: 'load_failed' });
      return null;
    });
  }
  return clientPromise;
}
