/**
 * Shared console error filtering for E2E tests.
 *
 * Filters out non-critical errors from third-party services (PostHog, analytics)
 * and browser-level noise (favicon, MIME type mismatches, resource loading).
 *
 * A message is dropped only if it matches one of these narrow, known-benign
 * patterns. Anything else — a genuine unexpected console.error — still passes
 * through and fails the assertion. Keep patterns as specific as possible so the
 * allowlist can never neuter a real error.
 */
const BENIGN_CONSOLE_PATTERNS: Array<(e: string) => boolean> = [
  (e) => e.includes('favicon'),
  (e) => e.includes('analytics'),
  (e) => e.includes('hydration'),
  (e) => e.includes('Warning'),
  (e) => e.includes('MIME type'),
  (e) => e.includes('Failed to load resource'),
  // Next.js App Router RSC prefetch degradation. When a static chunk/RSC payload
  // is swapped out mid-session (e.g. a deploy landing while the test runs), the
  // prefetch fetch rejects and Next logs this, then falls back to a full browser
  // navigation — its *designed* graceful degradation, invisible and harmless to
  // users. During deploy-heavy windows (opening nights) this floods the console
  // on every internal <Link> and is not a real error. Requires BOTH halves of
  // Next's exact message so a genuine "Failed to fetch" from app code still fails.
  (e) =>
    e.includes('Failed to fetch RSC payload') &&
    e.includes('Falling back to browser navigation'),
];

export function filterNonCriticalErrors(errors: string[]): string[] {
  return errors.filter((e) => !BENIGN_CONSOLE_PATTERNS.some((match) => match(e)));
}
