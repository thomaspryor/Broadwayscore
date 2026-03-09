/**
 * Shared console error filtering for E2E tests.
 *
 * Filters out non-critical errors from third-party services (PostHog, analytics)
 * and browser-level noise (favicon, MIME type mismatches, resource loading).
 */
export function filterNonCriticalErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes('favicon') &&
      !e.includes('analytics') &&
      !e.includes('hydration') &&
      !e.includes('Warning') &&
      !e.includes('MIME type') &&
      !e.includes('Failed to load resource')
  );
}
