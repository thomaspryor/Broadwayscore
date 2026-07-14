/**
 * Announced-show promotion decision (update-show-status.js Check 2e).
 *
 * Discovery creates date-less shows as status='announced'; enrichment scripts
 * later write previewsStartDate/openingDate onto them. Until 2026-07-14 no
 * status transition covered 'announced', so shows stayed invisible on
 * upcoming browse pages forever (dolly-an-original-musical-2026 incident).
 *
 * Pure function so tests/unit/announced-promotion.test.mjs exercises the real
 * decision (CLAUDE.md §15 — never copy logic into tests).
 */

// A reached date more than this many days in the past marks a zombie entry
// (announced, then never maintained: wanted-2022, private-lives-2025,
// TodayTix Jan-1 placeholder dates). Promoting those to 'open' would pollute
// Now Playing — surface for manual triage instead.
const ANNOUNCED_PROMOTE_MAX_STALE_DAYS = 45;

/**
 * @param {object} show - shows.json entry
 * @param {Date} [now] - injectable clock for tests
 * @returns {{action: 'promote', to: string} | {action: 'triage', reason: string} | {action: 'none'}}
 */
function decideAnnouncedPromotion(show, now = new Date()) {
  if (show.status !== 'announced') return { action: 'none' };
  if (!show.openingDate && !show.previewsStartDate) return { action: 'none' };

  const dayMs = 24 * 60 * 60 * 1000;
  const reached = (dateStr) => dateStr && (now.getTime() >= new Date(dateStr + 'T00:00:00').getTime());
  const staleBy = (dateStr) =>
    (now.getTime() - new Date(dateStr + 'T00:00:00').getTime()) / dayMs;
  const isStale = (dateStr) => !!dateStr && staleBy(dateStr) > ANNOUNCED_PROMOTE_MAX_STALE_DAYS;

  // Staleness is judged per-date: a stale placeholder openingDate must not
  // block promotion when previewsStartDate is future/recent (and vice versa).
  // Only triage when EVERY known date is stale — then the entry is a zombie.
  const openStale = isStale(show.openingDate);
  const prevStale = isStale(show.previewsStartDate);
  const usableOpening = show.openingDate && !openStale ? show.openingDate : null;
  const usablePreviews = show.previewsStartDate && !prevStale ? show.previewsStartDate : null;

  if (!usableOpening && !usablePreviews) {
    const staleDesc = [
      openStale ? `openingDate ${show.openingDate}` : null,
      prevStale ? `previewsStartDate ${show.previewsStartDate}` : null,
    ].filter(Boolean).join(' and ');
    return {
      action: 'triage',
      reason: `${staleDesc} passed ${ANNOUNCED_PROMOTE_MAX_STALE_DAYS}+ days ago — zombie entry (cancelled? placeholder date? actually open/closed?)`,
    };
  }

  const to = reached(usableOpening) ? 'open'
    : reached(usablePreviews) ? 'previews'
    : 'upcoming';
  return { action: 'promote', to };
}

module.exports = { decideAnnouncedPromotion, ANNOUNCED_PROMOTE_MAX_STALE_DAYS };
