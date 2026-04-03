// ─── Ticket link sorting ────────────────────────────────
// Priority order for ticket platforms. Lower number = shown first.
// Affiliate-enabled platforms get priority to maximize revenue.
// Affiliate-enabled platforms rank higher to maximize revenue.
// TodayTix drops to tier 2 until its Impact approval comes through.
const TICKET_PLATFORM_PRIORITY: Record<string, number> = {
  Ticketmaster: 1,
  SeatPlan: 1,
  'Vivid Seats': 1,
  StubHub: 1,
  TodayTix: 2,
  Telecharge: 2,
  SeatGeek: 3,
  'London Theatre Direct': 3,
};

export interface TicketLinkData {
  platform: string;
  url: string;
  priceFrom?: number | null;
  isOfficial?: boolean;
}

/** Sort ticket links by platform priority. Stable sort preserves shows.json order for equal priority. */
export function sortTicketLinks(links: TicketLinkData[]): TicketLinkData[] {
  return [...links].sort((a, b) => {
    return (TICKET_PLATFORM_PRIORITY[a.platform] ?? 99) - (TICKET_PLATFORM_PRIORITY[b.platform] ?? 99);
  });
}
