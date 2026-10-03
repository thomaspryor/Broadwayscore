/**
 * Keep Shared Plans tokens out of every analytics tool (BRO-4481).
 *
 * `/plans/<token>` is a private, login-free link: whoever holds the token can
 * see when someone will be at the theater. PostHog (autocapture, pageviews,
 * session replay), Vercel Analytics, Speed Insights, GA and Sentry all record
 * full URLs by default, which would copy live tokens into five third-party
 * dashboards. Every one of them routes its outgoing data through this module
 * (wired in src/components/AnalyticsWrapper.tsx; tests/unit/analytics-redaction.test.ts
 * fails if one stops doing so).
 */

/**
 * `/plans/<anything up to / ? # whitespace quote or angle bracket>`. Exported
 * as a source string so AnalyticsWrapper's inline GA script can build the
 * same RegExp at render time instead of hand-copying it.
 */
export const SHARED_PLAN_SEGMENT_SOURCE = '\\/plans\\/[^/?#\\s"\'<>]+';
export const SHARED_PLAN_REDACTED = '/plans/:token';
const SHARED_PLAN_SEGMENT = new RegExp(SHARED_PLAN_SEGMENT_SOURCE, 'g');
// The same path percent-encoded, e.g. inside ?next= or a mailto:/sms: body.
const SHARED_PLAN_SEGMENT_ENCODED = /%2Fplans%2F(?:(?!%2F|%3F|%23)[^/?#&\s"'<>])+/gi;

export function redactSharedPlanUrl(value: string): string {
  return value
    .replace(SHARED_PLAN_SEGMENT, SHARED_PLAN_REDACTED)
    .replace(SHARED_PLAN_SEGMENT_ENCODED, '%2Fplans%2F%3Atoken');
}

/** True on a Shared Plans page (session replay is switched off there). */
export function isSharedPlansPath(pathname: string): boolean {
  return pathname === '/plans' || pathname.startsWith('/plans/');
}

/**
 * Redact every string inside an analytics payload (event properties, Sentry
 * breadcrumbs, …). Payloads are small JSON-ish trees; depth is capped so a
 * cyclic or huge object can't hang the page.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactSharedPlanUrl(value) as unknown as T;
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
 * flush. Replay is stopped on /plans instead (see AnalyticsWrapper).
 */
export function posthogBeforeSend<E extends { event?: string } | null>(event: E): E {
  if (!event || event.event === '$snapshot') return event;
  return redactDeep(event);
}

/** Vercel Analytics / Speed Insights `beforeSend`: both send `{ url, … }`. */
export function vercelBeforeSend<E extends { url: string }>(event: E): E {
  return { ...event, url: redactSharedPlanUrl(event.url) };
}

/**
 * Sentry `beforeSend` / `beforeBreadcrumb` scrub (request URL, breadcrumbs,
 * tags…). Takes exactly one argument on purpose: Sentry passes a hint second,
 * which must never land in redactDeep's `depth`.
 */
export function sentryScrub<E>(event: E): E {
  return redactDeep(event);
}
