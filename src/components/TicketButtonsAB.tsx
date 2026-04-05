'use client';

import { useMemo } from 'react';
import TicketLink from '@/components/TicketLink';
import { sortTicketLinks, type TicketLinkData } from '@/lib/ticket-utils';
import { isLondonMarket } from '@/lib/market-utils';

interface TicketButtonsABProps {
  showName: string;
  showId: string;
  showSlug: string;
  showStatus: string;
  showCategory?: string;
  showScore: number | null;
  ticketLinks: TicketLinkData[];
  officialUrl?: string;
  pageType: 'show' | 'guide' | 'browse' | 'comparison' | 'showtimes';
  maxButtons?: number;
}

/**
 * A/B test wrapper for ticket buttons.
 *
 * Reads PostHog feature flag `ticket-primary-platform` to determine which
 * platform gets position 1 (the filled primary CTA). Falls back to default
 * sort order (TodayTix first) if the flag isn't loaded or doesn't apply.
 *
 * PostHog feature flag setup (create in PostHog UI):
 *   Key: ticket-primary-platform
 *   Variants: "todaytix" (50%), "stubhub" (50%)
 *   Ensure experience continuity: ON (same user always sees same variant)
 */
export default function TicketButtonsAB({
  showName, showId, showSlug, showStatus, showCategory, showScore,
  ticketLinks, officialUrl, pageType, maxButtons = 4,
}: TicketButtonsABProps) {
  const sorted = useMemo(() => {
    // Check PostHog feature flag for A/B test
    let overridePlatform: string | undefined;
    if (typeof window !== 'undefined' && window.posthog) {
      const ph = window.posthog as Record<string, unknown>;
      if (typeof ph.getFeatureFlag === 'function') {
        const variant = (ph.getFeatureFlag as (key: string) => string | boolean | undefined)('ticket-primary-platform');
        if (variant === 'stubhub') overridePlatform = 'StubHub';
        // 'todaytix' or undefined = default (TodayTix first)
      }
    }
    return sortTicketLinks(ticketLinks, overridePlatform);
  }, [ticketLinks]);

  const visibleLinks = sorted.slice(0, officialUrl ? maxButtons - 1 : maxButtons);
  const buttonClass = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10 whitespace-nowrap flex-shrink-0";

  return (
    <>
      {showStatus !== 'closed' && visibleLinks.map((link, i) => (
        <TicketLink
          key={link.platform}
          showName={showName}
          showId={showId}
          showSlug={showSlug}
          showStatus={showStatus}
          showCategory={showCategory}
          showScore={showScore}
          platform={link.platform}
          url={link.url}
          pageType={pageType}
          linkPosition={i}
          totalLinks={visibleLinks.length}
          className={buttonClass}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
          </svg>
          {i === 0
            ? (link.priceFrom ? `Get Tickets from ${isLondonMarket(showCategory) ? '£' : '$'}${link.priceFrom}` : `Get Tickets on ${link.platform}`)
            : link.platform
          }
        </TicketLink>
      ))}
      {officialUrl && (
        <TicketLink
          showName={showName}
          showId={showId}
          showSlug={showSlug}
          showStatus={showStatus}
          showCategory={showCategory}
          showScore={showScore}
          platform="Official Site"
          url={officialUrl}
          pageType={pageType}
          totalLinks={visibleLinks.length + 1}
          className={buttonClass}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          Official Site
        </TicketLink>
      )}
    </>
  );
}
