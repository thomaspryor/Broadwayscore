#!/usr/bin/env node
/**
 * audit-opera-discovery-gap.js
 *
 * Discovery-gap audit instrument — originally written for opera (Sprint 0),
 * now generalized to any show category: broadway, off-broadway, west-end,
 * off-west-end, or opera.
 *
 * For each show in scope it calls searchOutletSites and buckets every known
 * review URL into one of four buckets:
 *
 *   discovery-miss   the URL was never returned by ANY discovery path.
 *                    Fix: add a new outlet endpoint to site-search-discovery.js.
 *
 *   filter-miss      the URL WAS returned but a downstream filter (year-window,
 *                    urlLooksLikeReview title-match, wrong-production guard)
 *                    dropped it. Fix: relax the offending filter.
 *
 *   extraction-miss  URL discovered + filtered through, but extracted text was
 *                    partial/garbage (contentTier !== complete).
 *                    Fix: outlet-specific extractor.
 *
 *   hit              URL discovered and successfully ingested with complete
 *                    content. No action needed.
 *
 * Usage:
 *   node scripts/audit-opera-discovery-gap.js --show=the-lost-boys-2026
 *   node scripts/audit-opera-discovery-gap.js --category=broadway --all
 *   node scripts/audit-opera-discovery-gap.js --all          # runs all categories
 *
 * Flags:
 *   --category=CAT   broadway | off-broadway | west-end | off-west-end | opera
 *   --all            audit all shows in scope (required for category mode)
 *   --show=ID        audit a single show (prints JSON to stdout)
 *   --days=N         openingDate window ±N days around today (default: 60)
 *
 * Output (--all):
 *   data/audit/discovery-gap-{category}-{YYYY-MM}.md  (one file per category)
 *
 * Cost: site-search dispatch only — WP REST / public listing pages with
 * cookies/Bright Data. No SERP calls.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { searchOutletSites, SITE_SEARCH_ENDPOINTS } = require('./lib/site-search-discovery');

const VALID_CATEGORIES = ['broadway', 'off-broadway', 'west-end', 'off-west-end', 'opera'];

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const REVIEWS_JSON_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getArg(name) {
  const a = process.argv.slice(2).find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return null;
  if (a === `--${name}`) return true;
  return a.split('=').slice(1).join('=');
}

function outMdPath(category) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return path.join(__dirname, '..', 'data', 'audit', `discovery-gap-${category}-${ym}.md`);
}

function loadAllShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows || data;
}

function loadShow(showId) {
  const show = loadAllShows().find((s) => s.id === showId);
  if (!show) throw new Error(`show not found: ${showId}`);
  return show;
}

function loadShowsByCategory(category, daysWindow = 60) {
  const shows = loadAllShows();
  const today = new Date();
  const windowMs = daysWindow * 24 * 60 * 60 * 1000;
  return shows.filter((s) => {
    // Opera shows have category='off-broadway' but type='opera' — match by type.
    // All other categories match by category field and exclude opera type.
    if (category === 'opera') {
      if (s.type !== 'opera') return false;
    } else {
      if (s.category !== category) return false;
      if (s.type === 'opera') return false;
    }
    if (!['open', 'closed'].includes(s.status)) return false;
    if (!s.openingDate) return false;
    const diff = Math.abs(today - new Date(s.openingDate));
    return diff <= windowMs;
  });
}

function loadKnownReviewsForShow(showId) {
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!j.url) continue;
    if (j.wrongProduction || j.wrongShow) continue;
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

// ─── Audit one show ──────────────────────────────────────────────────────────

async function auditShow(showId, reviewsJsonIndex) {
  const show = loadShow(showId);
  const known = loadKnownReviewsForShow(showId);
  const inReviewsJson = reviewsJsonIndex.get(showId) || new Set();
  for (const k of known) k.isInReviewsJson = inReviewsJson.has(k.url);

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

  const buckets = { discoveryMiss: [], filterMiss: [], extractionMiss: [], hit: [] };
  for (const k of known) {
    const seen = discoveredSet.has(k.url);
    if (seen && k.isInReviewsJson && k.contentTier === 'complete') {
      buckets.hit.push(k);
    } else if (seen) {
      if (k.contentTier === 'complete' && !k.isInReviewsJson) {
        buckets.filterMiss.push({ ...k, reason: 'complete but not in reviews.json' });
      } else if (k.contentTier !== 'complete') {
        buckets.extractionMiss.push({ ...k, reason: `contentTier=${k.contentTier}` });
      } else {
        buckets.filterMiss.push({ ...k, reason: 'unclear' });
      }
    } else {
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

function top5MissOutlets(results) {
  const counts = new Map();
  for (const r of results) {
    for (const it of r.buckets.discoveryMiss) {
      const key = it.outlet || it.outletId || 'unknown';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}

function formatMarkdown(results, category) {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const catLabel = category.charAt(0).toUpperCase() + category.slice(1).replace(/-/g, ' ');
  const lines = [];

  lines.push(`# ${catLabel} Discovery Gap Audit — ${ym}`);
  lines.push('');
  lines.push(`Generated by \`scripts/audit-opera-discovery-gap.js --category=${category} --all\`.`);
  lines.push('');
  lines.push('## Bucket definitions');
  lines.push('- **discovery-miss** — `searchOutletSites` did not return the URL. Fix: add outlet endpoint.');
  lines.push('- **filter-miss** — URL was returned but downstream filter (year-window, urlLooksLikeReview, wrong-production guard) blocked ingestion. Fix: relax filter.');
  lines.push('- **extraction-miss** — URL discovered + filtered through, but extracted text was partial/garbage (`contentTier !== complete`). Fix: outlet-specific extractor.');
  lines.push('- **hit** — URL discovered and successfully ingested with complete content. No action needed.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Show | Known | Discovered | discovery-miss | filter-miss | extraction-miss | hit |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push(
      `| ${r.showId} | ${r.knownCount} | ${r.discoveredCount} | ${r.buckets.discoveryMiss.length} | ${r.buckets.filterMiss.length} | ${r.buckets.extractionMiss.length} | ${r.buckets.hit.length} |`,
    );
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
  lines.push(
    `| **TOTAL** | **${tot.known}** | **${tot.disc}** | **${tot.dm}** | **${tot.fm}** | **${tot.em}** | **${tot.hit}** |`,
  );
  lines.push('');
  const pct = (n) => (tot.known === 0 ? '–' : `${Math.round((100 * n) / tot.known)}%`);
  lines.push(
    `**Of ${tot.known} known reviews:** discovery-miss ${pct(tot.dm)}, filter-miss ${pct(tot.fm)}, extraction-miss ${pct(tot.em)}, hit ${pct(tot.hit)}.`,
  );
  lines.push('');

  lines.push('## Top 5 highest-miss outlets (discovery-miss)');
  lines.push('');
  const top5 = top5MissOutlets(results);
  if (top5.length === 0) {
    lines.push('_No discovery misses found._');
  } else {
    lines.push('| Outlet | discovery-miss count |');
    lines.push('|---|---|');
    for (const [outlet, count] of top5) {
      lines.push(`| ${outlet} | ${count} |`);
    }
  }
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
  lines.push('## Scope implication');
  lines.push('');
  if (tot.dm >= Math.ceil(tot.known * 0.5)) {
    lines.push(
      `Discovery-miss is the dominant bucket (${pct(tot.dm)} of known reviews). Add per-outlet endpoints for each discovery-missed outlet.`,
    );
  } else if (tot.fm >= Math.ceil(tot.known * 0.3)) {
    lines.push(
      `Filter-miss accounts for ≥30% (${pct(tot.fm)}). Investigate \`filterOperaUrls()\` year-window and \`urlLooksLikeReview()\` title-matching BEFORE adding new outlet endpoints.`,
    );
  } else {
    lines.push(
      `No single bucket dominates. Address discovery-miss as planned; review filter-miss and extraction-miss case-by-case.`,
    );
  }
  return lines.join('\n') + '\n';
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async function main() {
  const showArg = getArg('show');
  const allArg = getArg('all');
  const categoryArg = getArg('category');
  const daysArg = getArg('days');
  const daysWindow = daysArg ? parseInt(daysArg, 10) : 60;

  if (!showArg && !allArg) {
    console.error('Usage:');
    console.error('  node scripts/audit-opera-discovery-gap.js --show=SHOW_ID');
    console.error('  node scripts/audit-opera-discovery-gap.js --category=broadway --all');
    console.error('  node scripts/audit-opera-discovery-gap.js --all   # all categories');
    process.exit(2);
  }

  if (categoryArg && !VALID_CATEGORIES.includes(categoryArg)) {
    console.error(`Unknown category "${categoryArg}". Valid: ${VALID_CATEGORIES.join(', ')}`);
    process.exit(2);
  }

  const reviewsJsonIndex = loadReviewsJsonIndex();

  // ── Single-show mode ──────────────────────────────────────────────────────
  if (showArg) {
    process.stderr.write(`auditing ${showArg}…\n`);
    const result = await auditShow(showArg, reviewsJsonIndex);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  // ── Category / all-categories mode ───────────────────────────────────────
  const categoriesToRun = categoryArg ? [categoryArg] : VALID_CATEGORIES;

  for (const cat of categoriesToRun) {
    const shows = loadShowsByCategory(cat, daysWindow);
    if (shows.length === 0) {
      process.stderr.write(`[${cat}] no shows found in ±${daysWindow}-day window — skipping\n`);
      continue;
    }
    process.stderr.write(`[${cat}] auditing ${shows.length} shows…\n`);
    const results = [];
    for (const show of shows) {
      process.stderr.write(`  ${show.id}…\n`);
      results.push(await auditShow(show.id, reviewsJsonIndex));
    }
    const outMd = outMdPath(cat);
    fs.mkdirSync(path.dirname(outMd), { recursive: true });
    fs.writeFileSync(outMd, formatMarkdown(results, cat));
    process.stderr.write(`wrote ${outMd}\n`);
  }
})().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
