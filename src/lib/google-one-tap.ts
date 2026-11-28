/**
 * Google One Tap on desktop (BRO-6917, Part 5).
 *
 * A small "Continue as <name>" card Google draws in the top-right corner for
 * a visitor who is signed in to Google in this browser. It is never a
 * full-screen pop-up: Google (or Chrome, through FedCM) owns the card, we only
 * decide WHEN to ask and what to do with the credential it hands back.
 *
 * The decisions live here as pure functions so tests/unit/google-one-tap.test.ts
 * can require them; GoogleOneTap.tsx is the thin React shell around them.
 *
 * Sign-in itself reuses Supabase's signInWithIdToken (AuthContext), the same
 * path Apple uses. Supabase has "skip nonce check" on for Google, so no nonce.
 */

/**
 * The WEB OAuth client. It is the first id in Supabase's
 * external_google_client_id (the same one scripts/supabase-custom-domain.mjs
 * probes against the web redirect URI); the second is the iOS app's. A client
 * id is public (it is in every Google sign-in URL), so it ships in the bundle.
 * The env var wins when set.
 */
export const GOOGLE_WEB_CLIENT_ID =
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID
  || '1084460721483-0vvpcngt1065dgii0ds0lhd6mpf8d5r8.apps.googleusercontent.com';

/** Wait this long after the page loads, so it never competes with first paint. */
export const ONE_TAP_DELAY_MS = 8000;
/** After the visitor closes our card, stay quiet this long (Google adds its own cooldown). */
export const ONE_TAP_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
export const ONE_TAP_DISMISSED_KEY = 'bsc_onetap_dismissed';
/** One ask per browser session, however many pages they read. */
export const ONE_TAP_SESSION_KEY = 'bsc_onetap_asked';
/** The source name on sign_in_prompt_shown / started / completed (account-metrics.js labels it). */
export const ONE_TAP_SOURCE = 'one_tap';

/** Desktop only: a wide screen with a mouse. Phones get the normal sign-in box. */
export const DESKTOP_QUERY = '(min-width: 1024px) and (hover: hover) and (pointer: fine)';

/**
 * Pages where a sign-in card would be wrong: the OAuth return pages (it would
 * race the session they carry), embeds, admin tools, API routes, and the
 * email-link pages. Matched on the path prefix.
 */
export const ONE_TAP_EXCLUDED_PREFIXES: readonly string[] = ['/auth', '/embed', '/admin', '/api', '/unsubscribe', '/unfollow', '/reset', '/preview', '/dev', '/test'];

