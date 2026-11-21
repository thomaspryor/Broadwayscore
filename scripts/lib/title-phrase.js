'use strict';

/**
 * title-phrase.js (BRO-6716): does a text name a show by its FULL title?
 *
 * buildShowKeywordSet/findShowKeywordInText accept one distinctive word, so
 * "music" matches Music City in a news story about another musical. Code that
 * clears a verdict or swaps a stored body on the strength of "the text names
 * the show" needs the whole title as a phrase.
 *
 * Pure: no I/O.
 */

/** Lowercased, accent- and punctuation-free, space-padded: " here there are blueberries ". */
function normTitlePhrase(s) {
  return ` ${String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/**
 * True when `text` (or its first `within` chars) contains the full title.
 * Titles under `minLength` normalized chars never match.
 * @param {string} text
 * @param {string} title
 * @param {{within?: number, minLength?: number}} [opts]
 */
function containsTitlePhrase(text, title, { within = Infinity, minLength = 4 } = {}) {
  const t = normTitlePhrase(title).trim();
  if (t.length < minLength) return false;
  const body = typeof text === 'string' ? (Number.isFinite(within) ? text.slice(0, within) : text) : '';
  return normTitlePhrase(body).includes(` ${t} `);
}

module.exports = { normTitlePhrase, containsTitlePhrase };
