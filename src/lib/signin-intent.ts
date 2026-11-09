/**
 * Was this sign-in started in the middle of something? (BRO-6917, Part 3)
 *
 * Someone who taps "Sign in to keep it" on a rating or a bookmark is partway
 * through a task on a show page. When they come back signed in, the page they
 * were on should show the thing they saved. The welcome setup (WelcomeSheet)
 * must stay out of the way. Setup is for people who pressed the Sign in button
 * with nothing else in mind.
 *
 * Google sign-in is a full-page redirect, so the intent is remembered in
 * localStorage (a separate key from the analytics marker, which is removed the
 * moment sign-in completes). Pure decisions plus a tiny store, no DOM and no
 * Supabase, so tests/unit/signin-intent.test.ts can require them.
 */

/** Modal contexts that come from an in-page action (see ModalContext). */
export const MIDFLOW_CONTEXTS: readonly string[] = ['rating', 'watchlist', 'watchlist_local'];

export const MIDFLOW_KEY = 'bsc_signin_midflow';
/** Same window as the analytics marker (ugc-analytics PENDING_SIGN_IN_TTL_MS). */
export const MIDFLOW_TTL_MS = 30 * 60 * 1000;

export function isMidFlowContext(context: string | null | undefined): boolean {
  return !!context && MIDFLOW_CONTEXTS.includes(context);
}

export function isMidFlowFresh(ts: number | null | undefined, now: number): boolean {
  return typeof ts === 'number' && Number.isFinite(ts) && now - ts >= -60_000 && now - ts <= MIDFLOW_TTL_MS;
}

/** The slice of Storage this module uses; tests pass a plain object. */
export interface IntentStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): IntentStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Called whenever a sign-in starts. A mid-flow start leaves a marker; any other
 * start removes a leftover one, so a header sign-in after an abandoned rating
 * sign-in is still treated as a header sign-in.
 */
export function recordSignInIntent(context: string, now: number = Date.now(), store: IntentStore | null = defaultStore()): void {
  if (!store) return;
  try {
    if (isMidFlowContext(context)) store.setItem(MIDFLOW_KEY, JSON.stringify({ context, ts: now }));
    else store.removeItem(MIDFLOW_KEY);
  } catch {
    // private mode: the welcome simply behaves as before
  }
}

/** True when a fresh mid-flow marker exists. Does not consume it. */
export function hasMidFlowSignIn(now: number = Date.now(), store: IntentStore | null = defaultStore()): boolean {
  if (!store) return false;
  try {
    const raw = store.getItem(MIDFLOW_KEY);
    if (!raw) return false;
    return isMidFlowFresh((JSON.parse(raw) as { ts?: number }).ts, now);
  } catch {
    return false;
  }
}

export function clearMidFlowSignIn(store: IntentStore | null = defaultStore()): void {
  try {
    store?.removeItem(MIDFLOW_KEY);
  } catch {
    // ignore
  }
}
