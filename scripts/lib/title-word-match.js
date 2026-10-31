'use strict';

/**
 * Show-title words for matching against RAW text (headlines, SERP result
 * titles, URL slugs, review prose) — BRO-3399.
 *
 * The old pattern `.replace(/[^a-z0-9\s]/g, '')` glued "Pre-Existing" into
 * "preexisting", which never matches text that keeps its hyphen. Splitting on
 * the hyphen instead is worse: "Spider-Man" becomes 'man', a substring of
 * "Woman in Mind". So a hyphenated word stays ONE word whose joins are an
 * optional separator: spider[\s-]?man matches "Spider-Man", "spider man",
 * "spiderman" and "spider-man-turn-off" slugs, never "woman". Titles without
 * hyphens or slashes produce exactly the old words.
 */

const { foldDiacritics } = require('./title-match');

// ASCII hyphen, Unicode hyphens/dashes, and slash all mark an in-word join.
const JOIN_RE = /[-‐-―/]+/g;

function _glued(w) {
  return w.replace(/-/g, '');
}

/**
 * @param {string} title  already lowercased/diacritic-folded or not
 * @param {{minLength?: number, stopwords?: string[]}} [opts]
 *   keep words whose glued length is > minLength (default 2) and whose glued
 *   form is not a stopword (default the/and/for)
 * @returns {string[]} words; an in-word join is kept as '-'
 */
function titleMatchWords(title, opts = {}) {
  const minLength = opts.minLength === undefined ? 2 : opts.minLength;
  const stop = opts.stopwords || ['the', 'and', 'for'];
  // Folded on both sides (textHasWord too): "Les Misérables" matches
  // "Les Miserables" and vice versa (sibling-matchers-diacritics guard).
  return foldDiacritics(String(title || '')).toLowerCase()
    .replace(JOIN_RE, '-')
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .map(w => w.replace(/^-+|-+$/g, ''))
    .filter(w => w && _glued(w).length > minLength && !stop.includes(_glued(w)));
}

/** Regex source for one word: joins become an optional space/hyphen/slash. */
function wordPattern(word) {
  return String(word).split('-')
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\-\\u2010-\\u2015/_]?');
}

/** Substring match (the old `.includes(w)` semantics), join-aware. */
function textHasWord(text, word) {
  return new RegExp(wordPattern(word), 'i').test(foldDiacritics(String(text || '')));
}

module.exports = { titleMatchWords, wordPattern, textHasWord };
