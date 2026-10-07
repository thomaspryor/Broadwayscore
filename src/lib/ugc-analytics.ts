/**
 * Analytics + error reporting for the signed-in features (accounts, ratings,
 * watchlist, lists, import).
 *
 * - trackUgc: dual-fires Vercel track() and PostHog capture (same pattern as
 *   posthog-events.ts), so the funnel is queryable in PostHog.
 * - instrumentedFetch: the fetch every Supabase call goes through (the
 *   supabase-js client via `global.fetch`, and supabase-rest.ts). Any failed
 *   REST/auth/functions response is reported once, here, so a call site that
 *   swallows its error still leaves a trace.
 * - reportUgcError: PostHog `ugc_error` for every failure; Sentry for the ones
 *   worth a human look (5xx, unexpected 4xx). Sentry's beforeSend drops events
 *   without first-party stack frames, so this always captures a freshly built
 *   Error (its stack is in our bundle).
 * - setAnalyticsUser: registers `signed_in` / `user_id` super-properties.
 *   Deliberately NOT posthog.identify(): that swaps the distinct_id TicketLink
 *   stamps into Impact subId1 hrefs and breaks the PostHog↔Impact join.
 */
import { track } from '@vercel/analytics';

type Primitive = string | number | boolean | null;
export type UgcProps = Record<string, Primitive | undefined>;

interface PostHogLike {
  capture?: (event: string, props?: Record<string, unknown>, opts?: { timestamp?: Date }) => void;
  register?: (props: Record<string, unknown>) => void;
  unregister?: (prop: string) => void;
}

function posthog(): PostHogLike | undefined {
  return (window as unknown as { posthog?: PostHogLike }).posthog;
}

function clean(props: UgcProps): Record<string, Primitive> {
  const out: Record<string, Primitive> = {};
  for (const [k, v] of Object.entries(props)) if (v !== undefined) out[k] = v;
  return out;
}

// PostHog loads at idle time (AnalyticsWrapper), and the OAuth callback page
// redirects ~100ms after SIGNED_IN, so events fired early would be dropped.
// They wait in a per-tab outbox (sessionStorage survives the redirect) and are
// sent by flushUgcOutbox() once PostHog is up.
const OUTBOX_KEY = 'bsc_ugc_outbox';
const OUTBOX_MAX = 25;
interface OutboxItem { e: string; p: Record<string, Primitive>; t: number }
let memoryOutbox: OutboxItem[] = [];

function readOutbox(): OutboxItem[] {
  try {
    const raw = sessionStorage.getItem(OUTBOX_KEY);
    return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
  } catch {
    return memoryOutbox;
  }
}

function writeOutbox(items: OutboxItem[]): void {
  memoryOutbox = items;
  try {
    if (items.length) sessionStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
    else sessionStorage.removeItem(OUTBOX_KEY);
  } catch {
    // memoryOutbox already holds it
  }
}

function phCapture(event: string, props: Record<string, Primitive>): void {
  try {
    const ph = posthog();
    if (ph?.capture) {
      ph.capture(event, props);
      return;
    }
    writeOutbox([...readOutbox(), { e: event, p: props, t: Date.now() }].slice(-OUTBOX_MAX));
  } catch {
    // tracking is never critical
  }
}

/** Called by AnalyticsWrapper once PostHog has loaded. */
export function flushUgcOutbox(): void {
  if (typeof window === 'undefined') return;
  const ph = posthog();
  if (!ph?.capture) return;
  const items = readOutbox();
  if (!items.length) return;
  writeOutbox([]);
  for (const it of items) {
    try {
      ph.capture(it.e, it.p, { timestamp: new Date(it.t) });
    } catch {
      // ignore
    }
  }
}

export function trackUgc(event: string, props: UgcProps = {}): void {
  if (typeof window === 'undefined') return;
  const p = clean(props);
  try {
    track(event, p);
  } catch {
    // tracking is never critical
  }
  phCapture(event, p);
}

// ─── Errors ──────────────────────────────────────────────────────────────

export interface UgcErrorInfo {
  message: string;
  code?: string | null;
  status?: number | null;
}

// PostgREST "0 rows for .single()" (loadProfile on a brand-new user) is an
// expected outcome, not a failure.
const IGNORED_CODES = new Set(['PGRST116']);
// auth-js counts these /logout answers as a finished sign-out: the session was
// already expired or revoked, or the account was just deleted (every
// successful account deletion ends with one).
const LOGOUT_DONE_STATUSES = new Set([401, 403, 404]);

