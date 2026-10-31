'use strict';
/**
 * BRO-2746: a review file whose URL slug names a DIFFERENT show than the
 * directory it sits in (e.g. a-month-in-the-country-west-end-2026/ holding
 * thestage.co.uk/reviews/care-review-young-vic-...). Pure function (rule 15).
 *
 * Fires only when an OTHER show's title slug (>= 2 words, >= 12 chars) appears as a whole
 * hyphen-delimited run in the URL path AND this show's own title slug does
 * not. One-word titles are skipped: they rubber-stamp on common words
 * (memory/feedback_validateshownmentioned_generic_idwords.md).
 */
function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// "4.48 Psychosis" is written "448-psychosis" in outlet URLs: also try the title with
// dots between digits removed so the own-title check recognizes it.
function slugVariants(title) {
  const a = slugify(title);
  const b = slugify(String(title || '').replace(/(\d)\.(?=\d)/g, '$1'));
  return b && b !== a ? [a, b] : [a];
}

function pathSlug(url) {
  try { return `-${slugify(decodeURIComponent(new URL(url).pathname))}-`; } catch { return ''; }
}

const hasRun = (hay, slug) => !!slug && hay.includes(`-${slug}-`);

/**
 * @param {string} url
 * @param {{id:string,title:string}} own show the file is filed under
 * @param {Array<{id:string,title:string}>} candidates other shows to test (siblings / combinedWith members)
 * @returns {{showId:string,title:string}|null} the other show the URL names, else null
 */
function urlNamesOtherShow(url, own, candidates) {
  const hay = pathSlug(url);
  if (!hay) return null;
  if (slugVariants(own.title).some(v => hasRun(hay, v))) return null;
  for (const c of candidates) {
    if (!c || c.id === own.id) continue;
    const slug = slugify(c.title);
    if (slug.split('-').length < 2 || slug.length < 12) continue;
    const ownSlug = slugify(own.title);
    if (ownSlug.includes(slug) || slug.includes(ownSlug)) continue; // revival / "The Musical" variants
    if (hasRun(hay, slug)) return { showId: c.id, title: c.title };
  }
  return null;
}

module.exports = { urlNamesOtherShow, slugify };
