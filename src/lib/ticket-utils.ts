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
const HIDDEN_PLATFORMS: Set<string> = new Set([
  'StubHub',
]);

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
export function sortTicketLinks(links: TicketLinkData[], overrideFirstPlatform?: string): TicketLinkData[] {
  return [...links]
    .filter(l => !HIDDEN_PLATFORMS.has(l.platform))
    .sort((a, b) => {
      if (overrideFirstPlatform) {
        if (a.platform === overrideFirstPlatform && b.platform !== overrideFirstPlatform) return -1;
        if (b.platform === overrideFirstPlatform && a.platform !== overrideFirstPlatform) return 1;
      }
      return (TICKET_PLATFORM_PRIORITY[a.platform] ?? 99) - (TICKET_PLATFORM_PRIORITY[b.platform] ?? 99);
    });
}

/** Is this platform currently hidden from rendering? Exposed for analytics/debug. */
export function isPlatformHidden(platform: string): boolean {
  return HIDDEN_PLATFORMS.has(platform);
}