/** Outcomes that look like errors on the wire but aren't failures. */
export function ignoredUgcError(op: string, info: UgcErrorInfo): boolean {
  if (info.code && IGNORED_CODES.has(info.code)) return true;
  return op === 'auth logout' && info.status != null && LOGOUT_DONE_STATUSES.has(info.status);
}
// Reported to PostHog (counted) but not Sentry: user-side or already handled.
const QUIET_CODES = new Set(['network', 'no_session', '23505']);
const SENTRY_THROTTLE_MS = 60_000;
const lastSentry = new Map<string, number>();

export function sentryWorthy(op: string, info: UgcErrorInfo): boolean {
  if (info.code && QUIET_CODES.has(info.code)) return false;
  const s = info.status ?? 0;
  // 401 = expired/revoked session. A 4xx from the auth server (stale refresh
  // token after a sign-out elsewhere, expired JWT) is normal session
  // lifecycle too. Counted in PostHog only.
  if (s === 401) return false;
  if (op.startsWith('auth ') && s >= 400 && s < 500) return false;
  return true;
}

export function reportUgcError(op: string, info: UgcErrorInfo, extra: UgcProps = {}): void {
  if (typeof window === 'undefined') return;
  if (ignoredUgcError(op, info)) return;
  const code = info.code ?? (info.status != null ? String(info.status) : 'error');
  phCapture('ugc_error', clean({
    op,
    error_code: code,
    http_status: info.status ?? null,
    error_message: (info.message || '').slice(0, 200),
    path: window.location.pathname,
    ...extra,
  }));

  if (!sentryWorthy(op, info)) return;
  const key = `${op}|${code}`;
  const now = Date.now();
  if (now - (lastSentry.get(key) ?? 0) < SENTRY_THROTTLE_MS) return;
  lastSentry.set(key, now);
  try {
    const sentry = window.Sentry;
    if (!sentry?.captureException) return;
    // Message must not match AnalyticsWrapper's ignoreErrors (e.g. "Failed to fetch").
    const err = new Error(`UGC ${op} failed (${code})`);
    err.name = 'UgcError';
    sentry.captureException(err, {
      tags: { ugc_op: op, ugc_code: code },
      extra: { message: info.message, status: info.status ?? null, ...clean(extra) },
      fingerprint: ['ugc', op, code],
    });
  } catch {
    // never throw into a save path
  }
}

/**
 * A page crash caught by app/error.tsx or app/global-error.tsx. React error
 * boundaries swallow the error, so Sentry's global handlers never see it and
 * a crash left no trace at all (BRO-4615). PostHog `page_crash` counts it;
 * Sentry gets the original Error (its stack is in our bundle, so beforeSend
 * keeps it). PostHog/Sentry redact private-share paths at send time.
 */
export function reportPageCrash(error: Error & { digest?: string }, boundary: 'page' | 'root'): void {
  if (typeof window === 'undefined') return;
  phCapture('page_crash', clean({
    boundary,
    error_name: error?.name || 'Error',
    error_message: String(error?.message || '').slice(0, 200),
    digest: error?.digest,
    path: window.location.pathname,
  }));
  try {
    window.Sentry?.captureException?.(error, { tags: { error_boundary: boundary }, extra: { digest: error?.digest ?? null } });
  } catch {
    // never throw from an error page
  }
}

