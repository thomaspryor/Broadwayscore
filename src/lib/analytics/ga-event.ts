/**
 * Best-effort GA4 custom event (BRO-6331). Same transport TicketLink uses for
 * ticket_link_click / affiliate_click: window.gtag, defined by gaInitScript.
 * GA loads lazily (AnalyticsWrapper), so an event fired before gtag exists is
 * held and sent once it does: pushing it onto dataLayer early would put it
 * ahead of gtag('js') and gtag('config'), where it can be dropped. Gives up
 * after GA_WAIT_MS (ad blocker, GA disabled). Never throws into a render or
 * submit path.
 */
const GA_POLL_MS = 250;
const GA_WAIT_MS = 15000;

type Gtag = (...args: unknown[]) => void;

export function gaEvent(name: string, params: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  try {
    const w = window as unknown as { gtag?: Gtag };
    if (typeof w.gtag === 'function') {
      w.gtag('event', name, params);
      return;
    }
    let waited = 0;
    const timer = setInterval(() => {
      waited += GA_POLL_MS;
      try {
        if (typeof w.gtag === 'function') {
          clearInterval(timer);
          w.gtag('event', name, params);
        } else if (waited >= GA_WAIT_MS) {
          clearInterval(timer);
        }
      } catch {
        clearInterval(timer);
      }
    }, GA_POLL_MS);
  } catch {
    // analytics must never break the page
  }
}
