#!/usr/bin/env node
/**
 * audit-opera-discovery-gap.js
 *
 * Sprint 0 instrumentation for the Opera Auto-Discovery V2 plan.
 *
 * Question: for each opera review we manually ingested this session, which of
 * the three paths did the CURRENT gather pipeline miss it on?
 *
 *   discovery-miss   the URL was never returned by ANY discovery path
 *                    (site-search dispatch or SERP). Fix: add a new outlet
 *                    endpoint to scripts/lib/site-search-discovery.js.
 *
 *   filter-miss      the URL WAS returned by the dispatch, but a downstream
 *                    filter (filterOperaUrls year-window, urlLooksLikeReview
 *                    title-match, wrong-production guard, etc.) dropped it.
 *                    Fix: relax the offending filter, not add an outlet.
 *
 *   extraction-miss  the URL was discovered AND filtered through, but the
 *                    extractor returned empty/teaser/garbage and the file
 *                    was flagged as invalid. Fix: outlet-specific extractor.
 *
 * Usage:
 *   node scripts/audit-opera-discovery-gap.js --show=tristan-und-isolde-off-broadway-2026
 *   node scripts/audit-opera-discovery-gap.js --all
 *
 * Output: JSON to stdout (single show) or markdown table to
 * data/audit/opera-discovery-gap-2026-05.md (--all).
 *
 * Cost: site-search dispatch only — uses WP REST / public listing pages with
 * cookies. No SERP calls. Total cost ~free (a handful of HTTP fetches per
 * show via existing cookie/Bright Data infrastructure).
 *
 * For SERP-path coverage, see the SERP audit follow-up (filed separately if
 * Sprint 0 bucketing shows discovery-miss is the dominant bucket).
 */

'use strict';

// Bypass the Sprint 3 opera-discovery cache. The audit is an instrumentation
// pass — re-runs must read fresh discovery output so cache staleness can't
// mask a real regression.
process.env.OPERA_DISCOVERY_BYPASS_CACHE = '1';

const fs = require('fs');
const path = require('path');
const { searchOutletSites, SITE_SEARCH_ENDPOINTS } = require('./lib/site-search-discovery');

// ─── Inputs ──────────────────────────────────────────────────────────────────

// The 6 recent Met productions whose coverage we audited this session.
// Source of truth: data/shows.json (type: opera).
const OPERA_SHOWS = [
  'tristan-und-isolde-off-broadway-2026',
  'innocence-off-broadway-2026',
  'the-amazing-adventures-of-kavalier-and-clay-off-broadway-2025',
  'eugene-onegin-off-broadway-2026',
  'la-traviata-off-broadway-2026',
  'el-ultimo-sueno-de-frida-y-diego-off-broadway-2026',
];

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const REVIEWS_JSON_PATH = path.join(__dirname, '..', 'data', 'reviews.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');
const OUT_MD = path.join(__dirname, '..', 'data', 'audit', 'opera-discovery-gap-2026-05.md');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getArg(name) {
  const a = process.argv.slice(2).find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return null;
  if (a === `--${name}`) return true;
  return a.split('=').slice(1).join('=');
}

function loadShow(showId) {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows || data;
  const show = shows.find((s) => s.id === showId);
  if (!show) throw new Error(`show not found: ${showId}`);
  return show;
}

function loadKnownReviewsForShow(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!j.url) continue;
    if (j.wrongProduction || j.wrongShow) continue; // skip flagged
    out.push({
      file: f,
      url: j.url,
      outlet: j.outlet || j.outletId,
      outletId: j.outletId || null,
      criticName: j.criticName || 'Unknown',
      contentTier: j.contentTier || 'unknown',
      source: j.source || j.sourceMethod || j.fetchMethod || 'unknown',
      isInReviewsJson: false,
    });
  }
  return out;
}

