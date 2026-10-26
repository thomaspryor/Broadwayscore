'use client';

/**
 * "Email Tom" link (owner, 2026-10-26). The address is assembled only when the
 * link is clicked, so it never appears in the page HTML for scrapers to
 * harvest. Without JavaScript (most bots) the link opens the feedback form.
 */

import { gaEvent } from '@/lib/analytics/ga-event';
import { captureEvent } from '@/lib/posthog-events';

const SEND_WAIT_MS = 400;
const USER = 'tom';
const DOMAIN = ['broadwayscorecard', 'com'];

export default function EmailTomLink({ className, label = 'Email Tom' }: { className?: string; label?: string }) {
  return (
    <a
      href="/feedback"
      className={className}
      onClick={(e) => {
        e.preventDefault();
        const path = window.location.pathname;
        const href = `mailto:${USER}@${DOMAIN.join('.')}?subject=${encodeURIComponent('Broadway Scorecard')}`;
        // Starting the mailto navigation cancels a hit still in flight (seen in
        // GA realtime, BRO-6331): open the mail app once gtag confirms the
        // send, or after SEND_WAIT_MS if it never does (GA blocked or unloaded).
        let opened = false;
        const open = () => {
          if (opened) return;
          opened = true;
          window.location.href = href;
        };
        gaEvent('email_tom_click', { page_path: path, transport_type: 'beacon', event_callback: open, event_timeout: SEND_WAIT_MS });
        captureEvent('email_tom_click', { path });
        setTimeout(open, SEND_WAIT_MS);
      }}
    >
      {label}
    </a>
  );
}
