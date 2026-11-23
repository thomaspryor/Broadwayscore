/**
 * Turn --shows tokens (show ids OR page slugs) into the slugs that /show/<slug> pages use.
 *
 * BRO-8085: submit-indexnow.js and submit-google-indexing.js built /show/<token> straight
 * from the token. Their docs and the workflow input ask for show IDs, and for many shows the
 * id is not the slug (hamilton-west-end-2021 vs hamilton-west-end), so a re-crawl request
 * named a URL that only 301-redirects. A slug match wins over an id match; a token that is
 * neither is reported and left out instead of being submitted as a dead URL.
 */

function resolveShowSlugs(tokens, shows) {
  const bySlug = new Set();
  const idToSlug = new Map();
  for (const s of shows || []) {
    if (s && s.slug) bySlug.add(s.slug);
    if (s && s.id && s.slug) idToSlug.set(s.id, s.slug);
  }
  const slugs = [];
  const unknown = [];
  for (const raw of tokens || []) {
    const t = String(raw || '').trim();
    if (!t) continue;
    const slug = bySlug.has(t) ? t : idToSlug.get(t);
    if (!slug) unknown.push(t);
    else if (!slugs.includes(slug)) slugs.push(slug);
  }
  return { slugs, unknown };
}

/** Load shows.json (array or {shows}) from data/; null when it is missing or unreadable. */
function loadShowsForSlugs(fs, path, dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, '../data/shows.json'), 'utf8'));
    return Array.isArray(raw) ? raw : raw.shows || null;
  } catch {
    return null;
  }
}

/**
 * The CLI step both scripts share: resolve tokens, print what was mapped or dropped.
 * Without shows.json the tokens are used as given (old behaviour), with a warning.
 */
function slugsForCli(tokens, shows, log = console) {
  if (!shows) {
    log.warn('shows.json not found: submitting --shows tokens as page slugs unchanged');
    return tokens.map(t => String(t).trim()).filter(Boolean);
  }
  const { slugs, unknown } = resolveShowSlugs(tokens, shows);
  for (const t of unknown) log.warn(`--shows: "${t}" is neither a show id nor a page slug in shows.json; skipped`);
  return slugs;
}

module.exports = { resolveShowSlugs, loadShowsForSlugs, slugsForCli };
