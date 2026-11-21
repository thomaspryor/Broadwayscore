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

// BRO-7068: the contamination audit calls urlNamesOtherShow once per review file
// (~60k) with every show (~5k) as a candidate. Slugifying each candidate title on
// every call cost ~100s of CPU per audit run and pushed the live-data lane's
// contamination tests past their 300s timeout. A candidate's slug depends only on
// its title, so each candidate list is prepared once (keyed by array identity;
// callers pass a list they do not mutate afterwards) and reused.
const PREPARED = new WeakMap();
function prepareCandidates(candidates) {
  let prepared = PREPARED.get(candidates);
  if (!prepared) {
    prepared = [];
    for (const c of candidates) {
      if (!c) continue;
      const slug = slugify(c.title);
      if (slug.length < 12 || !slug.includes('-')) continue; // >= 2 words, >= 12 chars
      prepared.push({ id: c.id, title: c.title, slug, run: `-${slug}-` });
    }
    PREPARED.set(candidates, prepared);
  }
  return prepared;
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
  const ownSlug = slugify(own.title);
  // Non-array iterables are prepared per call (no identity to cache on).
  const prepared = prepareCandidates(Array.isArray(candidates) ? candidates : Array.from(candidates || []));
  for (const c of prepared) {
    if (c.id === own.id) continue;
    if (!hay.includes(c.run)) continue;
    if (ownSlug.includes(c.slug) || c.slug.includes(ownSlug)) continue; // revival / "The Musical" variants
    return { showId: c.id, title: c.title };
  }
  return null;
}

module.exports = { urlNamesOtherShow, slugify };
