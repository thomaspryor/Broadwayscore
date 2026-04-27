'use client';

/*
 * ═══════════════════════════════════════════════════════════════════════
 *  LIVE A/B TEST — READ memory/feedback_ab_test_guardrails.md FIRST
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  This component renders two live PostHog experiments. DO NOT:
 *    - Change PostHog flag rollouts without explicit user approval
 *    - Remove variant branches because they're "currently at 0%"
 *    - Declare a winner based on small samples or contaminated data
 *    - Flip ensure_experience_continuity without understanding the trade-off
 *
 *  Before any change to this file, the PostHog flag, or analyze-ab-test.js,
 *  run `node scripts/validate-ab-test.js` and confirm all 4 checks pass.
 *
 *  Active experiments (as of 2026-04-11):
 *    1. ticket-single-button — 50/50 multi/single, sticky bucketing on,
 *       restarted 2026-04-11 ~19:00 UTC after first run was invalidated.
 *       At current traffic (~4 A/B clicks/day), 100-click-per-variant
 *       threshold is ~50 days out. Do not declare early.
 *    2. ticket-primary-platform — 100% todaytix, 0% stubhub. Winner
 *       locked months ago. The stubhub branch below is intentionally
 *       kept even though HIDDEN_PLATFORMS strips StubHub from
 *       sortTicketLinks() — do not remove.
 *
 *  Full rules + history: memory/feedback_ab_test_guardrails.md
 * ═══════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import TicketLink from '@/components/TicketLink';
import { sortTicketLinks, type TicketLinkData } from '@/lib/ticket-utils';
import { getCurrencySymbol } from '@/lib/market-utils';

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
  /**
   * When true, renders the first ticket link as a full-width primary CTA on its
   * own row, followed by the remaining links + Official Site as inline secondary
   * pills in a horizontal-scroll row. Used by the show-page redesign hero block.
   * Tracking events stay identical to the inline-row default — same abVariantStr,
   * same `linkPosition` ordering — so analyze-ab-test.js handles split traffic
   * the same as inline traffic. Single-button A/B variant collapses to just the
   * primary CTA in both modes.
   */
  splitVariant?: boolean;
  /** Class applied to the first/primary CTA when splitVariant=true. */
  primaryButtonClassName?: string;
  /**
   * Optional content appended INSIDE the secondary scroll row (after Telecharge,
   * Official, etc.). Used by the show-page redesign hero to inline a $X Lottery
   * pill alongside the ticket platform pills so they stay on a single row.
   * Only renders when splitVariant=true and the secondary row is shown.
   */
  secondaryAfter?: React.ReactNode;
}

/**
 * A/B test wrapper for ticket buttons on show pages.
 *
 *   1. ticket-primary-platform — locked 100% `todaytix`. The `stubhub`
 *      variant exists at 0% and its override branch is kept intentionally;
 *      do not remove (see header comment).
 *   2. ticket-single-button — 50/50 `multi` / `single`, sticky bucketing on.
 *      Restarted fresh 2026-04-11 after the first run (Mar 28 – Apr 11) was
 *      invalidated by the StubHub hide mid-flight. FLAG_RESTART_DATES in
 *      scripts/analyze-ab-test.js excludes pre-restart events from analysis.
 *      Never declare a winner from this file — run analyze-ab-test.js and
 *      wait for the stat-sig verdict.
 */
