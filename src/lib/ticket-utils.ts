// ─── Ticket link sorting ────────────────────────────────
// Priority order for ticket platforms. Lower number = shown first.
// Affiliate-enabled platforms get priority to maximize revenue.
// TodayTix has highest coverage (185+ shows) and now has live affiliate tracking.
// Official box office platforms (Telecharge, Ticketmaster) rank next,
// then resale/secondary platforms.
const TICKET_PLATFORM_PRIORITY: Record<string, number> = {
  TodayTix: 1,
  Telecharge: 2,
  Ticketmaster: 2,
  SeatPlan: 3,
  StubHub: 3,
  'Vivid Seats': 3,
  SeatGeek: 3,
  'London Theatre Direct': 3,
};

// ─── Hidden platforms ─────────────────────────────────────
// Platforms in this set are stripped from all ticket-link rendering — the
// URL stays in shows.json (so we can re-enable quickly) but no button is
// shown on show cards, show pages, or anywhere sortTicketLinks() is called.
//
// StubHub hidden 2026-04-11: 56 clicks over 180 days, 0 conversions. Stale
// performer IDs (now replaced with /search?q= fallback URLs) combined with
// extra-click search-page friction means every StubHub click was opportunity
// cost vs TodayTix's proven $0.614 EPC. Will re-enable when Partnerize/
// StubHub approves API access for direct deep-link lookups.
// See memory/feedback_stubhub_hidden.md for the decision rationale.
//
// Ticketmaster hidden 2026-06-29: 63 Impact-tracked clicks over 90 days,
// 0 conversions (0 ever). NOT an attribution bug — program is Active and our
// deep link matches Impact's official TrackingLink exactly; Impact records the
// clicks (TodayTix click counts parity-match PostHog, confirming tracking works).
// The 0 is real: Ticketmaster's program excludes/stand-downs the sales and the
// fee-heavy checkout bounces users. Only renders on 11 evergreen shows, all of
// which keep TodayTix + Official Site (whose marketing sites route to
// Ticketmaster anyway), so no official buy path is lost. $0 earned, so hiding
// it removes CTA clutter and may nudge clicks to revenue-producing TodayTix.
//
// Telecharge hidden 2026-07-19: no affiliate program exists (never in
// AFFILIATE_CONFIG), so every click is unpaid opportunity cost vs TodayTix.
// 25 shows carry the link; 24 also show TodayTix, and Shubert shows keep an
// Official Site button whose marketing pages route to Telecharge anyway, so
// no official buy path is lost. Only the-balusters-2026 (closed) had
// Telecharge as its sole visible link. Same consolidation logic as the
// Ticketmaster hide above.
const HIDDEN_PLATFORMS: Set<string> = new Set([
  'StubHub',
  'Ticketmaster',
  'Telecharge',
]);

// Ticketmaster un-hidden 2026-08-03 for the TodayTix-gap backfill (task #956):
// the 2026-06-29 hide was scoped to 11 evergreen shows that ALL kept
// TodayTix + Official Site — TM was pure redundancy there, hence 0
// conversions. The ~52 shows with no TodayTix link at all are a different
// population: TM is often the only real affiliate-tracked buy path they
// have. getVisibleTicketLinks() now renders Ticketmaster whenever a show
// has no TodayTix link, regardless of what else is present (Venue Box
// Office / SeatPlan / OvationTix links don't carry affiliate tracking, so
// they don't compete with TM for the same revenue). Ticketmaster stays
// hidden as before on any show that DOES carry TodayTix.
const HIDDEN_UNLESS_NO_TODAYTIX: Set<string> = new Set(['Ticketmaster']);

export interface TicketLinkData {
  platform: string;
  url: string;
  priceFrom?: number | null;
  isOfficial?: boolean;
}

/**
 * Sort ticket links by platform priority, filtering out hidden platforms.
 * Stable sort preserves shows.json order for equal priority.
 * @param overrideFirstPlatform — A/B test override: force a specific platform to position 0.
 *   Only used by TicketButtonsAB on show pages. Other callers omit this param.
 */
/**
 * The single source of truth for which of a show's ticket links are visible.
 * Never leaves a show buttonless: the HIDDEN_PLATFORMS rationale above is
 * explicitly conditioned on "no official buy path is lost" (every hidden
 * link had a TodayTix/Official sibling). When hiding would remove a show's
 * ONLY link (e.g. Les Mis Arena Concert at Radio City — Ticketmaster is the
 * sole seller), the affiliate-consolidation logic doesn't apply and the
 * best hidden link renders instead. StubHub stays hidden even here —
 * resale-only is worse than no button.
 *
 * Every caller that decides visibility from ticket links MUST use this (or
 * sortTicketLinks, which wraps it) — a bare isPlatformHidden() filter answers
 * a different question and drifts from what the show page actually renders
 * (the exact class behind the Les Mis zero-button incident).
 */
export function getVisibleTicketLinks(links: TicketLinkData[]): TicketLinkData[] {
  const hasTodayTix = links.some(l => l.platform === 'TodayTix');
  const effectiveHidden = hasTodayTix
    ? HIDDEN_PLATFORMS
    : new Set(Array.from(HIDDEN_PLATFORMS).filter(p => !HIDDEN_UNLESS_NO_TODAYTIX.has(p)));
  const visible = links.filter(l => !effectiveHidden.has(l.platform));
  return visible.length > 0 ? visible : links.filter(l => l.platform !== 'StubHub');
}

export function sortTicketLinks(links: TicketLinkData[], overrideFirstPlatform?: string): TicketLinkData[] {
  return [...getVisibleTicketLinks(links)]
    .sort((a, b) => {
      if (overrideFirstPlatform) {
        if (a.platform === overrideFirstPlatform && b.platform !== overrideFirstPlatform) return -1;
        if (b.platform === overrideFirstPlatform && a.platform !== overrideFirstPlatform) return 1;
      }
      return (TICKET_PLATFORM_PRIORITY[a.platform] ?? 99) - (TICKET_PLATFORM_PRIORITY[b.platform] ?? 99);
    });
}

/**
 * Is this platform hidden by DEFAULT (i.e. when a show also carries TodayTix)?
 * Ticketmaster's real hidden status is link-set-dependent — see
 * getVisibleTicketLinks — so this answers "hidden in the common case," not
 * "hidden on every show." Exposed for analytics/debug only; nothing in this
 * repo calls it as of 2026-08-03. Prefer getVisibleTicketLinks/sortTicketLinks
 * for anything that decides real per-show visibility.
 */
export function isPlatformHidden(platform: string): boolean {
  return HIDDEN_PLATFORMS.has(platform);
}
