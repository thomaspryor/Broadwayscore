/**
 * Own-show text evidence (BRO-5805).
 *
 * The content verifier (an LLM) reads a stored review body and may rule it
 * "wrong production / wrong show / film-TV". It has no copy of the show's cast
 * and sees whatever the scrape kept, including site navigation chrome ahead of
 * the review. On 2026-10-21 seven real Talkin' Broadway reviews sat excluded
 * on such verdicts: Dog Day Afternoon (15 of 15 listed cast named in the text),
 * The Dinosaurs (April Matthis, Kathleen Chalfant, ...: 5 of 6) and Marcel on
 * the Train (5 of 6) among them.
 *
 * A review that names most of THIS show's listed cast is about this show's
 * production. Cast overlap is the discriminator; the title alone is not (a
 * 2021 "Caroline, or Change" review names "Caroline" 25 times and is a
 * different production). So the evidence is cast names only, and "strong"
 * needs more than one coincidence: at least 3 distinct cast members, or at
 * least 2 when they are half or more of the listed cast.
 *
 * Callers use `strong` to make a CV promotion to wrongProduction / wrongShow
 * advisory. It never clears an existing flag and never overrides the date and
 * cross-market guards, which answer a different question (right text, wrong
 * run window). Pure, no I/O (CLAUDE.md §15).
 */

'use strict';

const { foldDiacritics } = require('./title-match');

const MIN_HITS = 3;
const MIN_HITS_HALF_CAST = 2;

function norm(s) {
  return foldDiacritics(String(s || '').toLowerCase())
    .replace(/[’‘ʼ']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function castNames(show) {
  const raw = Array.isArray(show && show.cast) ? show.cast : [];
  const names = raw.map((c) => (c && typeof c === 'object' ? c.name : c)).filter((n) => typeof n === 'string');
  // Single-word stage names would match ordinary words; require a first and last name.
  return [...new Set(names.map(norm).filter((n) => n.split(' ').length >= 2))];
}

/**
 * @param {string} text   stored review body
 * @param {object} show   shows.json entry (reads `cast`)
 * @returns {{castListed:number, castHits:string[], strong:boolean}}
 */
function ownShowTextEvidence(text, show) {
  const names = castNames(show);
  const body = ` ${norm(text)} `;
  const hits = body.trim() ? names.filter((n) => body.includes(` ${n} `)) : [];
  const strong = hits.length >= MIN_HITS
    || (hits.length >= MIN_HITS_HALF_CAST && hits.length * 2 >= names.length);
  return { castListed: names.length, castHits: hits, strong };
}

module.exports = { ownShowTextEvidence, MIN_HITS, MIN_HITS_HALF_CAST };
