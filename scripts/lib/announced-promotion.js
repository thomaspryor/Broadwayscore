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

/**
 * Gate on the review-driven catch-up (update-show-status.js Check 2d) for
 * shows whose status is 'announced'. Returns a block reason, or null to allow.
 *
 * Why this exists (BRO-3091 ship-check, 2026-09-13). Adding 'announced' to
 * opening-signal.js's PRE_OPEN_STATUSES let Check 2d unstick the date-less
 * discovery class, but it also handed that class the only two paths in Check 2d
 * that carry no temporal evidence of their own:
 *
 *  1. Zombie bypass. Check 2e returns action:'triage' for an announced entry
 *     whose every known date is >ANNOUNCED_PROMOTE_MAX_STALE_DAYS in the past
 *     (cancelled run, placeholder date, already-closed run). Triage deliberately
 *     does NOT promote — it logs for a human, so zombies never reach "Now
 *     Playing". But triage sets no changes.status, so Check 2d ran next and
 *     would happily promote the very entries the 45-day rule protects.
 *
 *  2. No temporal floor. isStuckInPreviews (the score-threshold arm) counts
 *     reviews and consults no date at all, and openSignalFromReviews' lower
 *     bound is `show.previewsStartDate && ...` — inert precisely when both dates
 *     are null, which IS this class. So a returning production with declared
 *     priorRuns (review-guards.js keeps prior-run reviews in reviews.json) could
 *     flip to 'open' on its PREVIOUS run's reviews, stamping that run's press
 *     night as openingDate.
 *
 * The fix for both: an announced show may only be caught up on a press night we
 * can actually date, that has been reached, and that is recent enough to mean
 * "this run, now". Recency reuses ANNOUNCED_PROMOTE_MAX_STALE_DAYS so there is
 * one staleness horizon for 'announced', not two.
 *
 * This also reconciles the flip with src/lib/engine.ts's stated premise that an
 * announced show's reviews "belong to a prior production": that assumption holds
 * for everything this gate blocks, and the flip overrides it only where a
 * recent, dated press night contradicts it.
 *
 * A blocked show stays 'announced' and is surfaced by
 * scripts/audit-stale-announced-shows.js for human triage + --ack, which is
 * exactly that script's job — "cancelled, or actually open, or actually closed?"
 * is a judgment call, and guessing 'open' labels a finished run "Now Playing".
 *
 * @param {object} show - shows.json entry
 * @param {object} announcedDecision - decideAnnouncedPromotion(show) result
 * @param {string|null} pressNight - 'YYYY-MM-DD' the flip would stamp, or null
 * @param {Date} [now]
 * @returns {{reason: string}|null} null = allowed
 */
function blockAnnouncedCatchUp(show, announcedDecision, pressNight, now = new Date()) {
  if (!show || show.status !== 'announced') return null;

  if (announcedDecision && announcedDecision.action === 'triage') {
    return {
      reason: `Check 2e classified this as a zombie entry (${announcedDecision.reason}) `
        + '- review-driven catch-up must not promote it to "Now Playing"',
    };
  }

  if (!pressNight) {
    return {
      reason: 'no press night is derivable from the reviews (dateless) - that is '
        + 'evidence reviews exist, not evidence THIS production opened',
    };
  }

  const pressNightMs = new Date(pressNight + 'T00:00:00').getTime();
  if (Number.isNaN(pressNightMs)) {
    return { reason: `press night ${pressNight} is unparseable` };
  }

  const ageDays = Math.floor((now.getTime() - pressNightMs) / (24 * 60 * 60 * 1000));
  if (ageDays > ANNOUNCED_PROMOTE_MAX_STALE_DAYS) {
    return {
      reason: `press night ${pressNight} is ${ageDays}d old (>${ANNOUNCED_PROMOTE_MAX_STALE_DAYS}d) `
        + "- likely a prior production's reviews, or a run that has already closed",
    };
  }

  return null;
}

module.exports = {
  decideAnnouncedPromotion,
  blockAnnouncedCatchUp,
  ANNOUNCED_PROMOTE_MAX_STALE_DAYS,
};
