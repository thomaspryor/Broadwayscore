/**
 * Which explanatory note (if any) replaces the ticket CTA. TicketButtonsAB
 * itself renders nothing for closed/not-yet-on-sale shows, so this is the
 * only thing standing between a show page and a silent gap where the "Get
 * Tickets" button used to be — the exact gap users rage-clicked (CLAUDE.md
 * card #228, task #90). The 'closed' branch checks status alone, not
 * rawTicketLinks.length, because a closed show can have zero ticketLinks
 * ever recorded (e.g. the-whos-tommy-2024) — gating on length > 0 silently
 * reintroduced the gap for exactly that case.
 *
 * Shared by src/app/show/[slug]/page.tsx and
 * src/components/show-page/ShowHeroRedesign.tsx so the two hero variants
 * can't drift the same way they did before (each hardcoded its own copy of
 * this condition).
 */
function getTicketCtaNote(showStatus, rawTicketLinks, sortedTicketLinks) {
  if (showStatus === 'closed') return 'closed';
  if (
    showStatus === 'announced' &&
    !sortedTicketLinks.some((l) => l.priceFrom != null) &&
    (rawTicketLinks?.length ?? 0) > 0
  ) {
    return 'announced-not-on-sale';
  }
  return null;
}

module.exports = { getTicketCtaNote };
