'use strict';

/**
 * Generic single-word title guard (BRO-2760).
 *
 * A show titled "The Story" has one significant word. Every discovery path
 * (site-search, RSS, section scrapers) matched that lone word anywhere in a
 * URL/headline, so "Toy Story 5", "222 A Ghost Story" and "Monsters: the Lyle
 * and Erik Menendez Story" all landed in _pending/ (22 of 25 files for
 * the-story-west-end-2026). For these titles a lone word is not identity:
 * require the article + word phrase ("the story"), or a slug/headline that
 * STARTS with the word or has it right after "review" ("story-what-a-newsroom-does...", headline "Story: ...").
 *
 * Deliberately narrow so opening-night real reviews are not dropped: it only
 * fires for article + exactly one word + that word in GENERIC_SINGLE_TITLE_WORDS.
 * "The Heiress", "Wicked", "Hamilton" are untouched.
 */

const { foldDiacritics } = require('./title-match');

const ARTICLES = new Set(['the', 'a', 'an']);

// Only words with PROVEN discovery noise (BRO-2760: "story" = 22/25 junk files).
// Second-opinion replay showed adding visit/truth/life/etc. dropped real reviews
// (the-visit-2015 THR/StuOnBroadway). Add a word only with corpus evidence.
const GENERIC_SINGLE_TITLE_WORDS = new Set(['story', 'stories', 'tale', 'tales']);

const norm = s => foldDiacritics(String(s || '')).toLowerCase()
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * @param {string} title - shows.json title
 * @returns {string|null} the lone generic word ("story") or null if the title is not a generic one-word title
 */
function genericSingleWordTitle(title) {
  const words = norm(title).split(' ').filter(Boolean);
  if (words.length !== 2 || !ARTICLES.has(words[0])) return null;
  return GENERIC_SINGLE_TITLE_WORDS.has(words[1]) ? words[1] : null;
}

/**
 * For a generic one-word title, does `text` (URL or headline) carry real
 * identity? Non-generic titles always return true (caller keeps its own logic).
 * @param {string} text - URL or headline
 * @param {string} title - shows.json title
 */
function passesGenericTitleIdentity(text, title) {
  const word = genericSingleWordTitle(title);
  if (!word) return true;
  const phrase = norm(title);
  const raw = String(text || '');
  const candidates = [norm(raw)];
  if (/^https?:\/\//i.test(raw)) {
    try {
      const seg = new URL(raw).pathname.split('/').filter(Boolean).pop() || '';
      candidates.push(norm(seg.replace(/\.[a-z0-9]+$/i, '')));
    } catch { /* not a URL */ }
  }
  // "review-story-hampstead-theatre": outlets often drop the article right after "review".
  const afterReview = new RegExp('(?:^| )reviews? (?:of )?' + word + '(?: |$)');
  // "national-theatre-story-review": the word directly after a venue token.
  const afterVenue = new RegExp('(?:^| )(?:theatre|theater|olivier|dorfman|lyttelton) ' + word + '(?: |$)');
  return candidates.some(c => (' ' + c + ' ').includes(' ' + phrase + ' ') || c.startsWith(word + ' ') || afterReview.test(c) || afterVenue.test(c));
}

module.exports = { genericSingleWordTitle, passesGenericTitleIdentity, GENERIC_SINGLE_TITLE_WORDS };