export function isOneTapPath(pathname: string): boolean {
  return !ONE_TAP_EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export type OneTapSkip =
  | 'no_client_id' | 'signed_in' | 'auth_loading' | 'modal_open' | 'not_desktop'
  | 'excluded_path' | 'cooldown' | 'asked_this_session' | 'signin_param';

export interface OneTapContext {
  clientId: string | null | undefined;
  signedIn: boolean;
  authLoading: boolean;
  /** The normal sign-in box is open: two sign-in prompts at once is noise. */
  modalOpen: boolean;
  desktop: boolean;
  pathname: string;
  /** ms epoch the visitor last closed the card, or null. */
  dismissedAt: number | null;
  askedThisSession: boolean;
  /** `?signin=1` links (the account line in our emails) open the full box instead. */
  hasSignInParam: boolean;
  now: number;
}

/** Whether to ask right now, and if not, why not (the reason is for tests and tracking). */
export function oneTapDecision(c: OneTapContext): { ask: true } | { ask: false; reason: OneTapSkip } {
  if (!c.clientId) return { ask: false, reason: 'no_client_id' };
  if (c.signedIn) return { ask: false, reason: 'signed_in' };
  if (c.authLoading) return { ask: false, reason: 'auth_loading' };
  if (c.modalOpen) return { ask: false, reason: 'modal_open' };
  if (!c.desktop) return { ask: false, reason: 'not_desktop' };
  if (!isOneTapPath(c.pathname)) return { ask: false, reason: 'excluded_path' };
  if (c.hasSignInParam) return { ask: false, reason: 'signin_param' };
  if (c.askedThisSession) return { ask: false, reason: 'asked_this_session' };
  if (c.dismissedAt != null && Number.isFinite(c.dismissedAt) && c.now - c.dismissedAt >= -60_000 && c.now - c.dismissedAt < ONE_TAP_COOLDOWN_MS) {
    return { ask: false, reason: 'cooldown' };
  }
  return { ask: true };
}

/** The slice of Storage this module uses; tests pass a plain object. */
export interface KeyStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeStore(kind: 'local' | 'session'): KeyStore | null {
  try {
    if (typeof window === 'undefined') return null;
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readDismissedAt(store: KeyStore | null = safeStore('local')): number | null {
  try {
    const raw = store?.getItem(ONE_TAP_DISMISSED_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function markDismissed(now: number = Date.now(), store: KeyStore | null = safeStore('local')): void {
  try {
    store?.setItem(ONE_TAP_DISMISSED_KEY, String(now));
  } catch {
    // private mode: Google's own cooldown still applies
  }
}

export function readAskedThisSession(store: KeyStore | null = safeStore('session')): boolean {
  try {
    return store?.getItem(ONE_TAP_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function markAskedThisSession(store: KeyStore | null = safeStore('session')): void {
  try {
    store?.setItem(ONE_TAP_SESSION_KEY, '1');
  } catch {
    // ignore
  }
}

// ─── Google Identity Services (the slice of the SDK we call) ─────────────

export interface GoogleCredentialResponse {
  credential?: string;
  select_by?: string;
}

/** The deprecated-but-still-sent prompt moment; FedCM browsers may send none. */
export interface GooglePromptNotification {
  isDisplayed?: () => boolean;
  isNotDisplayed?: () => boolean;
  isSkippedMoment?: () => boolean;
  isDismissedMoment?: () => boolean;
  getNotDisplayedReason?: () => string;
  getSkippedReason?: () => string;
  getDismissedReason?: () => string;
}

export interface GoogleIdApi {
  initialize: (config: {
    client_id: string;
    callback: (r: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    itp_support?: boolean;
    use_fedcm_for_prompt?: boolean;
    context?: string;
  }) => void;
  prompt: (listener?: (n: GooglePromptNotification) => void) => void;
  cancel: () => void;
}

declare global {
  interface Window {
    google?: { accounts?: { id?: GoogleIdApi } };
  }
}

export const GSI_SRC = 'https://accounts.google.com/gsi/client';

let gsiLoading: Promise<GoogleIdApi | null> | null = null;

/** Loads Google's script once. Resolves null when it is blocked or fails: One Tap is an extra, never required. */
export function loadGoogleIdentity(): Promise<GoogleIdApi | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  const ready = window.google?.accounts?.id;
  if (ready) return Promise.resolve(ready);
  if (gsiLoading) return gsiLoading;
  gsiLoading = new Promise<GoogleIdApi | null>((resolve) => {
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(window.google?.accounts?.id ?? null);
    script.onerror = () => {
      gsiLoading = null; // an ad blocker or offline: allow a later retry
      script.remove();
      resolve(null);
    };
    document.head.appendChild(script);
  });
  return gsiLoading;
}

export type OneTapOutcome =
  | { kind: 'shown' }
  | { kind: 'not_displayed'; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'dismissed'; reason: string };

/** Reads Google's prompt notification into one outcome. Null = nothing to report yet. */
export function readPromptOutcome(n: GooglePromptNotification | null | undefined): OneTapOutcome | null {
  if (!n) return null;
  try {
    if (n.isNotDisplayed?.()) return { kind: 'not_displayed', reason: n.getNotDisplayedReason?.() || 'unknown' };
    if (n.isSkippedMoment?.()) return { kind: 'skipped', reason: n.getSkippedReason?.() || 'unknown' };
    if (n.isDismissedMoment?.()) return { kind: 'dismissed', reason: n.getDismissedReason?.() || 'unknown' };
    if (n.isDisplayed?.()) return { kind: 'shown' };
  } catch {
    // a browser that removed these methods
  }
  return null;
}

/**
 * Only the visitor closing the card (X, or tapping away) starts our own
 * cooldown. Google's "dismissed" moment is credential_returned (they signed
 * in), cancel_called (we withdrew it) or flow_restarted: none is a "no".
 */
export function shouldCooldown(o: OneTapOutcome): boolean {
  // 'unknown' is a skipped moment whose reason method is gone: FedCM browsers
  // can report the skip without saying why. Treat it as a close, so the card
  // is not re-offered at every visit. Google's auto_cancel and issuing_failed
  // are not the visitor saying no.
  return o.kind === 'skipped' && (o.reason === 'user_cancel' || o.reason === 'tap_outside' || o.reason === 'unknown');
}
