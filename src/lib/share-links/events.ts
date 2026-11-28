/**
 * Analytics for private share links (plans, diary): dual-fired to Vercel
 * track() and PostHog like the rest of the funnel (src/lib/posthog-events.ts).
 * Never pass a token or user id: URLs are already scrubbed by
 * src/lib/analytics/redact-url.ts, and props must not reintroduce what that
 * removes.
 */
import { track } from '@vercel/analytics';
import { captureEvent } from '@/lib/posthog-events';

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

export function trackShareEvent(name: string, props: Record<string, string | number | boolean>): void {
  try {
    track(name, props);
  } catch {
    // tracking is never critical
  }
  whenPostHogReady(() => captureEvent(name, props));
}
