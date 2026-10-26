'use client';

/**
 * "Email Tom" link (owner, 2026-10-26). The address is assembled only when the
 * link is clicked, so it never appears in the page HTML for scrapers to
 * harvest. Without JavaScript (most bots) the link opens the feedback form.
 */

import { gaEvent } from '@/lib/analytics/ga-event';
import { captureEvent } from '@/lib/posthog-events';

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
        gaEvent('email_tom_click', { page_path: path });
        captureEvent('email_tom_click', { path });
        window.location.href = `mailto:${USER}@${DOMAIN.join('.')}?subject=${encodeURIComponent('Broadway Scorecard')}`;
      }}
    >
      {label}
    </a>
  );
}
