'use client';

/*
 * ═══════════════════════════════════════════════════════════════════════
 *  LIVE A/B TEST — READ memory/feedback_ab_test_guardrails.md FIRST
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  This component renders one live PostHog experiment. DO NOT:
 *    - Change PostHog flag rollouts without explicit user approval
 *    - Remove variant branches because they're "currently at 0%"
 *    - Declare a winner based on small samples or contaminated data
 *    - Flip ensure_experience_continuity without understanding the trade-off
 *
 *  Active experiment:
 *    ticket-primary-platform — 100% todaytix, 0% stubhub. Winner locked
 *    months ago. The stubhub branch below is intentionally kept even
 *    though HIDDEN_PLATFORMS strips StubHub from sortTicketLinks() — do
 *    not remove.
 *
 *  ticket-single-button (single CTA vs. multi-platform button row) ran
 *  2026-04-11 through 2026-09-16 and was CONCLUDED, not just paused: 5
 *  months and ~$51k in tracked Impact revenue found no user-level
 *  difference in conversion rate, converting-user count, or commission
 *  (see docs/experiments/ticket-single-button.md "Conclusion" for the
 *  full numbers). The owner picked the single-button design on UX/
 *  maintenance grounds — the multi-button code path, the flag read, and
 *  the `buttons:` A/B branching were removed here as a result, they are
 *  not "temporarily at 0%." Re-introducing a button-count A/B needs a
 *  fresh flag and a fresh doc, not reviving this one.
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
  showVenue?: string;
  showScore: number | null;
  ticketLinks: TicketLinkData[];
  officialUrl?: string;
  pageType: 'show' | 'guide' | 'browse' | 'comparison' | 'showtimes';
  /** Class applied to each button pill */
  buttonClassName?: string;
  /**
   * When true, renders the primary CTA as a full-width row on its own,
   * followed by an optional secondaryAfter row below. Used by the show-page
   * redesign hero block. Tracking events stay identical to the inline-row
   * default — same abVariantStr, same `linkPosition` ordering.
   */
  splitVariant?: boolean;
  /** Class applied to the first/primary CTA when splitVariant=true. */
  primaryButtonClassName?: string;
  /**
   * Optional content rendered in its own scroll row below the primary CTA.
   * Used by the show-page redesign hero to show a $X Lottery pill alongside
   * the primary ticket CTA. Only renders when splitVariant=true.
   */
  secondaryAfter?: React.ReactNode;
}

/**
 * Ticket buttons on show pages. Renders a single primary CTA (the
 * concluded ticket-single-button experiment's winner-by-UX-decision — see
 * header comment) plus the ticket-primary-platform A/B, which is still
 * live and locked 100% `todaytix`. The `stubhub` variant exists at 0% and
 * its override branch is kept intentionally; do not remove (see header
 * comment).
 */
