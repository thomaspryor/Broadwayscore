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
 */

function sanitize(s) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * @param {Array<object>} priorRuns raw priorRuns (non-objects are ignored)
 * @returns {string|null} the NOTE line, or null when no valid prior run
 */
function buildPriorRunsNote(priorRuns) {
  const valid = Array.isArray(priorRuns) ? priorRuns.filter(p => p && typeof p === 'object') : [];
  if (valid.length === 0) return null;
  const legs = valid
    .map(p => {
      const dates = p.openingDate || p.closingDate
        ? ` (${p.openingDate || 'unknown'} to ${p.closingDate || 'unknown'})`
        : '';
      const kind = p.note === 'tour leg' ? ' [tour leg]' : '';
      return `${p.venue ? sanitize(p.venue) : 'earlier run'}${dates}${kind}`;
    })
    .join('; ');
  return `NOTE: This same production also played declared earlier runs/tour legs: ${legs}. A review qualifies as THIS production only if it matches a listed venue AND falls within that leg's date range (or reviews the current venue during the current engagement). Any other staging — including earlier stagings by the same company, even at the same venue in a different year — is wrong_production. `
    + 'RETURN ENGAGEMENT: the current engagement may be a return of the declared earlier run (same cast and creative team, new venue or new dates). A review of the current venue that calls the show a return, transfer or revival of the earlier run, or that is published after the current engagement\'s previews began and describes the current cast and staging, reviews the CURRENT engagement. Do NOT flag it wrong_production merely because the show also played the earlier run; the rule above still decides every other review. This clause never relaxes the rule above for undeclared stagings.';
}

module.exports = { buildPriorRunsNote };
