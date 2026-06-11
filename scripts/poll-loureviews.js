#!/usr/bin/env node
/**
 * poll-loureviews.js — discover & ingest Louise Penn's LouReviews (loureviews.blog)
 * reviews for shows currently in our DB.
 *
 * loureviews.blog is a single-critic WordPress blog. Each review post IS one
 * review by Louise Penn. Rather than per-show API searches (800+ calls), we pull
 * her recent feed ONCE via wp-json and match titles against shows.json using the
 * pure helpers in scripts/lib/loureviews-match.js (unit-tested).
 *
 * Discovered posts are ingested as full-text review-text files (outletId
 * "loureviews", critic "Louise Penn"). They are NOT scored here — the downstream
 * llm-ensemble-score + rebuild pipeline (same as every other source) scores them
 * and its wrong-production check is the final safety net against any mis-match.
 *
 * Usage:
 *   node scripts/poll-loureviews.js [--days=45] [--since=YYYY-MM-DD] [--dry-run] [--limit=N]
 *
 * Exit 0 always (a poller failure must not red a cron); writes a summary and a
 * machine-readable count to stdout. New-file count drives the workflow's
 * score/rebuild gate.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { parseReviewPost, matchPostToShow } = require('./lib/loureviews-match');
const { extractArticleTextFromUrl, extractPublishDate } = require('./lib/article-extractor');
const { buildManualReviewFields, detectIngestCollision } = require('./lib/manual-review-fields');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');

const WP_BASE = 'https://loureviews.blog/wp-json/wp/v2/posts';
const REPO_ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(REPO_ROOT, 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(REPO_ROOT, 'data', 'review-texts');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function arg(name, dflt) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
const hasFlag = (n) => process.argv.slice(2).includes(`--${n}`);

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Compute the date floor (ISO) from --since or --days (default 45).
function dateFloor() {
  const since = arg('since');
  if (since) return `${since}T00:00:00`;
  const days = parseInt(arg('days', '45'), 10);
  // Date.now() is fine in a script (not a resumable workflow). Subtract days.
  const ms = Date.now() - days * 86400000;
  return new Date(ms).toISOString().slice(0, 19);
}

async function main() {
  const dryRun = hasFlag('dry-run');
  const limit = parseInt(arg('limit', '0'), 10) || Infinity;
  const after = dateFloor();
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;

  // Paginate the feed since the floor (oldest-first so partial runs are stable).
  let posts = [];
  for (let page = 1; page <= 10; page++) {
    const url = `${WP_BASE}?after=${encodeURIComponent(after)}&per_page=100&page=${page}&orderby=date&order=asc&_fields=id,date,link,title`;
    let batch;
    try { batch = await fetchJson(url); } catch (e) {
      if (/HTTP 400/.test(e.message)) break; // page past the end
      console.error(`feed fetch error p${page}: ${e.message}`); break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    posts = posts.concat(batch);
    if (batch.length < 100) break;
    if (page === 10) console.log('::warning:: hit 10-page (1000-post) fetch cap — a large backfill may be truncated; narrow --since or re-run.');
  }
  console.log(`Fetched ${posts.length} posts since ${after.slice(0, 10)}`);

  const summary = { matched: 0, ingested: 0, skippedExisting: 0, collisions: 0, weak: 0, errors: 0 };
  for (const p of posts) {
    if (summary.ingested >= limit) break;
    const parsed = parseReviewPost(p.title && p.title.rendered);
    if (!parsed) continue;
    const m = matchPostToShow(parsed.showTitle, shows);
    if (!m) continue;
    summary.matched++;
    const showDir = path.join(REVIEW_TEXTS_DIR, m.showId);
    const target = path.join(showDir, 'loureviews--louise-penn.json');
    if (fs.existsSync(target)) { summary.skippedExisting++; continue; }
    try {
      const html = await fetchHtml(p.link);
      const text = extractArticleTextFromUrl(html, p.link);
      if (!text || text.length < 300) { summary.weak++; console.log(`  weak-extract ${m.showId} (${text ? text.length : 0}c)`); continue; }
      const publishDate = (p.date || '').slice(0, 10) || extractPublishDate(html) || null;
      const collision = detectIngestCollision({ showDir, outletId: 'loureviews', criticName: 'Louise Penn', url: p.link, publishDate, forceClearStale: false });
      if (!collision.ok) { summary.collisions++; console.log(`  collision ${m.showId}: ${collision.reason}`); continue; }
      if (dryRun) { summary.ingested++; console.log(`  [dry] would ingest ${m.showId} <- ${parsed.showTitle} (${text.length}c, ${publishDate})`); continue; }
      const fields = buildManualReviewFields({ humanScore: null, provisional: false, fullText: text, originalScore: null, originalScoreSource: null, publishDate });
      const result = createOrMergeReviewFile(m.showId, {
        outletId: 'loureviews', outlet: 'LouReviews', criticName: 'Louise Penn',
        url: p.link, source: 'loureviews-poller', fields,
      }, { dryRun: false });
      if (result.action === 'new' || result.action === 'updated') {
        summary.ingested++;
        console.log(`  ${result.action} ${m.showId} <- ${parsed.showTitle} (${text.length}c, ${publishDate})`);
      } else { summary.skippedExisting++; }
    } catch (e) {
      summary.errors++;
      console.log(`  error ${m.showId}: ${e.message}`);
    }
  }

  console.log(`\nLouReviews poll: matched=${summary.matched} ingested=${summary.ingested} existing=${summary.skippedExisting} collisions=${summary.collisions} weak=${summary.weak} errors=${summary.errors}`);
  console.log(`__LOUREVIEWS_NEW__=${summary.ingested}`);
}

main().catch((e) => { console.error('poll-loureviews fatal:', e.stack || e.message); console.log('__LOUREVIEWS_NEW__=0'); process.exit(0); });
