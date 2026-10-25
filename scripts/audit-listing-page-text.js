#!/usr/bin/env node
'use strict';
/**
 * audit-listing-page-text.js: read-only. Find review-text files whose fullText
 * is a listing, search or tag-archive page instead of one review (BRO-5375:
 * a BroadwayBlog search-results page was scored 87 and shown on the site).
 *
 * Signals, per file:
 *   header   the text opens with a listing header (content-quality
 *            detectListingPageText: "You searched for", "Posts tagged", ...)
 *   readmore 3+ "Read more" / "Continue reading" links
 *   dated    4+ distinct "Month D, YYYY" dates AND 2+ read-more links
 *            (several posts, each with its own date)
 * Skips files the rebuild already excludes (review-guards isIncludableForRebuild). Prints show/file, outlet, critic, score,
 * signals; never the text.
 *
 *   node scripts/audit-listing-page-text.js [--show=a,b] [--json]
 */
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { exitOnHelp } = require('./lib/cli-help.js');
exitOnHelp(module);
const { detectListingPageText } = require('./lib/content-quality');

const ARGS = process.argv.slice(2);
const val = (n) => { const a = ARGS.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3).split(',') : null; };
const ROOT = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');

const READ_MORE_RE = /\b(read\s+more|continue\s+reading|read\s+the\s+full\s+(review|post|article))\b/gi;
const DATE_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+(19|20)\d{2}\b/g;

function listingSignals(text) {
  const t = typeof text === 'string' ? text : '';
  const signals = [];
  const head = detectListingPageText(t);
  if (head.detected) signals.push(`header:${head.match.trim()}`);
  const readMore = (t.match(READ_MORE_RE) || []).length;
  if (readMore >= 3) signals.push(`readmore:${readMore}`);
  const dates = new Set(t.match(DATE_RE) || []);
  if (dates.size >= 4 && readMore >= 2) signals.push(`dated:${dates.size}`);
  return signals;
}

// The site's own inclusion rule. A shortcut on contentTier missed the
// BroadwayBlog search page: tier 'invalid', yet an aggregator excerpt kept it
// live at 87. Rows whose show is unknown here are scanned (fail open: this is
// read-only).
let _shows = null;
function excluded(r, show, filePath) {
  if (!_shows) {
    _shows = new Map();
    try {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
      for (const s of (d.shows || d)) if (s && s.id) _shows.set(s.id, s);
    } catch { /* no shows.json: scan everything */ }
  }
  const meta = _shows.get(show);
  if (!meta) return false;
  try {
    return !require('./lib/review-guards').isIncludableForRebuild(r, meta, filePath);
  } catch {
    return false;
  }
}

function main() {
  if (!fs.existsSync(ROOT)) { console.error('data/review-texts missing'); process.exit(3); }
  const only = val('show');
  const shows = only || fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  const hits = [];
  let scanned = 0;
  for (const show of shows) {
    const dir = path.join(ROOT, show);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!isReviewTextFile(f)) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (!r.fullText || excluded(r, show, path.join(dir, f))) continue;
      scanned++;
      const signals = listingSignals(r.fullText);
      if (signals.length) {
        hits.push({ file: `${show}/${f}`, outletId: r.outletId, critic: r.criticName, score: r.assignedScore ?? null, tier: r.contentTier, url: r.url || null, signals });
      }
    }
  }
  if (ARGS.includes('--json')) { console.log(JSON.stringify({ scanned, hits }, null, 2)); return; }
  console.log(`Scanned ${scanned} included files with text; ${hits.length} look like listing/search pages.`);
  for (const h of hits) console.log(`${h.file} | ${h.outletId} | ${h.critic} | score ${h.score} | ${h.tier} | ${h.signals.join(' ')} | ${h.url || '-'}`);
}

if (require.main === module) main();
module.exports = { listingSignals };
