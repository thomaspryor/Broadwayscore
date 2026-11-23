/**
 * Turn --shows tokens (show ids, page slugs or old aliases) into the slugs /show/<slug> pages use.
 *
 * BRO-8085: submit-indexnow.js and submit-google-indexing.js built /show/<token> straight
 * from the token. Their docs and the workflow input ask for show IDs, and for many shows the
 * id is not the slug (hamilton-west-end-2021 vs hamilton-west-end), so a re-crawl request
 * named a URL that only 301-redirects. Precedence matches the site's own lookup
 * (src/lib/data-core.ts getShowBySlug + findShowByIdOrAlias): slug, then id, then aliases[].
 * A row the site does not publish (_devOnly, or a category that is not launched) and a token
 * that matches nothing are reported and left out, never submitted as a dead URL.
 */

const { isCategoryEnabled } = require('./markets');

const published = row => !row._devOnly && isCategoryEnabled(row.category);

function resolveShowSlugs(tokens, shows, isPublished = published) {
  const rows = (shows || []).filter(s => s && s.slug);
  const slugs = [];
  const unknown = [];
  const unpublished = [];
  for (const raw of tokens || []) {
    const t = String(raw || '').trim();
    if (!t) continue;
    const row = rows.find(r => r.slug === t)
      || rows.find(r => r.id === t)
      || rows.find(r => Array.isArray(r.aliases) && r.aliases.includes(t));
    if (!row) unknown.push(t);
    else if (!isPublished(row)) unpublished.push(t);
    else if (!slugs.includes(row.slug)) slugs.push(row.slug);
  }
  return { slugs, unknown, unpublished };
}

/** Read data/shows.json (array or {shows}). Throws with the real cause; never guesses. */
function loadShowsForSlugs(fs, path, dir) {
  const file = path.join(dir, '../data/shows.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`--shows needs ${file} to turn show ids into page slugs, and it could not be read (${e.code || e.message}). Pass exact paths with --urls instead.`);
  }
  const shows = Array.isArray(raw) ? raw : raw && raw.shows;
  if (!Array.isArray(shows)) throw new Error(`${file} has no shows array`);
  return shows;
}

/**
 * The CLI step both scripts share: resolve tokens, warn about each one left out, and throw
 * when nothing usable is left, so a dispatch with only bad ids fails instead of going green.
 */
function slugsForCli(tokens, shows, log = console) {
  const { slugs, unknown, unpublished } = resolveShowSlugs(tokens, shows);
  for (const t of unknown) log.warn(`--shows: "${t}" is not a show id, page slug or alias in shows.json; skipped`);
  for (const t of unpublished) log.warn(`--shows: "${t}" is not published on the site (dev-only or unlaunched category); skipped`);
  if (!slugs.length) throw new Error(`--shows: none of the ${tokens.length} token(s) names a published show page`);
  return slugs;
}

/**
 * Google Indexing --shows URL list. URL_UPDATED resolves tokens to live page
 * slugs and adds the homepage and /rankings. URL_DELETED keeps each token as
 * given (the show is gone, so it cannot resolve) and never loads shows.json.
 */
function googleShowUrls(tokens, type, loadShows, host = 'https://broadwayscorecard.com') {
  if (type === 'URL_DELETED') return (tokens || []).map(s => String(s || '').trim()).filter(Boolean).map(s => `${host}/show/${s}`);
  const urls = slugsForCli(tokens, loadShows()).map(s => `${host}/show/${s}`);
  return [...urls, `${host}/`, `${host}/rankings`];
}

module.exports = { resolveShowSlugs, loadShowsForSlugs, slugsForCli, googleShowUrls };
