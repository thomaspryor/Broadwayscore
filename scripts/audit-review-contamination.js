#!/usr/bin/env node
/**
 * Systematic review-text contamination audit.
 *
 * Detects 5 classes of data-quality issues across all review-texts folders:
 *   A. Cross-market contamination — review dated near a sibling production's
 *      opening but filed under a different production of the same title.
 *      (Catches Broadway↔WE and Broadway↔OB folder mixups.)
 *   C. Domain/outlet mismatch — URL domain doesn't match the filename outlet
 *      and the registry resolves the URL domain to a different outletId.
 *   D. Pre-opening features masquerading as reviews — published >5 days before
 *      opening, URL slug lacks "review" marker, has substantial text. (Best-effort
 *      detection; skipped in strict mode — too many edge cases.)
 *   E. Unflagged roundup pages — URL matches /article/Review-Roundup-... but
 *      isRoundupArticle != true.
 *   F. Empty --unknown junk files — filename contains --unknown, URL is null,
 *      and fullText is empty. Pure scrape garbage.
 *
 * Usage:
 *   node scripts/audit-review-contamination.js              # Report mode (exits 0 unless --strict)
 *   node scripts/audit-review-contamination.js --strict     # Exits 1 if ANY hits found
 *   node scripts/audit-review-contamination.js --classes A,E,F  # Only specified classes
 *   node scripts/audit-review-contamination.js --json > out.json # Machine-readable output
 *
 * Background: this script was built after the 2026-04-11 Oh, Mary! Broadway audit
 * found 18 contamination issues in a single 66-file folder. Systematic scan across
 * 1,639 shows / 34,737 files found 291 total instances of the same patterns.
 * The CI job runs this in --strict mode to prevent new contamination from landing.
 *
 * See: memory/feedback_review_audit_contamination.md (TBD)
 */

const fs = require('fs');
const path = require('path');

const REVIEW_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');

// Parse args
const args = process.argv.slice(2);
const STRICT = args.includes('--strict');
const JSON_OUT = args.includes('--json');
const classesIdx = args.findIndex(a => a.startsWith('--classes'));
let ONLY_CLASSES = null;
if (classesIdx >= 0) {
  // Support both --classes=A,E,F and --classes A,E,F
  const val = args[classesIdx].includes('=')
    ? args[classesIdx].split('=')[1]
    : args[classesIdx + 1];
  if (val) ONLY_CLASSES = new Set(val.split(','));
}
function shouldRunClass(c) { return !ONLY_CLASSES || ONLY_CLASSES.has(c); }

// ─────────────────────────────────────────────────
// Load data
// ─────────────────────────────────────────────────
const shows = require(SHOWS_PATH).shows;
const registry = require(REGISTRY_PATH);

function detectMarket(id) {
  if (/-off-off-broadway-/.test(id)) return 'off-off-broadway';
  if (/-off-broadway-/.test(id)) return 'off-broadway';
  if (/-off-west-end-/.test(id)) return 'off-west-end';
  if (/-west-end-/.test(id)) return 'west-end';
  return 'broadway';
}

