/**
 * Prompt note for the ensemble scoreability gate when a show declares priorRuns
 * (earlier runs / tour legs of the SAME production). Pure function so a unit
 * test can require() the real thing (CLAUDE.md rule 15).
 *
 * BRO-5299: the-comedy-about-spies-west-end-2026 declares the 2025 Noel Coward
 * run as a prior run (inheritReviews:false). A genuine 2026 Adelphi review that
 * says the show is "celebrating its return to the West End" was rejected as
 * wrong_production because the note only told the model what counts as an
 * EARLIER run; a review of the returning engagement read as "the same show,
 * therefore the old staging". The return clause says that a review of the
 * current engagement of a returning production is this production.
 *
 * BRO-8093: the ensemble note and the collector's content-verifier hint
 * (content-verifier.js buildPriorRunHint) were meant to say the same thing but
 * drifted. The verifier said a review of a declared run IS this production and
 * must not be flagged "even where the guidance above calls a transfer a
 * different production"; the ensemble note only said such a review "qualifies
 * only if ...", so the base rubric's "reject transfer productions at other
 * venues" won. mexodus-off-broadway-2026 (Audible's Minetta Lane run declared
 * as a prior run, transferred to the Daryl Roth) had its 2025-10-04 Minetta
 * Lane review rejected wrong_production twice while 11 sibling Minetta Lane
 * reviews were included. Both builders now share DECLARED_RUN_AFFIRMATION, and
 * a test asserts both carry it, so the two prompts cannot drift again.
 * inheritReviews:false runs are a SEPARATE production: they are listed as such
 * (their reviews stay wrong_production) and never under "this same production".
 */

const DECLARED_RUN_AFFIRMATION = 'A review of a listed run at that venue, published inside the review window listed for that run, IS a review of THIS production: do NOT reject it as wrong_production, even though it names the earlier venue, does not mention the move, and even where the general rules call a tryout, transfer or earlier venue a different production. A review published outside every listed window is not covered by this rule.';

/**
 * " (opening to closing; reviews dated from..to count)" for one run. The
 * review window is the SAME one the deterministic guards use
 * (wrong-production-autoclear.js priorRunWindow), so the model never accepts
 * a date the rebuild would not (BRO-8093 ship-check: an open-ended "until the
 * current engagement" rule drifted from the 180-day / +7-day guard window).
 */
function describeDates(openingDate, closingDate) {
  if (!openingDate && !closingDate) return '';
  const base = `${openingDate || 'unknown'} to ${closingDate || 'unknown'}`;
  const { priorRunWindow } = require('./wrong-production-autoclear');
  const w = priorRunWindow({ openingDate, closingDate });
  return w ? ` (${base}; review window ${w.from} to ${w.to})` : ` (${base})`;
}

function sanitize(s) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function describeRun(p) {
  const dates = describeDates(p.openingDate, p.closingDate);
  const kind = p.note === 'tour leg' ? ' [tour leg]' : '';
  return `${p.venue ? sanitize(p.venue) : 'earlier run'}${dates}${kind}`;
}

/**
 * @param {Array<object>} priorRuns raw priorRuns (non-objects are ignored)
 * @returns {string|null} the NOTE line, or null when no valid prior run
 */
function buildPriorRunsNote(priorRuns) {
  const valid = Array.isArray(priorRuns) ? priorRuns.filter(p => p && typeof p === 'object') : [];
  if (valid.length === 0) return null;
  const inherited = valid.filter(p => p.inheritReviews !== false);
  const separate = valid.filter(p => p.inheritReviews === false);
  const parts = [];
  if (inherited.length) {
    parts.push(`NOTE: This same production also played declared earlier runs/tour legs: ${inherited.map(describeRun).join('; ')}. ${DECLARED_RUN_AFFIRMATION}`);
  }
  if (separate.length) {
    parts.push(`NOTE: Declared earlier staging(s) that are a SEPARATE production (their reviews are not this production's): ${separate.map(describeRun).join('; ')}. A review of one of these stagings is wrong_production.`);
  }
  parts.push('Any other staging — including earlier stagings by the same company, even at the same venue in a different year — is wrong_production.');
  parts.push('RETURN ENGAGEMENT: the current engagement may be a return of the declared earlier run (same cast and creative team, new venue or new dates). A review of the current venue that calls the show a return, transfer or revival of the earlier run, or that is published after the current engagement\'s previews began and describes the current cast and staging, reviews the CURRENT engagement. Do NOT flag it wrong_production merely because the show also played the earlier run; the rules above still decide every other review. This clause never relaxes the rules above for undeclared stagings.');
  return parts.join(' ');
}

module.exports = { buildPriorRunsNote, DECLARED_RUN_AFFIRMATION, describeDates };
