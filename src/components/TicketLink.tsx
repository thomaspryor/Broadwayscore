'use client';

import { ReactNode, useMemo } from 'react';
import { track } from '@vercel/analytics';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    posthog?: { capture: (event: string, properties?: Record<string, unknown>) => void; flush?: () => void; get_distinct_id?: () => string };
  }
}

import { buildAffiliateUrl } from '@/lib/affiliate-utils';

// Re-export affiliate helpers so existing consumers don't break
export { isAffiliateEnabled, isAffiliatePartner } from '@/lib/affiliate-utils';

// Re-export sorting utilities from shared module (not 'use client' — safe for SSR)
export { sortTicketLinks, type TicketLinkData } from '@/lib/ticket-utils';

// ─── Component ───────────────────────────────────────────

interface TicketLinkProps {
  showName: string;
  showId: string;
  showSlug?: string;
  showStatus?: string;
  showCategory?: string;
  showScore?: number | null;
  platform: string;
  url: string;
  pageType: 'show' | 'guide' | 'browse' | 'comparison' | 'showtimes';
  linkPosition?: number;
  totalLinks?: number;
  className?: string;
  children: ReactNode;
}

export default function TicketLink({
  showName, showId, showSlug, showStatus, showCategory, showScore,
  platform, url, pageType,
  linkPosition = 0, totalLinks = 1,
  className, children,
}: TicketLinkProps) {
  const { url: affiliateUrl, isAffiliate } = useMemo(
    () => buildAffiliateUrl(url, platform, pageType),
    [url, platform, pageType],
  );

  const handleClick = () => {
    if (typeof window === 'undefined') return;

    // Vercel Analytics
    track('ticket_click', { show_id: showId, platform, page_type: pageType, is_affiliate: isAffiliate });

    // PostHog — send via sendBeacon for guaranteed delivery.
    // PostHog SDK batches capture() on a 30s timer. With target="_blank", the page
    // doesn't unload and the batch never flushes. sendBeacon fires immediately and
    // survives tab focus changes.
    try {
      const phKey = 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7';
      const distinctId = window.posthog?.get_distinct_id?.() ?? 'anonymous';
      navigator.sendBeacon('https://us.i.posthog.com/capture/', JSON.stringify({
        api_key: phKey,
        event: 'ticket_click',
        properties: {
          distinct_id: distinctId,
          $current_url: window.location.href,
          show_id: showId, show_name: showName, platform,
          page_type: pageType, is_affiliate: isAffiliate,
          link_position: linkPosition, total_links: totalLinks,
        },
        timestamp: new Date().toISOString(),
      }));
    } catch { /* tracking not critical */ }

    if (typeof window.gtag !== 'function') return;

    // Primary click event — enriched with full attribution context
    window.gtag('event', 'ticket_link_click', {
      show_name: showName,
      show_id: showId,
      show_slug: showSlug ?? '',
      show_status: showStatus ?? '',
      show_category: showCategory ?? '',
      show_score: showScore ?? null,
      platform,
      ticket_url: url,
      affiliate_url: affiliateUrl,
      is_affiliate: isAffiliate,
      page_type: pageType,
      link_position: linkPosition,
      total_links: totalLinks,
    });

    // Separate affiliate-specific event for easy GA4 filtering / conversion setup
    if (isAffiliate) {
      window.gtag('event', 'affiliate_click', {
        show_name: showName,
        show_id: showId,
        platform,
        affiliate_url: affiliateUrl,
        page_type: pageType,
      });
    }
  };

  // Active affiliates get a warm accent treatment matching the lottery button's visual weight.
  // Replaces the default dark bg + gray text with amber bg + bright text.
  const resolvedClassName = isAffiliate
    ? (className ?? '')
        .replace(/bg-surface-overlay/g, 'bg-amber-500/15')
        .replace(/hover:bg-white\/10/g, 'hover:bg-amber-500/25')
        .replace(/border-white\/10/g, 'border-amber-500/30')
        .replace(/text-gray-300/g, 'text-amber-300')
        .replace(/hover:text-white/g, 'hover:text-amber-200')
    : className ?? '';

  return (
    <a
      href={affiliateUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={resolvedClassName}
      onClick={handleClick}
    >
      {children}
    </a>
  );
}
