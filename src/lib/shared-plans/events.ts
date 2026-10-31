/**
 * Shared Plans analytics (BRO-4481). These answer the V2 question — do
 * friends open shared links and tap through? — so they stay few.
 *
 * Dual-fired to Vercel track() and PostHog like the rest of the funnel
 * (src/lib/posthog-events.ts). Never pass a token or user id here: URLs are
 * already scrubbed by src/lib/analytics/redact-url.ts, and props must not
 * reintroduce what that removes.
 */
import { trackShareEvent } from '@/lib/share-links/events';

export type SharedPlansEvent =
  | { name: 'plans_page_viewed'; props: { booked: number; unbooked: number } }
  | { name: 'plans_show_tapped'; props: { show_id: string; section: 'booked' | 'unbooked' } }
  | { name: 'plans_calendar_added'; props: { show_id: string; method: 'ics' | 'google' } }
  // Owner side
  | { name: 'plans_share_enabled'; props: { booked: boolean; unbooked: boolean } }
  | { name: 'plans_shared'; props: { method: 'native-sheet' | 'copy' } }
  | { name: 'plans_share_stopped'; props: Record<string, never> }
  | { name: 'plans_link_reset'; props: Record<string, never> };

export function trackSharedPlans(e: SharedPlansEvent): void {
  trackShareEvent(e.name, e.props);
}
