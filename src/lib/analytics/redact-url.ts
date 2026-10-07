import { AUTH_RETURN_PATHS } from '../auth-redirect';

/**
 * Keep private share-link tokens (BRO-4481 plans, BRO-4566 diary) and OAuth
 * tokens (BRO-4525) out of every analytics tool.
 *
 * `/plans/<token>` and `/seen/<token>` are private, login-free links: whoever
 * holds the token can see when someone will be at the theater, or their
 * diary. PostHog (autocapture, pageviews, session replay), Vercel Analytics,
 * Speed Insights, GA and Sentry all record full URLs by default, which would
 * copy live tokens into five third-party dashboards. Every one of them routes
 * its outgoing data through this module (wired in
 * src/components/AnalyticsWrapper.tsx; tests/unit/analytics-redaction.test.ts
 * fails if one stops doing so).
 */

/**
 * THE list of private share routes (`src/app/<prefix>/[token]`). Everything
 * below, the GA init script and replay switch-off derive from it, and
 * tests/unit/private-share-routes.test.ts fails if a `[token]` route under
 * src/app is missing from it. Add a new share kind here, nowhere else.
 */
export const PRIVATE_SHARE_PREFIXES = ['plans', 'seen'] as const;
const PREFIX_ALT = PRIVATE_SHARE_PREFIXES.join('|');

/**
 * `/<prefix>/<anything up to / ? # whitespace quote or angle bracket>`.
 * Exported as a source string (+ its `$1` replacement) so the inline GA script
 * can build the same RegExp at render time instead of hand-copying it.
 */
export const PRIVATE_SHARE_SEGMENT_SOURCE = `\\/(${PREFIX_ALT})\\/[^/?#\\s"'<>]+`;
export const PRIVATE_SHARE_REDACTED = '/$1/:token';
const PRIVATE_SHARE_SEGMENT = new RegExp(PRIVATE_SHARE_SEGMENT_SOURCE, 'g');
// The same path percent-encoded, e.g. inside ?next= or a mailto:/sms: body.
const PRIVATE_SHARE_SEGMENT_ENCODED = new RegExp(`%2F(${PREFIX_ALT})%2F(?:(?!%2F|%3F|%23)[^/?#&\\s"'<>])+`, 'gi');

// Supabase's implicit OAuth flow lands on /auth/complete (or /auth/callback)#access_token=…&refresh_token=….
// auth-js only clears the hash after its follow-up user fetch succeeds, so a stalled
// sign-in leaves live tokens in the URL that Sentry / PostHog record (BRO-4525).
const AUTH_TOKEN_PARAM = /\b(access_token|refresh_token|provider_token|provider_refresh_token)=[^&#\s"'<>]+/gi;

export function redactPrivateShareUrl(value: string): string {
  return value
    .replace(AUTH_TOKEN_PARAM, '$1=:redacted')
    .replace(PRIVATE_SHARE_SEGMENT, PRIVATE_SHARE_REDACTED)
    .replace(PRIVATE_SHARE_SEGMENT_ENCODED, '%2F$1%2F%3Atoken');
}

/** True on a private share page (session replay is switched off there). */
export function isPrivateSharePath(pathname: string): boolean {
  return PRIVATE_SHARE_PREFIXES.some(p => pathname === `/${p}` || pathname.startsWith(`/${p}/`));
}

/** The OAuth return pages carry live tokens in their hash; session replay stays off there (BRO-4525, BRO-4822). */
export function isAuthCallbackPath(pathname: string): boolean {
  return AUTH_RETURN_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Redact every string inside an analytics payload (event properties, Sentry
 * breadcrumbs, …). Payloads are small JSON-ish trees; depth is capped so a
 * cyclic or huge object can't hang the page.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactPrivateShareUrl(value) as unknown as T;
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1)) as unknown as T;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value; // leave Dates, Errors, DOM nodes alone
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, depth + 1);
  return out as T;
}

// ---- Per-tool hooks. Each is passed straight to that tool's config. ----

/**
 * PostHog `before_send`: rewrites the whole event — properties, `$set`,
 * `$set_once` (initial URL person props once anyone is identified), etc.
 * Session-replay `$snapshot` events pass through untouched: their DOM is
 * already gzipped to an opaque string, so walking it is wasted work on every
 * flush. Replay is stopped on share pages instead (see AnalyticsWrapper).
 */
export function posthogBeforeSend<E extends { event?: string } | null>(event: E): E {
  if (!event || event.event === '$snapshot') return event;
  return redactDeep(event);
}

/** Vercel Analytics / Speed Insights `beforeSend`: both send `{ url, … }`. */
export function vercelBeforeSend<E extends { url: string }>(event: E): E {
  return { ...event, url: redactPrivateShareUrl(event.url) };
}

/**
 * Sentry `beforeSend` / `beforeBreadcrumb` scrub (request URL, breadcrumbs,
 * tags…). Takes exactly one argument on purpose: Sentry passes a hint second,
 * which must never land in redactDeep's `depth`.
 */
export function sentryScrub<E>(event: E): E {
  return redactDeep(event);
}
