#!/usr/bin/env node
/**
 * Build a redirect map for versionless show slugs.
 *
 * When someone visits /show/hamilton (no year suffix), we need to redirect
 * to the actual slug (e.g. hamilton-2015). This script generates a compact
 * JSON map: { baseName: { target, permanent } }
 *
 * - target: the slug of the most recent production
 * - permanent: true (301) for single-production, false (302) for multi
 *
 * Output: data/slug-redirects.json
 */

const fs = require('fs');
const path = require('path');

const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
const outputPath = path.join(__dirname, '..', 'data', 'slug-redirects.json');

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

// Full version (for debugging / inspection)
const output = {
  _meta: {
    description: 'Versionless slug → most recent production redirect map',
    generatedAt: new Date().toISOString(),
    totalRedirects: Object.keys(redirects).length,
  },
  redirects,
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');

// Compact version for middleware (minimal size for edge runtime)
// Format: { baseName: targetSlug } — prefix target with "~" for 302 (multi-production)
const compact = {};
for (const [base, { target, permanent }] of Object.entries(redirects)) {
  compact[base] = permanent ? target : '~' + target;
}
const compactPath = path.join(__dirname, '..', 'data', 'slug-redirects-compact.json');
fs.writeFileSync(compactPath, JSON.stringify(compact) + '\n');

const multiCount = Object.values(redirects).filter(r => !r.permanent).length;
const singleCount = Object.values(redirects).filter(r => r.permanent).length;
console.log(`Generated ${Object.keys(redirects).length} redirects (${singleCount} permanent, ${multiCount} temporary) → ${outputPath}`);
