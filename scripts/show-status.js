#!/usr/bin/env node
/**
 * show-status.js — the ONE canonical way to ask "what reviews does a show have,
 * locally and live on the site?" Use this instead of hand-curling/parsing the
 * production JSON.
 *
 * WHY THIS EXISTS (2026-06-28 incident): the production per-show file at
 *   https://broadwayscorecard.com/data/shows/{id}.json
 * is the SLIM/mobile format written by generate-mobile-show-details.js. Its keys
 * are ABBREVIATED. A session read `.reviews` (which does not exist), got
 * `undefined` → 0, and falsely concluded the reviews weren't live — when in fact
 * the show had 24 reviews under `.rv`. Hand-parsing the slim JSON is a recurring
 * foot-gun. Always use this script (or import decodeSlimShow below).
 *
 * SLIM SHOW JSON KEY MAP (top level):
 *   _v schemaVersion | id | cat category | cs criticScore | rc reviewCount
 *   bd scoreBreakdown | rv REVIEWS[] | au audience | cn criticConsensus
 *   bo boxOffice | hi heroImage | pd previewsDate
 * Each entry in rv (REVIEWS) — ONLY reviews with assignedScore != null are emitted,
 * so rv == the scored-and-live set the site actually shows:
 *   cn criticName | o outlet | s score(0-100) | b bucket | t tier
 *   u url | d publishDate | q pullQuote | dg designation
 *
 * Usage:
 *   node scripts/show-status.js <show-id>            # local reviews.json + prod, side by side
 *   node scripts/show-status.js <show-id> --critic="Louise Penn"   # is this critic live?
 *   node scripts/show-status.js <show-id> --local-only
 *   node scripts/show-status.js <show-id> --json
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_ROOT = path.join(__dirname, '..');
const PROD_BASE = 'https://broadwayscorecard.com/data/shows';

function arg(name, dflt) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
const hasFlag = (n) => process.argv.slice(2).includes(`--${n}`);

/**
 * Decode a slim (mobile/prod) show JSON object into a friendly shape.
 * Tolerant of both the abbreviated slim format (rv/cs/rc) AND a raw object
 * that already uses `reviews` — so callers never have to guess the key.
 */
function decodeSlimShow(obj) {
  if (!obj || typeof obj !== 'object') return { reviewCount: 0, criticScore: null, reviews: [] };
  const rv = Array.isArray(obj.rv) ? obj.rv
    : Array.isArray(obj.reviews) ? obj.reviews
    : [];
  const reviews = rv.map((r) => ({
    critic: r.cn ?? r.criticName ?? null,
    outlet: r.o ?? r.outlet ?? null,
    score: r.s ?? r.assignedScore ?? null,
    tier: r.t ?? r.tier ?? null,
    url: r.u ?? r.url ?? null,
    date: r.d ?? r.publishDate ?? null,
  }));
  return {
    criticScore: obj.cs ?? obj.criticScore ?? null,
    reviewCount: obj.rc ?? obj.reviewCount ?? reviews.length,
    reviews,
  };
}
module.exports = { decodeSlimShow };

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function localReviewsFor(showId) {
  // Read reviews.json the same way the site build does. Fall back gracefully.
  let reviews = [];
  try {
    const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');
    reviews = loadReviewsWithBlog();
  } catch (_) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'reviews.json'), 'utf8'));
      reviews = Array.isArray(raw) ? raw : raw.reviews || Object.values(raw);
    } catch (e) { return null; }
  }
  const mine = reviews.filter((r) => (r.showId || r.show) === showId);
  return {
    total: mine.length,
    scored: mine.filter((r) => r.assignedScore != null).length,
    outlets: [...new Set(mine.map((r) => r.outlet || r.outletId).filter(Boolean))].sort(),
    critics: [...new Set(mine.map((r) => r.criticName).filter(Boolean))].sort(),
  };
}

function summarizeReviews(reviews) {
  return {
    outlets: [...new Set(reviews.map((r) => r.outlet).filter(Boolean))].sort(),
    critics: [...new Set(reviews.map((r) => r.critic).filter(Boolean))].sort(),
  };
}

async function main() {
  const showId = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!showId) {
    console.error('Usage: node scripts/show-status.js <show-id> [--critic="Name"] [--local-only] [--json]');
    process.exit(2);
  }
  const criticQuery = arg('critic');
  const localOnly = hasFlag('local-only');
  const asJson = hasFlag('json');

  const local = localReviewsFor(showId);

  let prod = null, prodErr = null;
  if (!localOnly) {
    try {
      const slim = await fetchJson(`${PROD_BASE}/${showId}.json`);
      prod = decodeSlimShow(slim);
    } catch (e) { prodErr = e.message; }
  }

  const result = { showId, local, prod: prod && {
    criticScore: prod.criticScore,
    liveScoredReviews: prod.reviews.length,
    ...summarizeReviews(prod.reviews),
  }, prodError: prodErr };

  if (criticQuery) {
    const re = new RegExp(criticQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    result.criticLiveOnProd = prod ? prod.reviews.some((r) => re.test(r.critic || '') || re.test(r.outlet || '')) : null;
    result.criticInLocal = local ? local.critics.some((c) => re.test(c)) : null;
  }

  if (asJson) { console.log(JSON.stringify(result, null, 2)); return; }

  console.log(`\nShow: ${showId}`);
  if (local) {
    console.log(`  LOCAL reviews.json : ${local.total} reviews (${local.scored} scored) — ${local.outlets.length} outlets`);
  } else {
    console.log('  LOCAL reviews.json : (could not read)');
  }
  if (prod) {
    console.log(`  PROD (live site)   : ${prod.reviews.length} scored reviews live, criticScore=${prod.criticScore}`);
    // The #1 reason to use this tool: prod uses .rv, NOT .reviews — read it right.
    // Only the local-AHEAD-of-prod direction is actionable (scored locally but not
    // yet live = deploy/rebuild gap). local < prod just means this checkout's
    // reviews.json is stale, which is normal and not worth an alarm.
    if (local && local.scored > prod.reviews.length) {
      console.log(`  ⚠ NOT-LIVE: local scored=${local.scored} but prod live=${prod.reviews.length} → scored locally, not yet on site. Verify deploy: node scripts/check-prod-deploy.js HEAD`);
    }
  } else if (!localOnly) {
    console.log(`  PROD (live site)   : ERROR ${prodErr}`);
  }
  if (criticQuery) {
    console.log(`  Critic "${criticQuery}": local=${result.criticInLocal ? 'present' : 'absent'}, prod-live=${result.criticLiveOnProd ? 'YES' : 'no'}`);
  }
  console.log('');
}

// Guard so `require('./show-status')` (for decodeSlimShow) does NOT run the CLI —
// without this, importing it executes main(), which process.exit(2)s on missing args.
if (require.main === module) {
  main().catch((e) => { console.error('show-status fatal:', e.message); process.exit(1); });
}
