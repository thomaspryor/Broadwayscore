'use client';

import { useRef, type ReactNode } from 'react';
import { gaEvent } from '@/lib/analytics/ga-event';
import { captureEvent } from '@/lib/posthog-events';

const SEND_WAIT_MS = 400;

/** Keep the native mailto fallback and give analytics time to send before leaving. */
export default function MailtoLink({ href, className, children }: {
  href: `mailto:${string}`;
  className?: string;
  children: ReactNode;
}) {
  const busy = useRef(false);
  return (
    <a href={href} className={className} onClick={(event) => {
      event.preventDefault();
      if (busy.current) return;
      busy.current = true;
      setTimeout(() => { busy.current = false; }, 1500);

      // Match EmailTomLink: acknowledge the beacon or fall back if GA is blocked.
      // The destination address and message contents never enter analytics.
      let opened = false;
      const open = () => {
        if (opened) return;
        opened = true;
        window.location.href = href;
      };
      const path = window.location.pathname;
      gaEvent('email_link_click', {
        page_path: path,
        transport_type: 'beacon',
        event_callback: open,
        event_timeout: SEND_WAIT_MS,
      });
      captureEvent('email_link_click', { path });
      setTimeout(open, SEND_WAIT_MS);
    }}>
      {children}
    </a>
  );
}
