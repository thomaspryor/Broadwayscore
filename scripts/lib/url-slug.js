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

/**
 * The rule src/lib/data-core.ts slugify() applied BEFORE S7-T3: no fold, so
 * every accented letter fell to the non-alphanumeric rule and became a
 * hyphen ("José Solís" → `jose-sol-s`, "Noël Coward" → `no-l-coward`).
 *
 * NOT a URL rule any more — it exists only so scripts/build-slug-redirects.js
 * can compute, from the live data, what a person/place page's URL used to be
 * and 301 it to slugify()'s (S7-T3 follow-up: the fold moved every accented
 * creative, theatre and cast URL with no redirect). Never derive a link from it.
 * @param {string} name
 * @returns {string}
 */
function legacySlugify(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

/**
 * The ONE slug-collision rule for a page family whose slugs come from
 * slugify(name): in page order, a slug already taken gets "-2", then "-3", …
 * (src/lib/data-creative.ts unified profiles, src/lib/data-actors.ts).
 * Order matters — the first name to reach a slug keeps it ("Noel Coward" →
 * `noel-coward`, then "Noël Coward" → `noel-coward-2`) — so callers pass the
 * names in the order the page builder meets them, and the redirect emitter
 * derives the retired URLs by running the same function over the same names
 * with legacySlugify.
 * @param {string[]} names page names in first-encounter order
 * @param {(name: string) => string} [slugifyFn] defaults to slugify
 * @returns {string[]} one slug per name, index-aligned, all distinct
 */
function assignUniqueSlugs(names, slugifyFn = slugify) {
  const taken = new Set();
  return names.map((name) => {
    let slug = slugifyFn(name);
    if (taken.has(slug)) {
      let counter = 2;
      while (taken.has(`${slug}-${counter}`)) counter++;
      slug = `${slug}-${counter}`;
    }
    taken.add(slug);
    return slug;
  });
}

module.exports = { foldDiacritics, slugify, legacySlugify, assignUniqueSlugs };
