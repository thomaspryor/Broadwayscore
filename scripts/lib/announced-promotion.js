/**
 * Announced-show promotion decision (update-show-status.js Check 2e).
 *
 * Discovery creates date-less shows as status='announced'; enrichment scripts
 * later write previewsStartDate/openingDate onto them. Until 2026-07-14 no
 * status transition covered 'announced', so shows stayed invisible on
 * upcoming browse pages forever (dolly-an-original-musical-2026 incident).
 *
 * Pure function so scripts/test-announced-promotion.js exercises the real
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

  const refDate = show.openingDate || show.previewsStartDate;
  if (reached(refDate) && staleBy(refDate) > ANNOUNCED_PROMOTE_MAX_STALE_DAYS) {
    return {
      action: 'triage',
      reason: `${show.openingDate ? 'openingDate' : 'previewsStartDate'} ${refDate} passed ${ANNOUNCED_PROMOTE_MAX_STALE_DAYS}+ days ago — zombie entry (cancelled? placeholder date? actually open/closed?)`,
    };
  }

  const to = reached(show.openingDate) ? 'open'
    : reached(show.previewsStartDate) ? 'previews'
    : 'upcoming';
  return { action: 'promote', to };
}

module.exports = { decideAnnouncedPromotion, ANNOUNCED_PROMOTE_MAX_STALE_DAYS };
