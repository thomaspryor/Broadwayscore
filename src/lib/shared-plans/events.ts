/**
 * Shared Plans analytics (BRO-4481). These answer the V2 question — do
 * friends open shared links and tap through? — so they stay few.
 *
 * Dual-fired to Vercel track() and PostHog like the rest of the funnel
 * (src/lib/posthog-events.ts). Never pass a token or user id here: URLs are
 * already scrubbed by src/lib/analytics/redact-url.ts, and props must not
 * reintroduce what that removes.
 */
import { track } from '@vercel/analytics';
import { captureEvent } from '@/lib/posthog-events';

export type SharedPlansEvent =
  | { name: 'plans_page_viewed'; props: { booked: number; unbooked: number } }
  | { name: 'plans_show_tapped'; props: { show_id: string; section: 'booked' | 'unbooked' } }
  | { name: 'plans_calendar_added'; props: { show_id: string; method: 'ics' | 'google' } }
  // Owner side
  | { name: 'plans_share_enabled'; props: { booked: boolean; unbooked: boolean } }
  | { name: 'plans_shared'; props: { method: 'native-sheet' | 'copy' } }
  | { name: 'plans_share_stopped'; props: Record<string, never> }
  | { name: 'plans_link_reset'; props: Record<string, never> };

/**
 * PostHog loads on idle (AnalyticsWrapper, ~1.5s after hydration), so an
 * event fired on mount would find no window.posthog and vanish. Wait for it,
 * briefly; give up quietly if it never arrives (ad blockers).
 */
function whenPostHogReady(fn: () => void, timeoutMs = 8000, everyMs = 250): void {
  if (typeof window === 'undefined') return;
  const ready = () => typeof (window as unknown as { posthog?: { capture?: unknown } }).posthog?.capture === 'function';
  if (ready()) { fn(); return; }
  const started = Date.now();
  const id = setInterval(() => {
    if (ready()) { clearInterval(id); fn(); }
    else if (Date.now() - started > timeoutMs) clearInterval(id);
  }, everyMs);
}

export function trackSharedPlans(e: SharedPlansEvent): void {
  try {
    track(e.name, e.props);
  } catch {
    // tracking is never critical
  }
  whenPostHogReady(() => captureEvent(e.name, e.props));
}
