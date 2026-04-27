/**
 * DTLI homepage scan — find a show's didtheylikeit.com URL among recent-shows
 * homepage anchors.
 *
 * DTLI's homepage features the ~10 most recent productions and updates the
 * moment a new review page is published. Direct homepage scrape beats both
 * URL pattern guessing (24+ HTTP fetches × 5s = 2+ min waste pre-publication)
 * and the existing live-sitemap discovery (which can lag — sitemap1.xml has
 * 2014 lastmod entries). Lost Boys 2026-04-26 readiness audit.
 *
 * Pattern mirrors scripts/lib/bww-homepage-scan.js. Used by gather-reviews.js
 * ::searchDTLI as an early-priority probe BEFORE URL guessing.
 *
 * Handles DTLI's two slug formats:
 *   /shows/{slug}/                      ← canonical (the one we want)
 *   /shows/{ttid}-{slug}-on-broadway    ← TodayTix-id alias (skip)
 *
 * Handles DTLI revival-number suffixes ('giant-2', 'death-of-a-salesman-3',
 * 'every-brilliant-thing-2') by tolerating one trailing single-digit token
 * after the title-token match.
 */

const NOOP_LOGGER = { log: () => {} };

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'is']);
const CATEGORY_SUFFIXES = new Set(['bway', 'broadway', 'off-broadway', 'west-end', 'london', 'revival']);

// Strip subtitle from a title. "Beaches: A New Musical" → "Beaches".
// Mirrors scripts/lib/bww-rr-discover.js::stripSubtitle — DTLI authors slugs
// without subtitles after `:`, `,`, or em/en-dashes.
function stripSubtitle(title) {
  if (!title) return '';
  const stripped = title.split(/[:,—–]/)[0].trim();
  return stripped || title;
}

function tokensFromTitle(title) {
  return (title || '')
    .toLowerCase()
    // Drop apostrophes BEFORE space-substitution so "Turner's" → "turners",
    // not "turner s" (the trailing 's' would never match the slug's "turners").
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t));
}

/**
 * Yield each title variant we should try to match: full title, then subtitle-stripped.
 * Same pattern BWW uses — handles "Beaches: A New Musical" → DTLI slug "beaches".
 */
function candidateTitleForms(show) {
  const out = [];
  if (show.shortTitle) out.push(show.shortTitle);
  const stripped = stripSubtitle(show.title);
  if (stripped && stripped !== show.title) out.push(stripped);
  if (show.title) out.push(show.title);
  return [...new Set(out)];
}

function slugTokens(slug) {
  return (slug || '').toLowerCase().split('-').filter(Boolean);
}

/**
 * Extract every /shows/{slug}/ anchor that uses the CANONICAL bare-slug format
 * (skips TodayTix-id-prefixed `{ttid}-{slug}-on-broadway` aliases).
 */
function extractShowAnchors(html) {
  if (!html || typeof html !== 'string') return [];
  const found = new Set();
  // Match both absolute (https://didtheylikeit.com/shows/{slug}/) and relative
  // (/shows/{slug}/) hrefs. DTLI's homepage uses absolute URLs as of 2026-04-26.
  const patterns = [
    /(?:href|data-href)=["']https?:\/\/(?:www\.)?didtheylikeit\.com\/shows\/([a-z][a-z0-9-]*)\/?["']/gi,
    /(?:href|data-href)=["']\/shows\/([a-z][a-z0-9-]*)\/?["']/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const slug = m[1];
      // Skip TodayTix-id-prefixed aliases (start with digits) — DTLI's "real" review
      // page is at the bare-slug version, the digit-prefix is a redirect/alias.
      if (/^\d/.test(slug)) continue;
      found.add(slug);
    }
  }
  return [...found];
}

/**
 * Score a candidate slug against a show. Higher is better.
 *   +10 if every non-stopword title token appears in the slug
 *   +1 per matched extra token (helps prefer "giant-2" over "giant" when show is revival)
 *   -3 per slug-only token that isn't an allowed suffix or single digit
 *   0 if any title token is missing → reject (return -Infinity)
 *
 * "Allowed extras" = single digits (revival counts) or category suffixes
 * (bway/broadway/west-end/london/revival/off-broadway).
 */
function scoreSlugAgainstShow(slug, show) {
  const sTokens = slugTokens(slug);
  if (sTokens.length === 0) return -Infinity;

  // Try each title form (full, subtitle-stripped, shortTitle); take the best score.
  let best = -Infinity;
  for (const form of candidateTitleForms(show)) {
    const titleTokens = tokensFromTitle(form);
    if (titleTokens.length === 0) continue;

    // Every title token must appear in the slug.
    let allMatch = true;
    for (const t of titleTokens) {
      if (!sTokens.includes(t)) { allMatch = false; break; }
    }
    if (!allMatch) continue;

    // Penalize unexpected slug tokens beyond the title (excluding allowed extras).
    let extraPenalty = 0;
    let extraBonus = 0;
    for (const s of sTokens) {
      if (titleTokens.includes(s)) continue;
      if (/^\d+$/.test(s) && s.length <= 2) {
        extraBonus += 1; // revival number suffix is a strong positive signal
        continue;
      }
      if (CATEGORY_SUFFIXES.has(s)) {
        extraBonus += 1;
        continue;
      }
      // Multi-word category tags like 'off-broadway' get split into 'off' + 'broadway'
      // by slug-split; allow single-token pieces of those.
      if (s === 'off' || s === 'west' || s === 'end') continue;
      extraPenalty += 3;
    }

    const score = 10 + extraBonus - extraPenalty;
    if (score > best) best = score;
  }
  return best;
}

/**
 * Find the DTLI /shows/{slug}/ URL on `html` whose slug matches `show`.
 * Returns the full URL string (with trailing slash) or null.
 *
 * Picks the highest-scoring candidate. Prefers revivals' numbered slug
 * ('giant-2') over the bare title ('giant') when the show is a revival.
 *
 * @param {string} html - DTLI homepage HTML
 * @param {object} show - { title, openingDate, isRevival, id }
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @returns {string|null}
 */
function findDTLIShowLinkOnHomepage(html, show, { logger = NOOP_LOGGER } = {}) {
  const slugs = extractShowAnchors(html);
  if (slugs.length === 0) return null;
  if (!show || !show.title) return null;

  const ranked = slugs
    .map(slug => ({ slug, score: scoreSlugAgainstShow(slug, show) }))
    .filter(c => c.score > -Infinity)
    .sort((a, b) => b.score - a.score);

  if (ranked.length === 0) {
    const sample = slugs.slice(0, 5);
    logger.log(`    DTLI homepage had ${slugs.length} show anchor(s) but none matched "${show.title}". Sample: ${JSON.stringify(sample)}`);
    return null;
  }

  // Tie-break: when bare-title and numbered variant both score equal, prefer
  // numbered for revivals. Heuristic: if show.id ends in a year (e.g. -2026),
  // and a candidate slug has a `-N` suffix, that's likely the right revival.
  const isLikelyRevival = !!(show.isRevival || (show.id && /\b(19|20)\d{2}$/.test(show.id)));
  if (isLikelyRevival && ranked.length > 1 && ranked[0].score === ranked[1].score) {
    const numbered = ranked.find(c => /-\d{1,2}$/.test(c.slug));
    if (numbered) {
      return `https://didtheylikeit.com/shows/${numbered.slug}/`;
    }
  }

  return `https://didtheylikeit.com/shows/${ranked[0].slug}/`;
}

module.exports = {
  findDTLIShowLinkOnHomepage,
  extractShowAnchors,
  scoreSlugAgainstShow,
  tokensFromTitle,
};
