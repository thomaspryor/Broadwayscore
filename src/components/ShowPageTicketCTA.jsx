'use client';

import TicketButtonsAB from '@/components/TicketButtonsAB';
import { getTicketCtaNote } from '@/lib/ticket-cta-note';

/**
 * Shared show-page purchase area for both hero layouts. Keep the existing
 * seller selection, first-paint rendering and click attribution in
 * TicketButtonsAB/TicketLink. Audit and follow-up plan: docs/audits/bro-43-ticket-cta.md.
 *
 * @param {import('react').ComponentProps<typeof TicketButtonsAB> & {
 *   rawTicketLinks?: import('@/lib/ticket-utils').TicketLinkData[],
 *   noteClassName?: string,
 *   children?: import('react').ReactNode
 * }} props
 */
export default function ShowPageTicketCTA({
  rawTicketLinks,
  noteClassName = 'w-full text-xs text-fg-muted',
  children,
  ...ticketProps
}) {
  const note = getTicketCtaNote(ticketProps.showStatus, rawTicketLinks, ticketProps.ticketLinks);

  return (
    <>
      {note !== 'closed' && (ticketProps.ticketLinks.length > 0 || ticketProps.officialUrl) && (
        <TicketButtonsAB {...ticketProps} />
      )}
      {children}
      {note === 'closed' && (
        <p className={noteClassName}>This show has closed. Tickets are no longer available.</p>
      )}
      {note === 'announced-not-on-sale' && (
        <p className={noteClassName}>Tickets aren&apos;t on sale yet. Check back closer to opening.</p>
      )}
    </>
  );
}
