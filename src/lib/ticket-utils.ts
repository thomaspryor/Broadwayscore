// ─── Ticket link sorting ────────────────────────────────
// Priority order for ticket platforms. Lower number = shown first.
// Affiliate-enabled platforms get priority to maximize revenue.
const TICKET_PLATFORM_PRIORITY: Record<string, number> = {
  TodayTix: 1,
  Telecharge: 2,
  Ticketmaster: 2,
  StubHub: 3,
  SeatGeek: 3,
  'Vivid Seats': 3,
  'London Theatre Direct': 3,
  SeatPlan: 3,
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
