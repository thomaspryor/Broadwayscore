'use client';

import { useState, useEffect } from 'react';
import TicketLink from '@/components/TicketLink';
import { sortTicketLinks, type TicketLinkData } from '@/lib/ticket-utils';

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
  /** Class applied to each button pill */
  buttonClassName?: string;
}

/**
 * A/B test wrapper for ticket buttons on show pages.
 *
 * Active tests:
 *   1. ticket-primary-platform — TodayTix first (WINNER, locked 100%)
 *   2. ticket-single-button — single CTA vs multiple buttons (50/50)
 */
export default function TicketButtonsAB({
  showName, showId, showSlug, showStatus, showCategory, showScore,
  ticketLinks, officialUrl, pageType, maxButtons = 4,
  buttonClassName = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10 whitespace-nowrap flex-shrink-0",
}: TicketButtonsABProps) {
  const [abPlatformVariant, setAbPlatformVariant] = useState<string | null>(null);
  const [abButtonVariant, setAbButtonVariant] = useState<string | null>(null);

  useEffect(() => {
    const checkFlags = () => {
      const ph = window.posthog;
      if (!ph?.getFeatureFlag) return;

      const platformFlag = ph.getFeatureFlag('ticket-primary-platform');
      if (typeof platformFlag === 'string') setAbPlatformVariant(platformFlag);

      const buttonFlag = ph.getFeatureFlag('ticket-single-button');
      if (typeof buttonFlag === 'string') setAbButtonVariant(buttonFlag);
    };

    checkFlags();
    const timer = setTimeout(checkFlags, 2000);
    return () => clearTimeout(timer);
  }, []);

  // Platform ordering (test 1 — locked to TodayTix)
  let overridePlatform: string | undefined;
  if (abPlatformVariant === 'stubhub' && ticketLinks.some(l => l.platform === 'StubHub')) {
    overridePlatform = 'StubHub';
  }

  const sorted = sortTicketLinks(ticketLinks, overridePlatform);
  const isSingleButton = abButtonVariant === 'single';

  // Single-button variant: just show the primary CTA, nothing else
  const visibleLinks = isSingleButton
    ? sorted.slice(0, 1)
    : sorted.slice(0, officialUrl ? maxButtons - 1 : maxButtons);

  // Combine variants into a tracking string
  const abVariantStr = [
    abPlatformVariant ? `platform:${abPlatformVariant}` : null,
    abButtonVariant ? `buttons:${abButtonVariant}` : null,
  ].filter(Boolean).join(',') || undefined;

  if (showStatus === 'closed' || visibleLinks.length === 0) return null;

  return (
    <>
      {visibleLinks.map((link, i) => (
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
          abVariant={abVariantStr}
          className={buttonClassName}
        >
          {i === 0 ? (
            link.priceFrom ? `Get Tickets from $${link.priceFrom}` : `Get Tickets on ${link.platform}`
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
              </svg>
              {link.platform}
            </>
          )}
        </TicketLink>
      ))}
      {/* In single-button variant, hide Official Site and secondary buttons */}
      {!isSingleButton && officialUrl && (
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
          linkPosition={visibleLinks.length}
          totalLinks={visibleLinks.length + 1}
          className={buttonClassName}
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
