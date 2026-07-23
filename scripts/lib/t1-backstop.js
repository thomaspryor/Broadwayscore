/**
 * >24h non-terminal backstop (Sprint 3 S3-T6, sprint-plan-t1-retrieval.md).
 *
 * The self-heal refetch (S3-T2) and the scoring self-dispatch (existing) resolve
 * MOST stuck T1 files within a couple of hours. This is the last-resort net for
 * the ones they don't: any in-window T1 file that has sat in a NON-TERMINAL,
 * non-scoreable state for more than 24h is a review the automation has failed to
 * recover — a human must act. It fires a deduped ACTION with the exact recovery
 * command, regardless of near-opening urgency (the sweep's normal email routing
 * only pages near-opening shows; this catches the back-catalogue stragglers the
 * urgent gate skips).
 *
 * "Non-terminal non-scoreable" = exactly the states classifySilentGap returns
 * (empty-body / unscored / rejected-unscoreable). Editorial/terminal exclusions
 * return null there and never reach this. So every gap the sweep produces IS a
 * non-terminal state by construction — the backstop only adds the AGE test.
 *
 * AGE is measured from the file's immutable firstSeenAt (S2-T4 — stamped at
 * creation, never changed on merge), falling back to collectedAt / textFetchedAt
 * / rejectedAt for pre-firstSeenAt files. If none is parseable the age is
 * unknown and the backstop does NOT fire (it can't prove >24h — no false page).
 *
 * Pure — no I/O. The sweep supplies the gap + file; the unit test drives it.
 */

'use strict';

const BACKSTOP_MIN_AGE_HOURS = 24;
const BACKSTOP_REALERT_DAYS = 7;

// Earliest trustworthy "we have had this file since" timestamp.
function gapFirstSeen(file) {
  if (!file) return null;
  return file.firstSeenAt || file.collectedAt || file.textFetchedAt || file.rejectedAt || null;
}

/**
 * Hours the file has been in a non-terminal state, or null when unknowable.
 * @param {object} file
 * @param {Date} now
 * @returns {number|null}
 */
function nonTerminalAgeHours(file, now) {
  const seen = gapFirstSeen(file);
  if (!seen) return null;
  const t = Date.parse(seen);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3600000;
}

/**
 * True when this gap file has been non-terminal for > minAgeHours. The caller
 * has already established it IS a (non-terminal) gap via classifySilentGap; this
 * adds only the age test.
 *
 * @param {object} p
 * @param {object} p.file
 * @param {Date} p.now
 * @param {number} [p.minAgeHours]
 * @returns {boolean}
 */
function isAgedNonTerminalGap({ file, now, minAgeHours = BACKSTOP_MIN_AGE_HOURS }) {
  const hours = nonTerminalAgeHours(file, now);
  if (hours == null) return false;
  return hours > minAgeHours;
}

/**
 * Backstop alert dedupe — fire once per show+file per re-alert window.
 * A PRESENT-but-unparseable stamp re-alerts (fail loud), matching shouldAlertGap.
 */
function shouldBackstopAlert(lastAlertedAt, now, days = BACKSTOP_REALERT_DAYS) {
  if (!lastAlertedAt) return true;
  const last = Date.parse(lastAlertedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= days * 24 * 60 * 60 * 1000;
}

module.exports = {
  BACKSTOP_MIN_AGE_HOURS,
  BACKSTOP_REALERT_DAYS,
  gapFirstSeen,
  nonTerminalAgeHours,
  isAgedNonTerminalGap,
  shouldBackstopAlert,
};