/** "POST /rest/v1/reviews?x=y" → "insert reviews"; rpc/auth/functions likewise. */
export function describeSupabaseOp(url: string, method = 'GET'): string | null {
  let path: string;
  try {
    path = new URL(url, 'https://x.invalid').pathname;
  } catch {
    return null;
  }
  const m = path.match(/\/(rest|auth|functions)\/v1\/(.+)$/);
  if (!m) return null;
  const [, kind, rest] = m;
  if (kind === 'rest') {
    if (rest.startsWith('rpc/')) return `rpc ${rest.slice(4)}`;
    const verb = ({ GET: 'select', HEAD: 'select', POST: 'insert', PATCH: 'update', DELETE: 'delete' } as Record<string, string>)[method.toUpperCase()] || method;
    return `${verb} ${rest.split('/')[0]}`;
  }
  return `${kind} ${rest.split('/')[0]}`;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method;
  return 'GET';
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

// A full-page navigation kills in-flight requests, and the browser rejects them
// as a plain network TypeError ("Failed to fetch" / "Load failed"), not an
// AbortError. The OAuth callback redirects while AuthContext is still loading
// the profile, so without this every sign-up logged a false ugc_error.
// The window is bounded: a beforeunload that doesn't navigate (a cancelled
// prompt, a mailto: link) must not hide real failures for the rest of the visit.
const LEAVING_WINDOW_MS = 10_000;
let leavingSince = 0;
let leaveListenersInstalled = false;

/** Call right before a scripted navigation (location.href / replace). */
export function markPageLeaving(): void {
  leavingSince = Date.now();
}

export function pageIsLeaving(): boolean {
  return leavingSince > 0 && Date.now() - leavingSince < LEAVING_WINDOW_MS;
}

function installLeaveListeners(): void {
  if (leaveListenersInstalled || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  leaveListenersInstalled = true;
  window.addEventListener('beforeunload', markPageLeaving);
  window.addEventListener('pagehide', markPageLeaving);
  // Back/forward cache restore: the page is live again.
  window.addEventListener('pageshow', () => { leavingSince = 0; });
}

/** Drop-in fetch for Supabase traffic that reports failures, then behaves exactly like fetch. */
export const instrumentedFetch: typeof fetch = async (input, init) => {
  installLeaveListeners();
  const op = describeSupabaseOp(urlOf(input), methodOf(input, init));
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    // Aborts are caller-initiated (unmount, superseded request), not failures;
    // so is a request the browser cancelled because the page is navigating away.
    const aborted = (e instanceof DOMException && e.name === 'AbortError') || pageIsLeaving();
    if (op && !aborted) reportUgcError(op, { message: e instanceof Error ? e.message : String(e), code: 'network' });
    throw e;
  }
  if (!res.ok && op) {
    const body = await res.clone().json().catch(() => ({})) as Record<string, unknown>;
    const message = String(body.message || body.error_description || body.msg || body.error || `HTTP ${res.status}`);
    const code = (body.code ?? body.error_code ?? null) as string | null;
    reportUgcError(op, { message, code: code != null ? String(code) : null, status: res.status });
  }
  return res;
};

// ─── Who is signed in ────────────────────────────────────────────────────

// undefined = auth not resolved yet (don't stamp anything); null = signed out.
let currentUserId: string | null | undefined;

export function setAnalyticsUser(userId: string | null): void {
  currentUserId = userId;
  applyAnalyticsUser();
}

/** Re-applied by AnalyticsWrapper once PostHog / Sentry finish their deferred load. */
export function applyAnalyticsUser(): void {
  if (typeof window === 'undefined' || currentUserId === undefined) return;
  try {
    const ph = posthog();
    if (currentUserId) {
      ph?.register?.({ signed_in: true, user_id: currentUserId });
    } else {
      ph?.unregister?.('user_id');
      ph?.register?.({ signed_in: false });
    }
  } catch {
    // ignore
  }
  try {
    window.Sentry?.setUser?.(currentUserId ? { id: currentUserId } : null);
  } catch {
    // ignore
  }
}

// ─── Sign-in funnel ──────────────────────────────────────────────────────

const PENDING_SIGN_IN_KEY = 'bsc_signin_pending';
// Google is a full-page redirect, so "started" and "completed" happen on
// different page loads; a localStorage marker joins them.
const PENDING_SIGN_IN_TTL_MS = 30 * 60 * 1000;
const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

export function markSignInStarted(provider: string, context: string): void {
  trackUgc('sign_in_started', { provider, context });
  try {
    localStorage.setItem(PENDING_SIGN_IN_KEY, JSON.stringify({ provider, context, ts: Date.now() }));
  } catch {
    // ignore
  }
}

/** `context` null = read it from the pending marker (the OAuth callback page doesn't know it). */
export function markSignInFailed(provider: string, context: string | null, reason: string): void {
  let ctx = context;
  try {
    if (ctx == null) {
      const raw = localStorage.getItem(PENDING_SIGN_IN_KEY);
      ctx = raw ? (JSON.parse(raw) as { context?: string }).context ?? null : null;
    }
    localStorage.removeItem(PENDING_SIGN_IN_KEY);
  } catch {
    // ignore
  }
  trackUgc('sign_in_failed', { provider, context: ctx, reason: reason.slice(0, 120) });
}

/**
 * Called on every SIGNED_IN event. supabase-js also emits SIGNED_IN for
 * restored sessions and tab refocus, so this only counts a completion when a
 * sign-in was actually started on this device recently.
 */
export function markSignInCompleted(user: { app_metadata?: { provider?: string }; created_at?: string }): void {
  let pending: { provider?: string; context?: string; ts?: number } | null = null;
  try {
    const raw = localStorage.getItem(PENDING_SIGN_IN_KEY);
    pending = raw ? JSON.parse(raw) : null;
    localStorage.removeItem(PENDING_SIGN_IN_KEY);
  } catch {
    pending = null;
  }
  if (!pending?.ts || Date.now() - pending.ts > PENDING_SIGN_IN_TTL_MS) return;
  const created = user.created_at ? Date.parse(user.created_at) : NaN;
  trackUgc('sign_in_completed', {
    provider: user.app_metadata?.provider || pending.provider || null,
    context: pending.context || null,
    is_new_user: Number.isFinite(created) ? Date.now() - created < NEW_USER_WINDOW_MS : null,
    seconds_to_complete: Math.round((Date.now() - pending.ts) / 1000),
  });
}
