'use strict';
/**
 * BRO-6606: URLs a SERP candidate can have that are never a review of a stage production.
 * The UK regional SERP pass ingested a Letterboxd film comment, a book shop product page,
 * a film-site tour announcement and two pre-opening announcements as reviews. Letterboxd
 * had already been cleaned out once before (_superseded-misattributed).
 */

const NON_REVIEW_HOSTS = /(^|\.)(letterboxd\.com|goodreads\.com|imdb\.com|rottentomatoes\.com|amazon\.[a-z.]+|bookshop\.org|waterstones\.com|wordery\.com|audible\.[a-z.]+)$|(^|\.)[a-z0-9-]*bookshop[a-z0-9-]*\./i;
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

module.exports = { isNonReviewUrl };
