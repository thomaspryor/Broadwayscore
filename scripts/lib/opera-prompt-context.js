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
 * Context block for the wrong-PRODUCTION classifier. Tells the model that
 * opera works are performed at many opera houses across many seasons, and
 * that mentions of prior performances elsewhere do NOT mean the review is
 * about a different production.
 *
 * @returns {string}
 */
function getOperaWrongProductionContext() {
  return `OPERA CONTEXT (read carefully): This is an opera production at the Metropolitan Opera. Opera works like Tchaikovsky's "Eugene Onegin", Verdi's "La Traviata", or Wagner's "Tristan und Isolde" have been performed at the Met across many seasons with different casts and conductors. Mentions of prior performances at other opera houses (Royal Opera, La Scala, San Francisco Opera, San Diego Opera, etc.) are NORMAL context in opera criticism and do NOT mean the review is about a different production. WRONG_PRODUCTION for opera means the review is clearly about a different Met run (different cast + conductor in a different year), NOT that the work has been performed elsewhere. Be lenient — opera reviews routinely compare current and historical performances.`;
}

/**
 * Context block for the wrong-SHOW classifier. Tells the model that opera
 * reviews discussing arias, conductors, voice types, etc. ARE valid for the
 * filed show — only flag wrong_show if the text describes a different opera
 * by name.
 *
 * @returns {string}
 */
function getOperaWrongShowContext() {
  return `OPERA CONTEXT (read carefully): This show is an OPERA production at the Metropolitan Opera House (not a Broadway play or musical). Reviews discussing opera, conductors, sopranos/tenors/baritones/basses, arias, libretto, orchestral playing, and the Met are VALID for this show. Do NOT flag opera reviews as WRONG_SHOW just because they describe opera rather than Broadway theater. Only flag WRONG_SHOW if the review is clearly about a different opera/show by name.`;
}

module.exports = {
  isOperaShow,
  getOperaWrongProductionContext,
  getOperaWrongShowContext,
};