export default function TicketButtonsAB({
  showName, showId, showSlug, showStatus, showCategory, showScore,
  ticketLinks, officialUrl, pageType, maxButtons = 4,
  buttonClassName = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10 whitespace-nowrap flex-shrink-0",
  splitVariant = false,
  primaryButtonClassName = "w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-lg bg-gradient-brand text-white font-bold text-sm hover:shadow-glow-sm hover:scale-[1.01] active:scale-[0.99] transition-all whitespace-nowrap",
  secondaryAfter,
}: TicketButtonsABProps) {
  const [abPlatformVariant, setAbPlatformVariant] = useState<string | null>(null);
  const [abButtonVariant, setAbButtonVariant] = useState<string | null>(null);
  const [flagsLoaded, setFlagsLoaded] = useState(false);

  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 20; // 20 × 250ms = 5 seconds total
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const checkFlags = () => {
      const ph = window.posthog;
      if (ph?.getFeatureFlag) {
        const platformFlag = ph.getFeatureFlag('ticket-primary-platform');
        const buttonFlag = ph.getFeatureFlag('ticket-single-button');

        // Only mark loaded once we get string values for both
        if (typeof platformFlag === 'string' && typeof buttonFlag === 'string') {
          setAbPlatformVariant(platformFlag);
          setAbButtonVariant(buttonFlag);
          setFlagsLoaded(true);
          if (intervalId) clearInterval(intervalId);
          if (fallbackTimer) clearTimeout(fallbackTimer);
          return;
        }
      }
      attempts++;
      if (attempts >= maxAttempts && intervalId) {
        clearInterval(intervalId);
      }
    };

    // Try immediately, then poll every 250ms
    checkFlags();
    intervalId = setInterval(checkFlags, 250);

    // Fallback: after 5 seconds, give up and render with defaults (control = multi)
    // This handles ad blockers / opted-out users — they get the control variant
    // and the click WILL still fire with ab_variant="platform:default,buttons:multi-fallback"
    // so we can identify and exclude these in analysis.
    fallbackTimer = setTimeout(() => {
      if (intervalId) clearInterval(intervalId);
      setFlagsLoaded(true);
    }, 5000);

    return () => {
      if (intervalId) clearInterval(intervalId);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, []);

  // Platform ordering (test 1 — locked to `todaytix` at 100% in PostHog).
  //
  // The `stubhub` variant branch is kept intentionally. Even though:
  //   (a) PostHog rolls 0% to stubhub right now, and
  //   (b) sortTicketLinks() filters StubHub via HIDDEN_PLATFORMS,
  // removing this branch would make re-testing a forced primary platform
  // require a code change instead of a PostHog config change. See
  // memory/feedback_ab_test_guardrails.md rule #4: "Never delete A/B test
  // code paths because 'one variant is at 0%'."
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

  // Combine variants into a tracking string. Use explicit "fallback" marker
  // when flags didn't load (ad blocker / opt-out) so we can exclude these from analysis.
  const platformPart = abPlatformVariant ?? 'fallback';
  const buttonsPart = abButtonVariant ?? 'fallback';
  const abVariantStr = `platform:${platformPart},buttons:${buttonsPart}`;

  // Don't render anything until flags load (or fallback fires after 5s)
  // This eliminates the multi-default flicker that biased early clicks to control.
  if (!flagsLoaded) return null;
  if (showStatus === 'closed' || visibleLinks.length === 0) return null;

  // Helpers — same TicketLink shape used by both modes; only the wrapper layout differs.
  // `withArrow` adds a trailing `→` (split-variant primary CTA emphasis only).
  const renderPrimary = (link: TicketLinkData, i: number, totalLinks: number, className: string, withArrow = false) => (
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
      totalLinks={totalLinks}
      abVariant={abVariantStr}
      className={className}
    >
      {link.priceFrom ? `Get Tickets from ${getCurrencySymbol(showCategory)}${link.priceFrom}` : `Get Tickets on ${link.platform}`}
      {withArrow && <span aria-hidden="true">→</span>}
    </TicketLink>
  );

  // splitVariant secondary pills are sized to match the primary CTA's height (py-2.5 / text-sm).
  // Inline mode keeps the smaller default class so existing call sites (where ticket pills are
  // a tight scrolling row) don't change visually.
  const splitSecondaryClass =
    'inline-flex items-center gap-1.5 py-2.5 px-5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-sm leading-none font-medium transition-colors border border-white/10 whitespace-nowrap flex-shrink-0';
  const secondaryClass = splitVariant ? splitSecondaryClass : buttonClassName;
  const secondaryIconSize = splitVariant ? 'w-4 h-4' : 'w-3.5 h-3.5';

  const renderSecondary = (link: TicketLinkData, i: number, totalLinks: number) => (
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
      totalLinks={totalLinks}
      abVariant={abVariantStr}
      className={secondaryClass}
    >
      <svg className={secondaryIconSize} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
      </svg>
      {link.platform}
    </TicketLink>
  );

  const renderOfficial = (linkPosition: number, totalLinks: number) => officialUrl ? (
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
      linkPosition={linkPosition}
      totalLinks={totalLinks}
      className={secondaryClass}
    >
      <svg className={secondaryIconSize} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
      </svg>
      {/* Shortened from "Official Site" so secondary row fits on one line at 390px alongside Telecharge + $X Lottery. */}
      Official
    </TicketLink>
  ) : null;

  // splitVariant: primary CTA on its own row + secondary pills wrapped below.
  // Single-button A/B variant collapses to just the primary in either mode.
  if (splitVariant) {
    const totalLinksInRow = visibleLinks.length + (!isSingleButton && officialUrl ? 1 : 0);
    const primaryLink = visibleLinks[0];
    const secondaryLinks = visibleLinks.slice(1);
    const hasSecondary = !isSingleButton && (secondaryLinks.length > 0 || Boolean(officialUrl));
    // secondaryAfter (Lottery/Rush) ignores the single-button A/B — matches legacy
    // page.tsx behavior where the discount-tickets pill always rendered alongside
    // the primary CTA regardless of the multi/single bucket.
    const showSecondaryRow = hasSecondary || secondaryAfter != null;
    return (
      // Mobile (< lg): primary CTA full-width on its own row, secondary scrolls below.
      // Desktop (lg+): primary CTA + secondary pills share one flex row, all inline.
      <div className="space-y-2 lg:space-y-0 lg:flex lg:flex-wrap lg:items-center lg:gap-2">
        {primaryLink && renderPrimary(primaryLink, 0, totalLinksInRow, primaryButtonClassName, /* withArrow */ true)}
        {showSecondaryRow && (
          <div className="flex flex-nowrap gap-2 overflow-x-auto scrollbar-hide pb-1 -mx-1 px-1 lg:mx-0 lg:px-0 lg:pb-0 lg:overflow-visible">
            {!isSingleButton && secondaryLinks.map((link, idx) => renderSecondary(link, idx + 1, totalLinksInRow))}
            {!isSingleButton && renderOfficial(visibleLinks.length, totalLinksInRow)}
            {/* Lottery/Rush always renders, regardless of single-button A/B variant */}
            {secondaryAfter}
          </div>
        )}
      </div>
    );
  }

  // Default inline mode (existing behavior — all callers other than ShowHeroRedesign).
  // Primary uses buttonClassName (same as secondary), no arrow — matches pre-split rendering.
  const inlineTotalLinks = visibleLinks.length + (!isSingleButton && officialUrl ? 1 : 0);
  return (
    <>
      {visibleLinks.map((link, i) => (
        i === 0
          ? renderPrimary(link, i, inlineTotalLinks, buttonClassName)
          : renderSecondary(link, i, inlineTotalLinks)
      ))}
      {!isSingleButton && renderOfficial(visibleLinks.length, inlineTotalLinks)}
    </>
  );
}
