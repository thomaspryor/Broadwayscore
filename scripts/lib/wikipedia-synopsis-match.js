/**
 * Testable core logic for enrich-wikipedia-synopsis.js: title-variant
 * generation, wikitext plot extraction/trimming, and page validation.
 *
 * Network I/O (fetch, batching, retry/backoff) stays in the calling script —
 * this file only operates on show records and wikitext strings, so it's
 * unit-testable without hitting the live Wikipedia API.
 */

const { stripWikiMarkup, hasWikiMarkup } = require('./wiki-utils');
const { cleanSearchTitle, titlesMatch } = require('./title-normalization');

/**
 * Build an ordered list of Wikipedia page-title guesses for a show.
 * First hit wins — direct-title lookups try these before falling back to
 * full-text search.
 */
function buildSearchTitles(show) {
  const title = cleanSearchTitle(show.title);

  const type = show.type || show.format;
  const variants = [];

  // Extract year from show ID for year-disambiguated articles (e.g., "Passion (1994 musical)")
  const yearMatch = show.id && show.id.match(/-(\d{4})(?:-|$)/);
  const year = yearMatch ? yearMatch[1] : null;

  if (type === 'musical') {
    variants.push(`${title} (musical)`, title);
    if (year) variants.push(`${title} (${year} musical)`);
  } else if (type === 'play') {
    variants.push(`${title} (play)`, title);
    if (year) variants.push(`${title} (${year} play)`);
  } else {
    variants.push(title, `${title} (musical)`, `${title} (play)`);
  }

  // For shows with "The" prefix, also try without it
  if (title.startsWith('The ') && title.length > 6) {
    const noThe = title.substring(4);
    if (type === 'musical') {
      variants.push(`${noThe} (musical)`);
    } else if (type === 'play') {
      variants.push(`${noThe} (play)`);
    }
  }

  // Dedup while preserving priority order.
  return [...new Set(variants)];
}

/** True if the wikitext is a disambiguation page, not an article. */
function isDisambiguationPage(content) {
  return /\{\{disambiguation\}\}/i.test(content) || /may refer to:/i.test(content.substring(0, 2000));
}

/**
 * True if the page reads as a theatrical-production article (not a
 * film/TV-only page for a same-titled adaptation).
 */
function isTheatricalPage(content) {
  const hasTheatreInfobox = /\{\{Infobox (musical|play)/i.test(content);
  const hasFilmInfobox = /\{\{Infobox (film|television)/i.test(content);
  const hasTheatreContext = /\b(broadway|west end|off-broadway|theatre|theater|musical|playwright|librett)/i.test(content.substring(0, 2000));
  if (hasFilmInfobox && !hasTheatreInfobox && !hasTheatreContext) return false;
  if (!hasTheatreInfobox && !hasFilmInfobox && !hasTheatreContext) return false;
  return true;
}

/**
 * Extract the Plot or Synopsis section from Wikipedia wikitext.
 * Returns cleaned plain text, or null if not found.
 */
function extractPlotSection(content) {
  const sectionHeaders = [
    /==\s*Plot\s*==/i,
    /==\s*Synopsis\s*==/i,
    /==\s*Plot summary\s*==/i,
    /==\s*Story\s*==/i,
  ];

  for (const headerRegex of sectionHeaders) {
    const headerMatch = content.match(headerRegex);
    if (!headerMatch) continue;

    const startIdx = headerMatch.index + headerMatch[0].length;
    const rest = content.substring(startIdx);
    const nextSection = rest.match(/\n==\s*[^=]/);
    const sectionText = nextSection ? rest.substring(0, nextSection.index) : rest.substring(0, 3000);

    let cleaned = stripWikiMarkup(sectionText);

    if (cleaned.length < 20) continue;
    if (hasWikiMarkup(cleaned)) continue;
    if (/^Act [12I]/i.test(cleaned) || /^[""]/.test(cleaned)) continue;

    return cleaned;
  }

  // Fallback: try the lead section (before any == header ==)
  const leadEnd = content.match(/\n==/);
  if (leadEnd) {
    const lead = content.substring(0, leadEnd.index);
    const afterInfobox = lead.replace(/\{\{Infobox[\s\S]*?\n\}\}/gi, '').trim();
    let cleaned = stripWikiMarkup(afterInfobox);

    if (cleaned.length >= 50 && !hasWikiMarkup(cleaned)) return cleaned;
  }

  return null;
}

/**
 * Trim text to a clean synopsis: first 1-2 sentences, max 500 chars.
 */
function trimToSynopsis(text) {
  const sentences = text.match(/[^.!?]+[.!?]+/g);
  if (!sentences) return text.substring(0, 500);

  let synopsis = '';
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (trimmed.length < 10) continue;
    if (/^(The musical|The play|The show|It) (was|is) (based on|adapted|written|composed|directed|produced|set)/i.test(trimmed) && synopsis.length === 0) {
      synopsis += trimmed + ' ';
    } else if (synopsis.length === 0 || (synopsis.length + trimmed.length) <= 450) {
      synopsis += trimmed + ' ';
    }
    if (synopsis.length >= 300) break;
  }

  synopsis = synopsis.trim();
  if (synopsis.length > 500) {
    synopsis = synopsis.substring(0, 497) + '...';
  }
  return synopsis;
}

/** True if the extracted synopsis text is obviously the wrong kind of content. */
function hasBadSynopsisContent(synopsis) {
  return /may refer to:/i.test(synopsis) ||
    /^.{0,20}is a \d{4} American .* film/i.test(synopsis) ||
    /\| website = |\| past_members/.test(synopsis);
}

/**
 * Resolve a guessed title to page wikitext content, given the pages/redirects
 * returned by a batched MediaWiki `action=query&titles=A|B|C&redirects=1`
 * request. Pure — no network — so the batching+redirect-following behavior
 * (task #68 fix) is unit-testable without a live API call.
 *
 * @param {Map<string, object>} pagesByTitle - page.title -> MediaWiki page object (formatversion=2)
 * @param {Map<string, string>} redirects - redirect.from -> redirect.to
 * @param {string} variant - the guessed title to resolve
 * @returns {string|null} wikitext content, or null if missing/not found
 */
function resolveVariantContent(pagesByTitle, redirects, variant) {
  let canonical = variant;
  const seen = new Set();
  while (redirects.has(canonical) && !seen.has(canonical)) {
    seen.add(canonical);
    canonical = redirects.get(canonical);
  }
  const page = pagesByTitle.get(canonical);
  if (!page || page.missing) return null;
  return (page.revisions && page.revisions[0] && page.revisions[0].slots && page.revisions[0].slots.main && page.revisions[0].slots.main.content) || null;
}

/**
 * Pick the best full-text-search candidate title for a show, using the same
 * fuzzy title comparison used across the scraper stack. Returns null if no
 * candidate plausibly names the same production.
 */
function pickSearchCandidate(show, candidateTitles) {
  const cleanTitle = cleanSearchTitle(show.title);
  for (const cand of candidateTitles || []) {
    const stripped = cand.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (titlesMatch(cleanTitle, stripped) || titlesMatch(show.title, stripped)) return cand;
  }
  return null;
}

module.exports = {
  buildSearchTitles,
  isDisambiguationPage,
  isTheatricalPage,
  extractPlotSection,
  trimToSynopsis,
  hasBadSynopsisContent,
  resolveVariantContent,
  pickSearchCandidate,
};