function loadReviewsJsonIndex() {
  const data = JSON.parse(fs.readFileSync(REVIEWS_JSON_PATH, 'utf8'));
  const arr = data.reviews || data;
  const index = new Map();
  for (const r of arr) {
    if (!r.showId || !r.url) continue;
    if (!index.has(r.showId)) index.set(r.showId, new Set());
    index.get(r.showId).add(r.url);
  }
  return index;
}

function loadOutletIdsForBroadway() {
  const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const outlets = reg.outlets || reg;
  const ids = [];
  for (const [id, info] of Object.entries(outlets)) {
    if (typeof info !== 'object') continue;
    if (!SITE_SEARCH_ENDPOINTS[id]) continue;
    ids.push(id);
  }
  return ids;
}

// ─── Audit one show ──────────────────────────────────────────────────────────

async function auditShow(showId, reviewsJsonIndex) {
  const show = loadShow(showId);
  const known = loadKnownReviewsForShow(showId);
  const inReviewsJson = reviewsJsonIndex.get(showId) || new Set();
  for (const k of known) k.isInReviewsJson = inReviewsJson.has(k.url);

  // 1. Run site-search dispatch across every outlet that has a site-search
  //    endpoint registered. This matches what gather-reviews.js does for
  //    opera shows via searchOutletSites().
  const outletIds = Object.keys(SITE_SEARCH_ENDPOINTS);
  let discovered = [];
  try {
    discovered = await searchOutletSites(show.title, outletIds, {
      market: show.market || 'broadway',
      openingDate: show.openingDate,
      show,
      verbose: false,
    });
  } catch (e) {
    console.error(`[${showId}] searchOutletSites threw: ${e.message}`);
  }
  const discoveredSet = new Set(discovered.map((d) => d.url));

  // 2. Bucket each known URL.
  const buckets = { discoveryMiss: [], filterMiss: [], extractionMiss: [], hit: [] };
  for (const k of known) {
    const seen = discoveredSet.has(k.url);
    if (seen && k.isInReviewsJson && k.contentTier === 'complete') {
      buckets.hit.push(k);
    } else if (seen && (!k.isInReviewsJson || k.contentTier !== 'complete')) {
      // Discovery DID return the URL, but the review either didn't make it
      // to reviews.json (filter dropped it) or has incomplete text (extractor
      // failed). Distinguish by contentTier.
      if (k.contentTier === 'complete' && !k.isInReviewsJson) {
        buckets.filterMiss.push({ ...k, reason: 'complete but not in reviews.json' });
      } else if (k.contentTier !== 'complete') {
        buckets.extractionMiss.push({ ...k, reason: `contentTier=${k.contentTier}` });
      } else {
        buckets.filterMiss.push({ ...k, reason: 'unclear' });
      }
    } else {
      // Discovery did not return the URL.
      buckets.discoveryMiss.push(k);
    }
  }

  return {
    showId,
    showTitle: show.title,
    knownCount: known.length,
    discoveredCount: discovered.length,
    buckets,
  };
}

// ─── Markdown output ─────────────────────────────────────────────────────────

