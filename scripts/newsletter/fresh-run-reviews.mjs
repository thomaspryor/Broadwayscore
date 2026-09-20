// Fresh-run review gate for the weekly newsletter (BRO-3822).
//
// A show declared with `priorRuns` deliberately re-includes an EARLIER
// engagement's reviews (memory/feedback_returning_production_priorRuns.md).
// The newsletter's opening sections gate purely on review COUNT
// (minReviews()), never on when those reviews were published. Those two
// mechanisms combine into an email that announces a show as newly opened
// over a critic score built entirely from a run that closed years ago.
//
// Live incident, 2026-09-19: the West End weekly round-up draft led with
// "My Son's A Queer (But What Can You Do?) opens to strong reviews" and
// showed it as Recommended on 6 reviews. All six were dated 2022-10-24 and
// their URLs were Garrick Theatre reviews; the 2026 engagement is a
// two-and-a-half week farewell run at the Apollo that had drawn no press at
// all. Nothing in the pipeline was wrong — shows.json correctly declares the
// 2022 Garrick priorRun — but the newsletter had no way to notice.
//
// Owner decision 2026-09-19 (Option A of two): require at least one FRESH
// T1/T2 review before a show may be announced as opening. Rationale: a
// returning production's older reviews are legitimately about the same show,
// so they should still count toward the displayed score; but one notice from
// a major outlet covering THIS run is the proof that this run actually got
// reviewed. The rejected alternative (require a majority of reviews to be
// fresh) would silence short runs with light press entirely.
//
// This is a no-op for an ordinary opening: a show with no priorRuns has only
// fresh reviews, so the gate passes on the first T1/T2 notice it receives.
// It only bites when a show's major-outlet coverage is entirely from a
// previous engagement.

// Reviews can legitimately land slightly before the official press night
// (embargo breaks, Talkin' Broadway's 24h-early publishing — see CLAUDE.md
// §14). Anchor the window a few days before previews so those still count
// as covering THIS run, while a prior engagement months or years back never
// can.
export const FRESH_GRACE_DAYS = 7;

// T1 and T2 only. A T3/T4 blog notice is not enough to claim the run was
// covered — those are exactly the outlets that recycle or auto-generate
// around a revival, and the whole point of the gate is evidence that the
// press actually turned up.
const FRESH_TIERS = new Set([1, 2]);

function shiftDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The date on or after which a review counts as covering the CURRENT run.
 * Previews start is the right anchor, not opening night — critics attend
 * previews and some outlets publish before press night.
 *
 * @param {{previewsStartDate?: string, openingDate?: string}} show
 * @returns {string|null} ISO date, or null when the show has no usable date
 */
export function freshCutoffFor(show) {
  if (!show) return null;
  const anchor = show.previewsStartDate || show.openingDate;
  if (!anchor || typeof anchor !== 'string') return null;
  return shiftDays(anchor.slice(0, 10), -FRESH_GRACE_DAYS);
}

/**
 * Does this show have at least one scored T1/T2 review published against the
 * current run?
 *
 * Fails OPEN (returns true) when the show carries no `priorRuns` — the gate
 * exists for returning productions, and a show with no declared prior run has
 * no mechanism to import foreign-run reviews in the first place. Keeping the
 * check scoped this way means a date-metadata gap on an ordinary opening can
 * never silently drop it from the newsletter, which would be a far worse
 * failure than the one being fixed.
 *
 * @param {object} show                shows.json entry
 * @param {Array<object>} showReviews  reviews for THIS show (scored or not)
 * @param {(outletId: string) => number} tierOf  outlet -> tier resolver
 * @returns {boolean}
 */
export function hasFreshRunReview(show, showReviews, tierOf) {
  if (!show) return false;
  if (!Array.isArray(show.priorRuns) || show.priorRuns.length === 0) return true;
  const cutoff = freshCutoffFor(show);
  // A returning production with no usable date can't be evaluated. Fail open
  // rather than dropping it — same reasoning as the no-priorRuns case.
  if (!cutoff) return true;
  return (showReviews || []).some((r) => {
    if (!r || r.assignedScore == null) return false;
    const pub = typeof r.publishDate === 'string' ? r.publishDate.slice(0, 10) : '';
    if (!pub || pub < cutoff) return false;
    return FRESH_TIERS.has(tierOf(r.outletId));
  });
}
