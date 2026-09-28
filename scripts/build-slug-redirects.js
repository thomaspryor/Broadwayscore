#!/usr/bin/env node
/**
 * Build a redirect map for versionless show slugs (and retired critic slugs).
 *
 * When someone visits /show/hamilton (no year suffix), we need to redirect
 * to the actual slug (e.g. hamilton-2015). This script generates a compact
 * JSON map: { baseName: { target, permanent } }
 *
 * - target: the slug of the most recent production
 * - permanent: true (301) for single-production, false (302) for multi
 *
 * Critic-slug aliases (data/critic-slug-aliases.json, core data — see
 * scripts/lib/critic-slug-aliases.js) ride along in the same compact file
 * under the "critic:" key prefix, so /critics/<old-slug> 301s to the
 * canonical critic page through the same middleware (2026 data audit, S5-T9).
 *
 * Output: data/slug-redirects.json (full, for inspection) and
 *         data/slug-redirects-compact.json (src/middleware.ts + data-reviews.ts)
 *
 * Env overrides — tests only, production callers never set them:
 *   SLUG_REDIRECTS_SHOWS_PATH  read shows from here instead of data/shows.json
 *   SLUG_REDIRECTS_OUT_DIR     write both outputs here instead of data/
 *   CRITIC_SLUG_ALIASES_PATH   alias registry path (honoured by the loader)
 */

const fs = require('fs');
const path = require('path');
const {
  loadCriticSlugAliases,
  flattenCriticSlugAliases,
  buildCriticRedirectEntries,
} = require('./lib/critic-slug-aliases');

const dataDir = path.join(__dirname, '..', 'data');
const showsPath = process.env.SLUG_REDIRECTS_SHOWS_PATH || path.join(dataDir, 'shows.json');
const outDir = process.env.SLUG_REDIRECTS_OUT_DIR || dataDir;
const outputPath = path.join(outDir, 'slug-redirects.json');
const compactPath = path.join(outDir, 'slug-redirects-compact.json');

const { shows } = JSON.parse(fs.readFileSync(showsPath, 'utf8'));

// Set of all existing slugs (these already resolve to a page)
const existingSlugs = new Set(shows.map(s => s.slug));

// Group shows by base name (id minus trailing -YYYY)
const groups = {};
for (const show of shows) {
  const match = show.id.match(/-(\d{4})$/);
  if (!match) continue;

  const base = show.id.slice(0, -5); // strip -YYYY
  const year = parseInt(match[1], 10);

  // Skip if the base name already resolves to a show page
  if (existingSlugs.has(base)) continue;

  if (!groups[base]) groups[base] = [];
  groups[base].push({ slug: show.slug, year });
}

// Build the redirect map
const redirects = {};
for (const [base, productions] of Object.entries(groups)) {
  // Sort by year descending — most recent first
  productions.sort((a, b) => b.year - a.year);
  const newest = productions[0];

  redirects[base] = {
    target: newest.slug,
    permanent: productions.length === 1,
  };
}

// ALSO add id → slug redirects whenever the show's id has a year suffix that
// the slug omits (e.g. id=hamilton-west-end-2021, slug=hamilton-west-end).
// These canonical id-based URLs appear in scraped SERPs, share links, and bookmarks.
// Without this, /show/hamilton-west-end-2021 returns 404.
// Found in WE pre-Reddit-launch audit (2026-04-10): 8/10 marquee WE shows had this.
for (const show of shows) {
  if (show.id !== show.slug && !existingSlugs.has(show.id) && !redirects[show.id]) {
    redirects[show.id] = {
      target: show.slug,
      permanent: true,
    };
  }
}

// ALSO emit redirects for any explicit `aliases` array on a show.
// This is how merged duplicate entries keep their old IDs and slugs
// reachable — the bookmark / share / SERP cache for the dropped record
// stays valid, just rewires to the canonical slug.
// Added 2026-05-03 after the Emporium merge dropped two URLs that
// previously rendered an Off-Broadway show page.
for (const show of shows) {
  const aliases = Array.isArray(show.aliases) ? show.aliases : [];
  for (const alias of aliases) {
    if (!alias || alias === show.id || alias === show.slug) continue;
    if (existingSlugs.has(alias)) continue; // alias collides with another show
    if (redirects[alias]) continue; // already covered by another path
    redirects[alias] = {
      target: show.slug,
      permanent: true,
    };
  }
}

// Critic-slug aliases: retired /critics/<slug> URLs → canonical slug. A
// missing registry is an empty map (a checkout without core data still
// builds); a malformed one throws and fails prebuild on purpose. Chains are
// flattened here so the middleware never has to follow one; self-maps and
// cycles are dropped with a warning rather than emitted as a redirect loop.
const { aliases: criticRedirects, dropped: droppedCriticAliases } = flattenCriticSlugAliases(loadCriticSlugAliases());
for (const d of droppedCriticAliases) {
  console.warn(`critic-slug alias skipped: "${d.slug}" — ${d.reason}`);
}

// Full version (for debugging / inspection)
const output = {
  _meta: {
    description: 'Versionless slug → most recent production redirect map; criticRedirects = retired critic slug → canonical slug',
    generatedAt: new Date().toISOString(),
    totalRedirects: Object.keys(redirects).length,
    totalCriticRedirects: Object.keys(criticRedirects).length,
  },
  redirects,
  criticRedirects,
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');

// Compact version for middleware (minimal size for edge runtime)
// Format: { baseName: targetSlug } — prefix target with "~" for 302 (multi-production)
//         { "critic:<oldSlug>": canonicalSlug } — always 301 (see buildCriticRedirectEntries)
const compact = {};
for (const [base, { target, permanent }] of Object.entries(redirects)) {
  compact[base] = permanent ? target : '~' + target;
}
Object.assign(compact, buildCriticRedirectEntries(criticRedirects));
fs.writeFileSync(compactPath, JSON.stringify(compact) + '\n');

const multiCount = Object.values(redirects).filter(r => !r.permanent).length;
const singleCount = Object.values(redirects).filter(r => r.permanent).length;
const criticCount = Object.keys(criticRedirects).length;
console.log(`Generated ${Object.keys(redirects).length} redirects (${singleCount} permanent, ${multiCount} temporary) + ${criticCount} critic aliases → ${outputPath}`);
