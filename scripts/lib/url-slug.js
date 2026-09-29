'use strict';

/**
 * url-slug.js — the ONE URL-slug rule for people and places on the site
 * (2026 data audit, S7-T3).
 *
 * src/lib/data-core.ts slugify() re-exports slugify() from here, so every
 * /critics/<slug>, /critics/outlets/<slug>, /theater/<slug>, /director/<slug>,
 * /actor/<slug> and creative-team URL derives from this file, and the JS
 * side (scripts/newsletter/generate.mjs deep links, scripts/lib/deduplication.js
 * show slugs' diacritic step) folds through the same function. Before this
 * file the TS slugify had no diacritic step, so "José Solís" became
 * `jose-sol-s` and "Nilgün Yusuf" `nilg-n-yusuf` — one critic, two pages
 * whenever a byline was captured with and without its accents. The retired
 * slugs 301 to the folded ones via data/critic-slug-aliases.json (S5-T9).
 *
 * Folding rule: NFKD, then strip the combining marks (U+0300–U+036F). That
 * maps every precomposed Latin letter with an accent, plus compatibility
 * forms (ligatures, full-width letters), to ASCII. Letters that do NOT
 * decompose (ø, ł, ß, æ, đ) pass through unchanged and fall to the
 * non-alphanumeric rule below, exactly as before — no name in the corpus
 * uses one, and transliterating them would be a spelling decision, not a
 * fold (same stance as scripts/lib/title-match.js, which now delegates its
 * foldDiacritics to this one).
 */

/**
 * Strip diacritics: "José Solís" → "Jose Solis", "Nilgün" → "Nilgun".
 * @param {*} s
 * @returns {string}
 */
function foldDiacritics(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

/**
 * URL slug for a person or place name: fold diacritics, lowercase, every run
 * of non-alphanumerics becomes one hyphen, no leading/trailing hyphen.
 * "Juan A. Ramírez" → "juan-a-ramirez"; "O’Mahony" and "O'Mahony" → "o-mahony".
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return foldDiacritics(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

module.exports = { foldDiacritics, slugify };