function formatMarkdown(results) {
  const lines = [];
  lines.push('# Opera Discovery Gap Audit — 2026-05');
  lines.push('');
  lines.push('Generated by `scripts/audit-opera-discovery-gap.js` as Sprint 0 of the Opera Auto-Discovery V2 plan.');
  lines.push('');
  lines.push('## Bucket definitions');
  lines.push('- **discovery-miss** — `searchOutletSites` did not return the URL. Fix: add outlet endpoint.');
  lines.push('- **filter-miss** — URL was returned but downstream filter (year-window, urlLooksLikeReview, wrong-production guard) blocked ingestion. Fix: relax filter.');
  lines.push('- **extraction-miss** — URL discovered + filtered through, but extracted text was partial/garbage (`contentTier !== complete`). Fix: outlet-specific extractor.');
  lines.push('- **hit** — URL was discovered and successfully ingested with complete content. (No action — the pipeline got this one right.)');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Show | Known | Discovered | discovery-miss | filter-miss | extraction-miss | hit |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(`| ${r.showId} | ${r.knownCount} | ${r.discoveredCount} | ${r.buckets.discoveryMiss.length} | ${r.buckets.filterMiss.length} | ${r.buckets.extractionMiss.length} | ${r.buckets.hit.length} |`);
  }
  const tot = results.reduce(
    (a, r) => ({
      known: a.known + r.knownCount,
      disc: a.disc + r.discoveredCount,
      dm: a.dm + r.buckets.discoveryMiss.length,
      fm: a.fm + r.buckets.filterMiss.length,
      em: a.em + r.buckets.extractionMiss.length,
      hit: a.hit + r.buckets.hit.length,
    }),
    { known: 0, disc: 0, dm: 0, fm: 0, em: 0, hit: 0 },
  );
  lines.push(`| **TOTAL** | **${tot.known}** | **${tot.disc}** | **${tot.dm}** | **${tot.fm}** | **${tot.em}** | **${tot.hit}** |`);
  lines.push('');
  const pct = (n) => (tot.known === 0 ? '–' : `${Math.round((100 * n) / tot.known)}%`);
  lines.push(`**Of ${tot.known} known reviews:** discovery-miss ${pct(tot.dm)}, filter-miss ${pct(tot.fm)}, extraction-miss ${pct(tot.em)}, hit ${pct(tot.hit)}.`);
  lines.push('');
  lines.push('## Per-show detail');
  for (const r of results) {
    lines.push('');
    lines.push(`### ${r.showTitle} (\`${r.showId}\`)`);
    for (const bucket of ['discoveryMiss', 'filterMiss', 'extractionMiss', 'hit']) {
      const items = r.buckets[bucket];
      if (items.length === 0) continue;
      lines.push('');
      lines.push(`**${bucket}** (${items.length}):`);
      for (const it of items) {
        const reason = it.reason ? ` _(${it.reason})_` : '';
        lines.push(`- ${it.outlet} / ${it.criticName} — ${it.url}${reason}`);
      }
    }
  }
  lines.push('');
  lines.push('## Sprint 2 scope implication');
  lines.push('');
  if (tot.dm >= Math.ceil(tot.known * 0.5)) {
    lines.push(`Discovery-miss is the dominant bucket (${pct(tot.dm)} of known reviews). Sprint 2 proceeds as planned — add per-outlet endpoints for each discovery-missed outlet.`);
  } else if (tot.fm >= Math.ceil(tot.known * 0.3)) {
    lines.push(`Filter-miss accounts for ≥30% (${pct(tot.fm)}). File a Notion follow-up to investigate \`filterOperaUrls()\` year-window and \`urlLooksLikeReview()\` title-matching for opera URLs BEFORE adding new outlet endpoints.`);
  } else {
    lines.push(`No single bucket dominates. Address discovery-miss in Sprint 2 as planned; review filter-miss and extraction-miss case-by-case.`);
  }
  return lines.join('\n') + '\n';
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async function main() {
  const showArg = getArg('show');
  const allArg = getArg('all');
  if (!showArg && !allArg) {
    console.error('Usage: node scripts/audit-opera-discovery-gap.js --show=ID | --all');
    process.exit(2);
  }
  const reviewsJsonIndex = loadReviewsJsonIndex();
  const shows = allArg ? OPERA_SHOWS : [showArg];
  const results = [];
  for (const showId of shows) {
    process.stderr.write(`auditing ${showId}…\n`);
    results.push(await auditShow(showId, reviewsJsonIndex));
  }
  if (allArg) {
    fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
    fs.writeFileSync(OUT_MD, formatMarkdown(results));
    process.stderr.write(`wrote ${OUT_MD}\n`);
  } else {
    process.stdout.write(JSON.stringify(results[0], null, 2) + '\n');
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
