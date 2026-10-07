/**
 * Opera-aware prompt context — single source of truth for the framing
 * blocks injected into wrong-production / wrong-show / scoring prompts when
 * a review is filed under an opera production.
 *
 * Background: Met opera shows live in shows.json with category='off-broadway'
 * + type='opera' + venue='Metropolitan Opera House'. LLM classifiers tuned for
 * Broadway theater consistently mis-flag opera reviews as wrong_production /
 * wrong_show because the text discusses opera (conductors, arias, opera houses)
 * rather than theater. Without an explicit opera framing block, the temporal
 * override has to rescue every opera review at rebuild time — see Notion
 * 363637c5-416f-81cc-8240-c48df8b4cfd2 for the full incident history.
 *
 * Used by:
 *   - scripts/classify-wrong-production.js
 *   - scripts/classify-wrong-show.js
 *
 * Tested by: tests/unit/opera-prompt-context.test.mjs
 */

/**
 * Returns true if the show should be framed as opera in LLM prompts.
 * Currently this is just `show.type === 'opera'` — extend if non-Met opera
 * houses get added later (NYCO, Glimmerglass, ENO, etc.).
 *
 * @param {{type?: string}|null|undefined} show
 * @returns {boolean}
 */
function isOperaShow(show) {
  if (!show) return false;
  return show.type === 'opera';
}

/**
 * Context block for the wrong-PRODUCTION classifier.
 *
 * IMPORTANT (2026-05-17 ship-check P1-A): wording carefully balanced to avoid
 * false-negatives. The earlier draft said "Be lenient" which stacked with the
 * classifier's pre-existing "lean toward CORRECT on ambiguous" instruction
 * (classify-wrong-production.js:254) — three reviewers flagged this as
 * false-negative risk for genuine wrong-production cases like the 2018 WSJ
 * Waleson La Traviata review. The replacement language is symmetric:
 * mentions of OTHER OPERA HOUSES (different company) are normal context;
 * mentions of a DIFFERENT MET RUN (different cast/conductor/year, same
 * venue) ARE wrong_production — and that distinction is spelled out
 * before any leniency note, not after.
 *
 * @returns {string}
 */
function getOperaWrongProductionContext() {
  return `OPERA CONTEXT (read carefully — opera classification differs from theater):
This is an opera production at the Metropolitan Opera. Opera works (Tchaikovsky's "Eugene Onegin", Verdi's "La Traviata", Wagner's "Tristan und Isolde", etc.) are repertory pieces that the Met has performed across many seasons with different casts and conductors, and that other opera companies (Royal Opera, La Scala, San Francisco Opera, Lyric Opera Chicago, Houston Grand Opera, San Diego Opera, any non-Met house or company) have performed independently.

DISTINCTION (apply this rule strictly — leniency does NOT apply when there is a year mismatch):
  - WRONG_PRODUCTION (flag this): the review evaluates a DIFFERENT MET RUN — different cast, conductor, or season at the Metropolitan Opera House. Cues: prior Met opening year named in the text, prior Met music director named, prior Met staging credited (e.g. "the 2018 Michael Mayer staging" when the filed run is a 2026 Yannick Nézet-Séguin run), publishDate more than ~6 months before the filed production's opening date with no other explanation.
  - CORRECT (do not flag): the review evaluates the CURRENT Met production but mentions performances at other opera houses or prior productions as comparison/context. Mere mention of "I saw this at San Diego Opera in 2022" or "Royal Opera's 2020 production" is contextual reference, not evidence of wrong production.

Decide based on what the review is EVALUATING, not what it mentions. Year-mismatched publishDates are a strong WRONG_PRODUCTION signal even when the text reads as a legitimate review.`;
}

/**
 * Context block for the wrong-SHOW classifier.
 *
 * Tightened 2026-05-17 (ship-check P1-A): explicit that "wrong show" is
 * preserved as a real signal — opera framing does NOT relax the genuine
 * wrong-show check, only prevents Broadway-vs-opera from being a false
 * wrong-show signal.
 *
 * @returns {string}
 */
function getOperaWrongShowContext() {
  return `OPERA CONTEXT (read carefully):
This show is an OPERA production at the Metropolitan Opera House. The show being classified is opera, NOT a Broadway play or musical.

CORRECT (do not flag as wrong_show): the review discusses opera, conductors, sopranos/tenors/baritones/basses, arias, libretto, orchestral playing, the Met, or other opera-specific vocabulary. Mentions of other operas or other opera houses for comparison are valid context.

WRONG_SHOW (still flag): the review is clearly about a DIFFERENT opera or different show entirely — different title named in the text, different composer, different plot. The opera framing does NOT relax this — wrong show is wrong show regardless of genre. Garbage / navigation / non-review content is still WRONG_SHOW.`;
}

module.exports = {
  isOperaShow,
  getOperaWrongProductionContext,
  getOperaWrongShowContext,
};