export default function TicketButtonsAB({
  showName, showId, showSlug, showStatus, showCategory, showVenue, showScore,
  ticketLinks, officialUrl, pageType,
  buttonClassName = "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-overlay hover:bg-white/10 text-gray-300 hover:text-white text-xs leading-none font-medium transition-colors border border-white/10 whitespace-nowrap flex-shrink-0",
  splitVariant = false,
  primaryButtonClassName = "w-full inline-flex items-center justify-center gap-1.5 py-2.5 px-4 rounded-lg bg-gradient-brand text-white font-bold text-sm hover:shadow-glow-sm hover:scale-[1.01] active:scale-[0.99] transition-all whitespace-nowrap",
  secondaryAfter,
}: TicketButtonsABProps) {
  const [abPlatformVariant, setAbPlatformVariant] = useState<string | null>(null);
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

        // Only mark loaded once we get a string value.
        if (typeof platformFlag === 'string') {
          setAbPlatformVariant(platformFlag);
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

    // Fallback: after 5 seconds, give up and render with defaults (control = todaytix).
    // This handles ad blockers / opted-out users — they get the control variant
    // and the click WILL still fire with ab_variant="platform:fallback,buttons:single"
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

  // Only the primary CTA renders — the multi-button row was the losing (by
  // owner UX decision, not by data — see header comment) side of the
  // concluded ticket-single-button A/B.
  const visibleLinks = sorted.slice(0, 1);

  // Tracking string kept in the same `flag:...,platform:...,buttons:...`
  // shape historical Impact conversions used, so `scripts/analyze-ab-test.js`
  // (still live for ticket-primary-platform) keeps parsing it — `buttons` is
  // now a constant, not a variant. `platform` still reflects the live
  // ticket-primary-platform flag, with the same "fallback" marker as before
  // when it hasn't loaded.
  const platformPart = abPlatformVariant ?? 'fallback';
  const abVariantStr = `flag:ticket-single-button,platform:${platformPart},buttons:single`;

  // Don't render anything until flags load (or fallback fires after 5s)
  // This eliminates the multi-default flicker that biased early clicks to control.
  if (!flagsLoaded) return null;
  // No affiliate-able ticketLinks at all — an unmonetized officialUrl link
  // (a show's own site, not a "buy now" promise) is exempt from the
  // not-yet-on-sale suppression below (BRO-166).
  const noTicketLinks = visibleLinks.length === 0;
  // `announced` shows with no priceFrom on any link haven't gone on sale yet — the
  // ticket record exists (we found the future TodayTix listing) but there's nothing
  // bookable behind it. Rendering the same bold "Get Tickets" primary CTA used for
  // live shows overpromises and dead-ends; suppress until a price appears (rage-click
  // root cause on the-visitors-off-broadway-2026, CLAUDE.md card #228). Doesn't
  // apply to the officialUrl-only case: "Visit Official Site" never promised
  // a purchase, so there's nothing to overpromise.
  const notYetOnSale = showStatus === 'announced' && !noTicketLinks && !sorted.some(l => l.priceFrom != null);
  // A show with no affiliate-able ticketLinks but a populated officialUrl must
  // still render a buy button (BRO-166) — officialUrl alone used to fall
  // through this guard and dead-end with no CTA at all.
  if (showStatus === 'closed' || notYetOnSale || (noTicketLinks && !officialUrl)) return null;

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
      {link.priceFrom ? `Get Tickets from ${getCurrencySymbol(showCategory, showVenue)}${link.priceFrom}` : `Get Tickets on ${link.platform}`}
      {withArrow && <span aria-hidden="true">→</span>}
    </TicketLink>
  );

  // noTicketLinks (declared above, before the early-return guard) — officialUrl
  // is the ONLY buy button available, so it takes over the primary-CTA slot
  // instead of the small secondary pill used when it's riding alongside a
  // real ticket link (BRO-166: never dead-end).
  const renderOfficialPrimary = (totalLinks: number, className: string, withArrow = false) => officialUrl ? (
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
      linkPosition={0}
      totalLinks={totalLinks}
      className={className}
    >
      Visit Official Site
      {withArrow && <span aria-hidden="true">→</span>}
    </TicketLink>
  ) : null;

  // splitVariant: primary CTA on its own row + an optional secondary row
  // below for secondaryAfter (Lottery/Rush) only — there is no longer a
  // multi-button secondary row to render (see header comment).
  if (splitVariant) {
    const primaryLink = visibleLinks[0];
    const totalLinksInRow = 1;
    return (
      // Mobile (< lg): primary CTA full-width on its own row, secondary scrolls below.
      // Desktop (lg+): primary CTA + secondary pills share one flex row, all inline.
      <div className="space-y-2 lg:space-y-0 lg:flex lg:flex-wrap lg:items-center lg:gap-2">
        {primaryLink
          ? renderPrimary(primaryLink, 0, totalLinksInRow, primaryButtonClassName, /* withArrow */ true)
          : renderOfficialPrimary(1, primaryButtonClassName, /* withArrow */ true)}
        {secondaryAfter != null && (
          <div className="flex flex-nowrap gap-2 overflow-x-auto scrollbar-hide pb-1 -mx-1 px-1 lg:mx-0 lg:px-0 lg:pb-0 lg:overflow-visible">
            {secondaryAfter}
          </div>
        )}
      </div>
    );
  }

  // Default inline mode (existing behavior — all callers other than ShowHeroRedesign).
  // Primary uses buttonClassName (same as secondary), no arrow — matches pre-split rendering.
  if (noTicketLinks) {
    return renderOfficialPrimary(1, buttonClassName);
  }
  return renderPrimary(visibleLinks[0], 0, 1, buttonClassName);
}
