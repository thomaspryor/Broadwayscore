'use client';

import { ReactNode, useMemo } from 'react';
import { track } from '@vercel/analytics';

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    posthog?: { capture: (event: string, properties?: Record<string, unknown>) => void; flush?: () => void; get_distinct_id?: () => string; getFeatureFlag?: (key: string) => string | boolean | undefined };
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
  /** A/B test variant — tracked in analytics events */
  abVariant?: string;
  className?: string;
  children: ReactNode;
}

export default function TicketLink({
  showName, showId, showSlug, showStatus, showCategory, showScore,
  platform, url, pageType,
  linkPosition = 0, totalLinks = 1,
  abVariant,
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
          ab_variant: abVariant ?? null,
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

  // Primary CTA (position 0, affiliate) gets a filled gold button matching the iOS app.
  // Secondary affiliates get a subtle warm tint. Non-affiliates stay gray.
  const isPrimaryCta = isAffiliate && linkPosition === 0;
  const resolvedClassName = isPrimaryCta
    ? (className ?? '')
        .replace(/bg-surface-overlay/g, 'bg-accent-gold')
        .replace(/hover:bg-white\/10/g, 'hover:bg-accent-gold/80')
        .replace(/border-white\/10/g, 'border-accent-gold')
        .replace(/text-gray-300/g, 'text-gray-900')
        .replace(/hover:text-white/g, 'hover:text-gray-900')
        .replace(/py-1\.5/g, 'py-2.5')
        .replace(/px-3/g, 'px-5')
        .replace(/text-xs/g, 'text-sm')
        + ' font-bold shadow-sm shadow-accent-gold/20'
    : isAffiliate
    ? (className ?? '')
        .replace(/bg-surface-overlay/g, 'bg-accent-gold/10')
        .replace(/hover:bg-white\/10/g, 'hover:bg-accent-gold/20')
        .replace(/border-white\/10/g, 'border-accent-gold/20')
        .replace(/text-gray-300/g, 'text-accent-gold/70')
        .replace(/hover:text-white/g, 'hover:text-accent-gold')
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
