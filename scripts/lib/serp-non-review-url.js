'use strict';
/**
 * BRO-6606: URLs a SERP candidate can have that are never a review of a stage production.
 * The UK regional SERP pass ingested a Letterboxd film comment, a book shop product page,
 * a film-site tour announcement and two pre-opening announcements as reviews. Letterboxd
 * had already been cleaned out once before (_superseded-misattributed).
 */

const NON_REVIEW_HOSTS = /(^|\.)(letterboxd\.com|goodreads\.com|imdb\.com|rottentomatoes\.com|amazon\.[a-z.]+|bookshop\.org|waterstones\.com|wordery\.com|audible\.[a-z.]+|discogs\.com|allmusic\.com|pitchfork\.com|loudersound\.com|rateyourmusic\.com|albumoftheyear\.org|musicbrainz\.org)$|(^|\.)[a-z0-9-]*bookshop[a-z0-9-]*\./i;
// Announcement slugs ("full-details-announced-for ...", "casting announced") carry no review word.
// Whole slug tokens only: a bare "casting" appears in real review slugs ("casting-ideal-material..."), and
// "broadcasting" / "to-tourism" must not match.
const ANNOUNCEMENT = /(^|[/-])(announces?|announced|cast-revealed|tickets-on-sale|on-sale-now|full-details|returns-as|to-tour|uk-tour)($|[/-])/i;

function isNonReviewUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (NON_REVIEW_HOSTS.test(`${host}/`) || NON_REVIEW_HOSTS.test(host)) return true;
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep the raw path on a bad % escape */ }
  path = path.toLowerCase();
  if (/review|verdict|stars?\b/.test(path)) return false;
  return ANNOUNCEMENT.test(path);
}

// BRO-7569: pages on an outlet's own site that are not a review of the production even
// though the aggregator attached them to the review row. The gap engine accepted the
// Times interview "charlotte-ritchie-interview-cloud-9" as Susannah Butter's Cloud 9
// review (7,700 chars, stub -> complete). Same rule as above: a path that says
// review/verdict/stars is never ruled out. Sections are whole path segments.
const NON_REVIEW_SECTIONS = new Set([
  'opinion', 'long-reads', 'promoted-content', 'recipes', 'shop', 'money', 'video', 'videos',
  'obituaries', 'obituary', 'puzzles', 'games', 'cooking', 'tax', 'luxury',
]);
const NON_REVIEW_SLUG = /(?:^|[/-])(?<!the-)(?:interviews?|obituary|podcast|gift-guide)(?:$|[/-])(?!\w*broadway|hampstead)/i;

function isNonReviewSectionUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  path = path.toLowerCase();
  if (/review|verdict|stars?\b/.test(path)) return false;
  if (NON_REVIEW_SLUG.test(path)) return true;
  // 'news' is a review section on some outlets; only treat it as non-review on The Stage, where reviews live in /reviews/.
  if (/(^|\.)thestage\.co\.uk$/.test(u.hostname) && /^\/(news|opinion|features|careers|long-reads|promoted-content|jobs)\b/.test(path)) return true;
  const segs = path.split('/').filter(Boolean);
  return segs.slice(0, -1).some((x) => NON_REVIEW_SECTIONS.has(x));
}

module.exports = { isNonReviewUrl, isNonReviewSectionUrl };
