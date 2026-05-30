// Dual-fire analytics events into PostHog (SDK capture) in addition to Vercel
// Analytics' track(). The email gate + capture funnel historically only emitted
// Vercel `track()` events, which have no query API and stay buried in the Vercel
// dashboard — so gate_modal_shown / email_captured / gate_modal_dismissed were
// invisible in PostHog where the rest of the funnel lives. Mirrors the
// best-effort SDK pattern in promo-tracking.ts / TicketLink.tsx (same project).
// See memory/feedback_analytics_real_users_lens.md.

export function captureEvent(
  event: string,
  properties: Record<string, unknown> = {},
): void {
  if (typeof window === 'undefined') return;
  try {
    (window as unknown as {
      posthog?: { capture?: (e: string, p?: Record<string, unknown>) => void };
    }).posthog?.capture?.(event, properties);
  } catch {
    // tracking is never critical — never throw into a render/submit path
  }
}
