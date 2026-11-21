'use client';

import { useEffect } from 'react';
import { documentNavigationFor } from '@/lib/analytics/leave-by-document';

/**
 * Mounted by PrivateShareLayout (every private share route: /plans, /seen).
 * Turns every same-site link click on a share page (header, footer, show
 * cards, error/not-found pages) into a document load; see src/lib/analytics/leave-by-document.ts for why.
 * Capture phase + preventDefault: Next's <Link> skips its router push when
 * the event is already defaultPrevented. React handlers still run, so the
 * page's click analytics are unaffected.
 */
export default function LeaveByDocument() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a) return;
      const next = documentNavigationFor({
        href: a.getAttribute('href'),
        currentHref: window.location.href,
        target: a.getAttribute('target'),
        download: a.hasAttribute('download'),
        button: e.button,
        modified: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
        defaultPrevented: e.defaultPrevented,
      });
      if (!next) return;
      e.preventDefault();
      // Next tick: lets the page's own click handlers (analytics) run first.
      setTimeout(() => window.location.assign(next), 0);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  return null;
}
