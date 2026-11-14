/**
 * Page-level check for an aggregator round-up (BRO-3564): do its excerpts,
 * taken together, talk about the show the page was filed under?
 *
 * The westendtheatre.com page archived for My Neighbour Totoro was the Wendy &
 * Peter Pan (Barbican 2025) round-up. Every row matched a critic by outlet +
 * name, so The Times' Clive Davis row put a Peter Pan excerpt on his Totoro
 * review. No single row can tell (excerpts often skip the title), but eight
 * excerpts that never name the show, while the page is long enough that a
 * real round-up would, mean the page is about something else.
 *
 * When the caller knows the page's own headline (the WordPress post title),
 * a headline that names the show settles it: excerpts alone under-name the
 * show (the Back to the Future round-up's six excerpts never say the title).
 *
 * Text only: never reads the row URLs (CLAUDE.md §3).
 */
const { validateShowMentioned } = require('./content-quality');
const { textMentionsTitle } = require('./show-title-variants');

// Below this much excerpt text a real round-up can plausibly skip the title
// (Stagedoor rows are one-line headlines), so the page is not judged.
const MIN_ROWS = 3;
const MIN_CHARS = 600;

/**
 * Does a round-up headline name the show? Titles under four characters ("Red")
 * must lead the headline, so "The Red Shoes reviews" does not count for Red.
 */
function headlineNamesShow(headline, title) {
  if (typeof headline !== 'string' || !headline.trim()) return false;
  if (textMentionsTitle(headline, title)) return true;
  const t = title.trim();
  return t.length < 4 && !!textMentionsTitle(headline.trim().slice(0, t.length + 1), t, { minVariantLength: 1 });
}

/**
 * @param {Array<{excerpt?: string}>} rows   one aggregator page's rows
 * @param {{id: string, title: string}} show the show the page is filed under
 * @param {{pageTitle?: string}} [opts]      the page's own headline, when known
 * @returns {{ok: boolean, judged: boolean, reason: string}}
 */
function roundupExcerptsAboutShow(rows, show, { pageTitle } = {}) {
  if (show && show.title && headlineNamesShow(pageTitle, show.title)) {
    return { ok: true, judged: true, reason: 'page headline names the show' };
  }
  const excerpts = (rows || []).map(r => (r && typeof r.excerpt === 'string' ? r.excerpt.trim() : ''))
    .filter(Boolean);
  const joined = excerpts.join('\n');
  if (!show || !show.title || excerpts.length < MIN_ROWS || joined.length < MIN_CHARS) {
    return { ok: true, judged: false, reason: 'too little excerpt text to judge' };
  }
  const v = validateShowMentioned(joined, show.title, show.id);
  return v.valid
    ? { ok: true, judged: true, reason: v.reason }
    : { ok: false, judged: true, reason: `${excerpts.length} excerpts never name "${show.title}" (${v.reason})` };
}

/**
 * Pure: the edit that removes what a rejected round-up page planted on one review
 * record (its excerpt, relayed star and WET score), or null when the record holds
 * none of that page's rows. Used by scripts/clear-wrong-show-roundup-excerpts.js.
 */
function planWrongShowRoundupClear(record, rows) {
  const ex = typeof record.westEndTheatreExcerpt === 'string' ? record.westEndTheatreExcerpt.trim() : '';
  if (!ex) return null;
  const row = rows.find(r => typeof r.excerpt === 'string' && r.excerpt.trim() === ex);
  if (!row) return null;
  const out = { ...record };
  delete out.westEndTheatreExcerpt;
  delete out.westEndTheatreScore;
  // The WET writers also relay the row's star as a sourceless aggregatorStars.
  // With the excerpt gone, the rebuild's excerpt-vs-fullText check has nothing
  // to compare, so that star would score the file: drop it too. A star with an
  // aggregatorStarsSource came from the outlet's own page and stays.
  const starOf = (v) => { const m = String(v || '').match(/^\s*(\d+(?:\.\d+)?)\s*\/\s*5\b/); return m ? Number(m[1]) : null; };
  if (out.aggregatorStars && !out.aggregatorStarsSource
      && row.stars != null && starOf(out.aggregatorStars) === Number(row.stars)) {
    delete out.aggregatorStars;
  }
  if (out.scoreSource === 'westendtheatre-star-rating') {
    require('./rescore-flagging').markRescoreNeeded(out, 'wrong-show round-up star removed (BRO-3564)', undefined, { requeue: true });
    delete out.rescoreCompletedAt;
  }
  out.wrongShowRoundupCleared = { at: new Date().toISOString(), source: 'westendtheatre' };
  return out;
}

module.exports = { roundupExcerptsAboutShow, headlineNamesShow, planWrongShowRoundupClear, MIN_ROWS, MIN_CHARS };
