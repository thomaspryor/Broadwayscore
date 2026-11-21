'use strict';

const AUTHOR_SOURCES = {
  nytimes: { key: 'nyt', base: 'https://www.nytimes.com/by/' },
  newyorker: { key: 'newyorker', base: 'https://www.newyorker.com/contributors/' },
  vulture: { key: 'vulture', base: 'https://www.vulture.com/author/', suffix: '/' },
};

// Shared with the coverage audit, including its historical-mode exclusion set.
function selectActiveCritics(registry, reviews, outletRegistry) {
  const outlets = outletRegistry.outlets || outletRegistry;
  const last = {};
  for (const r of reviews) {
    if (r.criticName && r.publishDate && (!last[r.criticName] || r.publishDate > last[r.criticName])) {
      last[r.criticName] = r.publishDate;
    }
  }
  return Object.entries(registry.critics || registry)
    .filter(([, c]) => c.displayName !== 'Unknown'
      && [1, 2].includes(outlets[c.primaryOutlet]?.tier)
      && last[c.displayName] >= '2025-01-01' && c.totalReviews >= 20)
    .map(([slug, c]) => ({ slug, name: c.displayName, outlet: c.primaryOutlet,
      tier: outlets[c.primaryOutlet].tier, total: c.totalReviews, lastDate: last[c.displayName] }))
    .sort((a, b) => b.total - a.total);
}

function authorSlug(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[.'’]/g, '').trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function discoveryCandidates(critics, overrides) {
  return critics.flatMap(c => {
    const source = AUTHOR_SOURCES[c.outlet];
    if (!source || overrides[c.slug]?.[source.key]) return [];
    const slug = authorSlug(c.name);
    if (!slug) return [];
    return [{ ...c, key: source.key, authorSlug: slug, url: source.base + slug + (source.suffix || '') }];
  });
}

// HTTP 200 alone also accepts homepages, challenge pages and unrelated authors.
// Identity comes from page content, never from the URL.
function verifyAuthorPage(result, candidate) {
  if (!result || (result.status != null && result.status !== 200)
    || (result.statusCode != null && result.statusCode !== 200) || !result.content) return false;
  // Ignore script/template text so embedded error-page markup is not identity evidence.
  const html = result.content.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const headings = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map(([, text]) => authorSlug(text
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:nbsp|#160);/gi, ' ')
    .replace(/&(?:apos|rsquo|#39|#8217|#x27);/gi, "'")));
  if (!headings.includes(authorSlug(candidate.name))) return false;
  const canonical = (html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["']/i)
    || html.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["']/i))?.[1];
  for (const address of [result.finalUrl, canonical].filter(Boolean)) {
    try {
      const actual = new URL(address, candidate.url);
      const expected = new URL(candidate.url);
      if (actual.origin !== expected.origin
        || actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')) return false;
    } catch { return false; }
  }
  return true;
}

// One probe's worst case is a full fetchPage() fallback chain (~2.5 min), so
// don't start one with less than 3 min of budget left (BRO-6587).
const MIN_REMAINING_MS_TO_START = 3 * 60 * 1000;

async function discoverAuthorPages(critics, overrides, fetchPage, budget = null) {
  const updated = structuredClone(overrides);
  const results = [];
  for (const candidate of discoveryCandidates(critics, overrides)) {
    // Out of budget: leave the rest for the next run instead of being killed
    // mid-probe and losing the verified additions made so far.
    if (budget && !budget.canStartItem(MIN_REMAINING_MS_TO_START)) {
      results.push({ ...candidate, status: 'deferred', reason: 'run budget exhausted' });
      continue;
    }
    try {
      const page = await fetchPage(candidate.url, { timeout: 30000 });
      if (!verifyAuthorPage(page, candidate)) {
        results.push({ ...candidate, status: 'skipped', reason: 'author-page-not-verified' });
        continue;
      }
      updated[candidate.slug] = { ...updated[candidate.slug], [candidate.key]: candidate.authorSlug };
      results.push({ ...candidate, status: 'added' });
    } catch (error) {
      results.push({ ...candidate, status: 'skipped', reason: error.message });
    }
  }
  return { overrides: updated, results };
}

module.exports = { selectActiveCritics, authorSlug, discoveryCandidates, verifyAuthorPage, discoverAuthorPages };