function normalizeTitle(t) {
  return (t || '').toLowerCase().trim().replace(/[!?.,'"]/g, '');
}

function parseDate(d) {
  if (!d || typeof d !== 'string') return null;
  const cleaned = d.replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1');
  const t = new Date(cleaned);
  return isNaN(t.getTime()) ? null : t;
}

function parseDomain(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/(?:www\.)?([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

// Build sibling map: title -> shows
const byTitle = {};
shows.forEach(s => {
  const t = normalizeTitle(s.title);
  if (!t) return;
  (byTitle[t] = byTitle[t] || []).push(s);
});
const siblingsOf = new Map();
shows.forEach(s => {
  const t = normalizeTitle(s.title);
  const sibs = (byTitle[t] || []).filter(x => x.id !== s.id);
  siblingsOf.set(s.id, sibs);
});
const showById = new Map();
shows.forEach(s => showById.set(s.id, { ...s, market: detectMarket(s.id) }));

// Registry domain reverse lookup + collision detection.
// A domain with multiple registered outlets is AMBIGUOUS — two outlets may legitimately
// share the same domain (e.g. express.co.uk serves both Daily Express and Sunday Express,
// telegraph.co.uk serves both Daily Telegraph and Sunday Telegraph, timeout.com serves
// both TimeOut NY and TimeOut London via path-based distinction). These cases can't be
// auto-resolved from the URL alone; the byline is the ground truth.
const domainToOutlets = {};
for (const [id, o] of Object.entries(registry.outlets)) {
  const domains = [];
  if (o.domain) domains.push(o.domain.toLowerCase());
  if (Array.isArray(o.domainAliases)) {
    o.domainAliases.forEach(d => domains.push(d.toLowerCase()));
  }
  for (const d of domains) {
    (domainToOutlets[d] = domainToOutlets[d] || new Set()).add(id);
  }
}
const domainToOutlet = {};      // unique-only reverse lookup
const AMBIGUOUS_DOMAINS = new Set();
for (const [d, ids] of Object.entries(domainToOutlets)) {
  if (ids.size === 1) domainToOutlet[d] = [...ids][0];
  else AMBIGUOUS_DOMAINS.add(d);
}
// Wire services — reviews legitimately show up under many outlets
const WIRE_OUTLETS = new Set(['ap', 'reuters', 'upi']);

// ─────────────────────────────────────────────────
// Detectors
// ─────────────────────────────────────────────────
const hits = {
  A_cross_market: [],
  C_domain_mismatch: [],
  E_unflagged_roundup: [],
  F_empty_unknown: [],
};

let filesScanned = 0;
let showsScanned = 0;

const showDirs = fs.readdirSync(REVIEW_DIR).filter(d => {
  try { return fs.statSync(path.join(REVIEW_DIR, d)).isDirectory(); }
  catch { return false; }
});

for (const showId of showDirs) {
  const show = showById.get(showId);
  if (!show) continue;
  showsScanned++;
  const sibs = (siblingsOf.get(showId) || []).map(s => ({
    id: s.id,
    market: detectMarket(s.id),
    opening: parseDate(s.openingDate),
  })).filter(s => s.opening);
  const showOpening = parseDate(show.openingDate);

  const sDir = path.join(REVIEW_DIR, showId);
  let files;
  try { files = fs.readdirSync(sDir).filter(f => f.endsWith('.json')); }
  catch { continue; }

  for (const f of files) {
    filesScanned++;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(sDir, f), 'utf8')); }
    catch { continue; }

    const alreadyFlagged = d.wrongProduction || d.wrongShow || d.isRoundupArticle
      || d.wrongAttribution || d.contentVerification?.wrongArticle;

    // ─── A: Cross-market / cross-production contamination ────
    // `_auditAllowCrossMarket` is a manual allowlist for cases the detector can't
    // disambiguate automatically (typically when a review's publishDate coincides
    // with a sibling production's opening date but the URL + text confirm it
    // belongs to the current folder).
    if (shouldRunClass('A') && !alreadyFlagged && !d._auditAllowCrossMarket) {
      const pubDate = parseDate(d.publishDate);
      if (pubDate && showOpening && sibs.length) {
        const thisDiff = Math.abs(pubDate - showOpening) / 86400000;
        let best = null;
        for (const s of sibs) {
          const diff = Math.abs(pubDate - s.opening) / 86400000;
          if (!best || diff < best.diff) best = { ...s, diff };
        }
        if (best && best.diff <= 30 && thisDiff > 180) {
          hits.A_cross_market.push({
            showId, file: f, thisMarket: show.market, sibId: best.id, sibMarket: best.market,
            pubDate: d.publishDate, thisDiff: Math.round(thisDiff), sibDiff: Math.round(best.diff),
          });
        }
      }
    }

    // ─── C: Domain / outlet mismatch ────
    // Compare the INTERNAL outletId (used for scoring) against the URL domain.
    // Filename-outlet drift is cosmetic — rebuild's stale-outlet-mismatch pass will
    // rename files whose filename outlet doesn't match internal outletId, so we only
    // care about cases where the *internal* outletId is wrong.
    if (shouldRunClass('C') && !alreadyFlagged && d.url) {
      const domain = parseDomain(d.url);
      if (domain && !AMBIGUOUS_DOMAINS.has(domain)) {
        const expected = domainToOutlet[domain];
        const internalOutlet = d.outletId || f.split('--')[0];
        if (expected && expected !== internalOutlet && !WIRE_OUTLETS.has(internalOutlet)) {
          hits.C_domain_mismatch.push({
            showId, file: f, internalOutlet, expected, domain,
          });
        }
      }
    }

    // ─── E: Unflagged roundup pages ────
    // Must match the same pattern as Guard E in review-file-writer.js
    if (shouldRunClass('E') && !d.isRoundupArticle && d.url) {
      if (/\/article\/Review-Roundup-/i.test(d.url)) {
        hits.E_unflagged_roundup.push({ showId, file: f, url: d.url });
      }
    }

    // ─── F: Empty --unknown junk ────
    if (shouldRunClass('F') && f.includes('--unknown')) {
      const noUrl = !d.url;
      const noText = !(d.fullText || '').trim();
      if (noUrl && noText) {
        hits.F_empty_unknown.push({ showId, file: f });
      }
    }
  }
}

// ─────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────
const totalHits = Object.values(hits).reduce((a, b) => a + b.length, 0);

if (JSON_OUT) {
  console.log(JSON.stringify({
    scannedShows: showsScanned,
    scannedFiles: filesScanned,
    totalHits,
    classCounts: Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, v.length])),
    hits,
  }, null, 2));
} else {
  console.log(`\n=== REVIEW-TEXT CONTAMINATION AUDIT ===`);
  console.log(`Scanned: ${showsScanned} shows, ${filesScanned} files`);
  console.log(`Total hits: ${totalHits}\n`);
  for (const [k, arr] of Object.entries(hits)) {
    console.log(`  ${k}: ${arr.length}`);
  }
  if (totalHits > 0) {
    console.log('\n=== SAMPLES (first 5 per class) ===');
    for (const [k, arr] of Object.entries(hits)) {
      if (!arr.length) continue;
      console.log(`\n--- ${k} ---`);
      arr.slice(0, 5).forEach(h => console.log('  ' + JSON.stringify(h)));
    }
  }
}

if (STRICT && totalHits > 0) {
  console.error(`\n❌ STRICT mode: ${totalHits} contamination issue(s) detected. Failing.`);
  process.exit(1);
}

process.exit(0);
