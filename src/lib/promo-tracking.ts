// Promo click tracking. Uses navigator.sendBeacon so the event survives the
// page tear-down caused by same-tab navigation (PostHog SDK batches on a 30s
// timer; a same-origin Link click would lose the batched XHR). Mirrors the
// pattern in TicketLink.tsx — same PostHog project key.

const POSTHOG_KEY = 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7';
const POSTHOG_HOST = 'https://us.i.posthog.com/capture/';

export function trackPromoClick(
  placement: string,
  extra: Record<string, unknown> = {},
): void {
  if (typeof window === 'undefined') return;
  try {
    const distinctId =
      window.posthog?.get_distinct_id?.() ?? 'anonymous';
    const payload = {
      api_key: POSTHOG_KEY,
      event: 'promo_click',
      properties: {
        distinct_id: distinctId,
        $current_url: window.location.href,
        placement,
        ...extra,
      },
      timestamp: new Date().toISOString(),
    };
    navigator.sendBeacon(POSTHOG_HOST, JSON.stringify(payload));
  } catch {
    // tracking not critical
  }
  // Also call SDK capture so $autocapture chains, identity, and feature flags
  // see the event. SDK call is best-effort; sendBeacon above is the guarantee.
  try {
    window.posthog?.capture?.('promo_click', { placement, ...extra });
  } catch {
    // ignore
  }
}
