'use strict';
/**
 * BRO-7778: press titles (shows.json akaTitles). Critics drop subtitles: "It's A Wonderful Life: A Live Radio Play"
 * is reviewed as "Review: It's a Wonderful Life". This file holds the rules for those names. Pure, no I/O (rule 15).
 */
const fold = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
/** Normalised comparison key ("It’s A Wonderful Life" -> "its a wonderful life"). */
function normTitle(t) {
  return fold(t).toLowerCase().replace(/[‘’ʼ']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Plan value check for shows.json akaTitles (data-edit-action.js): null clears it; otherwise a non-empty array of
 * distinct press titles. An entry the plan ADDS must not be another show's billed title or aka (that would file one
 * show's reviews under the other) unless that show is the same work (same workKey). Entries already stored are not
 * re-judged (as images are not): some existing akas predate this check. A case/punctuation variant of the show's own
 * title is allowed (Playbill matching uses those).
 * @param {string[]|null} [prevValue] the stored value
 * @returns {string|null}
 */
function akaTitlesValueProblem(value, show, shows, prevValue = null) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length === 0) return 'akaTitles: must be null or a non-empty array of strings';
  const seen = new Set();
  for (const a of value) {
    if (typeof a !== 'string' || a.trim().length < 2 || a.length > 150) return `akaTitles: bad entry ${JSON.stringify(a)}`;
    const k = normTitle(a);
    if (!k) return `akaTitles: bad entry ${JSON.stringify(a)}`;
    if (seen.has(k)) return `akaTitles: duplicate ${JSON.stringify(a)}`;
    seen.add(k);
    if (Array.isArray(prevValue) && prevValue.some((p) => normTitle(p) === k)) continue;
    const work = show && show.workKey;
    const other = (shows || []).find((s) => s && s.id !== (show && show.id) && !(work && s.workKey === work) && (normTitle(s.title) === k
      || (Array.isArray(s.akaTitles) && s.akaTitles.some((x) => normTitle(x) === k))));
    if (other) return `akaTitles: ${JSON.stringify(a)} is already a title of another show (${other.id})`;
  }
  return null;
}

module.exports = { akaTitlesValueProblem, normTitle };
