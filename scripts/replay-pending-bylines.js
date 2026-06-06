#!/usr/bin/env node
/**
 * replay-pending-bylines.js
 *
 * Files in data/review-texts/_pending/{showId}/{outlet}--{hash}.json end up there
 * when discovery returns a URL but no defaultCritic is in outlet-registry and the
 * byline wasn't detectable at write time. _pending is a HARD SINK —
 * collect-review-texts.js does NOT scan it (verified 2026-04-29).
 *
 * This replay script:
 *   1. Walks _pending/{showId}/ for each opera show (or all shows with --all)
 *   2. Fetches the URL via fetchPage
 *   3. Extracts byline via existing extractAuthorFromHtml
 *   4. If byline found: rename file to {outlet}--{critic-slug}.json, move to
 *      data/review-texts/{showId}/, remove from _pending
 *   5. If not found: leave in _pending, log
 *
 * Usage:
 *   node scripts/replay-pending-bylines.js --show=eugene-onegin-off-broadway-2026
 *   node scripts/replay-pending-bylines.js --shows=show1,show2
 *   node scripts/replay-pending-bylines.js --all-opera
 */

const fs = require('fs');
const path = require('path');
const { fetchPage } = require('./lib/scraper');
const { extractAuthorFromHtml, extractHighConfidenceAuthor } = require('./lib/content-quality');
const { normalizeCritic } = require('./lib/review-normalization');
const { isBlockedReviewUrl } = require('./lib/domain-filters');
const { verifyAggregatorUrl } = require('./lib/show-match-verifier');

// Non-theatre news sections. Same-title film articles (the Beetlejuice *film*) carry
// the show title in their <title>, so show-match passes them — but they are wrong
// PRODUCTION, not theatre reviews. NARROW to clearly-non-theatre sections only:
// outlets routinely file REAL theatre reviews under tv/music/lifestyle/books sections
// (Daily Mail /tv/, USA Today /entertainment/music/, WashPost /lifestyle/), so those
// would be false positives. Only sections a stage review never legitimately appears in.
// (ship-check 2026-06-05: the broad list + delete would have destroyed real reviews.)
const NON_THEATRE_SECTIONS = new Set([
  'film', 'films', 'movies', 'sport', 'sports', 'money', 'fashion', 'food-drink',
]);

/**
 * Reason a stranded _pending review must NOT be promoted to the main show dir,
 * or null if it's safe to promote. Pure (no I/O) so it's unit-testable.
 *   1. Aggregator / listing / ticket / feature-interview URL (isBlockedReviewUrl).
 *   2. Non-theatre news section (film/tv/lifestyle) — wrong production, same title.
 *   3. verifyAggregatorUrl show-match fails — different show.
 * @param {string} url  @param {string} html  @param {{id,title,venue,openingDate}} show
 * @returns {string|null}
 */
function pendingPromoteRejectReason(url, html, show) {
  if (isBlockedReviewUrl(url)) return 'aggregator/listing/feature URL, not an outlet review';
  let seg = [];
  try { seg = new URL(url).pathname.toLowerCase().split('/').filter(Boolean); } catch { /* malformed */ }
  const badSection = seg.find(s => NON_THEATRE_SECTIONS.has(s));
  if (badSection) return `non-theatre section (${badSection}) — wrong production`;
  const v = verifyAggregatorUrl({ url, html, show, openingDate: show && show.openingDate });
  if (!v.isValid) return `not this show (${v.rejectReason})`;
  return null;
}

const args = process.argv.slice(2);
const showArg = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const allOpera = args.includes('--all-opera');
// --all-open: drain _pending for every open/previews show (not just opera). This is the
// general-purpose drain — multi-critic outlet hits (Times/Standard/Guardian) strand in _pending
// with pendingReason:no-byline and were previously only recovered for opera shows, so 500+ real
// reviews across 70+ WE/Broadway shows sat stranded. See data/audit/we-discovery-diagnosis.md.
// --all-pending: drain EVERY show that has a _pending dir (full backlog, including closed).
const allOpen = args.includes('--all-open');
const allPending = args.includes('--all-pending');
const dryRun = args.includes('--dry-run');

const PENDING_ROOT = path.join(__dirname, '../data/review-texts/_pending');
const REVIEW_TEXTS_ROOT = path.join(__dirname, '../data/review-texts');

function listOperaShowIds() {
  const showsPath = path.join(__dirname, '../data/shows.json');
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return (data.shows || data).filter(s => s.type === 'opera').map(s => s.id);
}

// Show IDs that currently have a non-empty _pending dir.
function listShowIdsWithPending() {
  if (!fs.existsSync(PENDING_ROOT)) return [];
  return fs.readdirSync(PENDING_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .filter(id => {
      try { return fs.readdirSync(path.join(PENDING_ROOT, id)).some(f => f.endsWith('.json')); }
      catch { return false; }
    });
}

function listOpenShowIdsWithPending() {
  const showsPath = path.join(__dirname, '../data/shows.json');
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const statusById = new Map((data.shows || data).map(s => [s.id, s.status]));
  return listShowIdsWithPending().filter(id => ['open', 'previews'].includes(statusById.get(id)));
}

function showIds() {
  if (showArg) return [showArg];
  if (showsArg) return showsArg.split(',').map(s => s.trim()).filter(Boolean);
  if (allOpera) return listOperaShowIds();
  if (allOpen) return listOpenShowIdsWithPending();
  if (allPending) return listShowIdsWithPending();
  console.error('Usage: --show=ID | --shows=ID1,ID2 | --all-opera | --all-open | --all-pending');
  process.exit(1);
}

function loadShow(showId) {
  const showsPath = path.join(__dirname, '../data/shows.json');
  const data = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  return (data.shows || data).find(s => s.id === showId);
}

const NON_MET_OPERA_URL_MARKERS = require('./lib/content-filters').NON_MET_OPERA_URL_MARKERS;

async function processShow(showId) {
  const pendingDir = path.join(PENDING_ROOT, showId);
  if (!fs.existsSync(pendingDir)) {
    console.log(`[${showId}] no _pending dir`);
    return { promoted: 0, kept: 0, rejected: 0 };
  }
  const show = loadShow(showId);
  const openingYear = show?.openingDate ? new Date(show.openingDate).getFullYear() : null;
  const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'));
  console.log(`[${showId}] ${files.length} pending files to inspect (opening ${show?.openingDate || '?'})`);

  let promoted = 0, kept = 0, rejected = 0;
  for (const file of files) {
    const filepath = path.join(pendingDir, file);
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    // Already evaluated and skipped on a prior run — don't re-fetch the URL.
    if (data.promoteSkippedReason) {
      kept++;
      continue;
    }
    const url = data.url;
    if (!url) {
      console.log(`  [${file}] no URL — skip`);
      kept++;
      continue;
    }

    // Pre-promotion filters: don't bother fetching wrong-production URLs.
    if (NON_MET_OPERA_URL_MARKERS && NON_MET_OPERA_URL_MARKERS.some(m => url.toLowerCase().includes(m))) {
      console.log(`  [${file}] REJECT: non-Met opera house URL — deleting`);
      fs.unlinkSync(filepath);
      rejected++;
      continue;
    }
    if (openingYear) {
      const m = url.match(/\/((?:19|20)\d{2})\b/);
      if (m && Math.abs(parseInt(m[1], 10) - openingYear) > 1) {
        console.log(`  [${file}] REJECT: URL year ${m[1]} > ±1y from ${openingYear} — deleting`);
        fs.unlinkSync(filepath);
        rejected++;
        continue;
      }
    }

    let byline = null;
    let html = null;
    try {
      const result = await fetchPage(url);
      html = result?.content;
      if (!html) {
        console.log(`  [${file}] fetch returned no content — keep`);
        kept++;
        continue;
      }
      // Validate BEFORE promoting. _pending for open shows holds junk beyond real
      // stranded reviews (Beetlejuice exposed this 2026-06-04): aggregator URLs
      // misattributed to an outlet (a westendtheatre roundup filed under 'telegraph'
      // fabricates a fake Telegraph review with the roundup author's byline), same-title
      // wrong-production articles (the Beetlejuice *film* / a Tim Burton interview filed
      // under 'times-uk'), and wrong-show hits. Promoting these contaminates the show.
      const rejectReason = pendingPromoteRejectReason(url, html, show);
      if (rejectReason) {
        // KEEP, never delete. The URL-level checks have false positives (outlets file
        // real theatre reviews under odd sections; verifyAggregatorUrl can miss on opaque
        // slugs). Deleting was irreversible data loss (ship-check 2026-06-05). Annotate so
        // future cron runs skip it without re-fetching, and leave it in _pending for a
        // human / better tooling — promotion just doesn't happen.
        console.log(`  [${file}] SKIP (kept in _pending): ${rejectReason}`);
        data.promoteSkippedReason = rejectReason;
        data.promoteSkippedAt = new Date().toISOString();
        if (!dryRun) fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
        kept++;
        continue;
      }
      // extractHighConfidenceAuthor returns string|null; extractAuthorFromHtml returns
      // { name, source } | null. Normalize to plain string.
      const hcRaw = extractHighConfidenceAuthor(html);
      const fallbackRaw = hcRaw ? null : extractAuthorFromHtml(html, '', { outletId: data.outletId });
      const raw = hcRaw || fallbackRaw;
      byline = raw ? (typeof raw === 'string' ? raw : raw.name || null) : null;
    } catch (e) {
      console.log(`  [${file}] fetch failed: ${e.message.slice(0, 80)} — keep`);
      kept++;
      continue;
    }

    if (!byline || byline === 'Unknown') {
      console.log(`  [${file}] no byline detected — keep in pending`);
      kept++;
      continue;
    }

    // Promote: rename to {outlet}--{critic-slug}.json + move to review-texts/{showId}/
    const criticSlug = normalizeCritic(byline);
    const newFilename = `${data.outletId}--${criticSlug}.json`;
    const newPath = path.join(REVIEW_TEXTS_ROOT, showId, newFilename);

    // Don't overwrite an existing real file
    if (fs.existsSync(newPath)) {
      console.log(`  [${file}] would-be target ${newFilename} already exists — keep pending`);
      kept++;
      continue;
    }

    data.criticName = byline;
    data.bylineSource = 'replay-pending-bylines';
    data.bylineExtractedAt = new Date().toISOString();

    if (dryRun) {
      console.log(`  [${file}] DRY → would promote to ${newFilename} (byline: ${byline})`);
      promoted++;
      continue;
    }

    if (!fs.existsSync(path.dirname(newPath))) fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify(data, null, 2));
    fs.unlinkSync(filepath);
    console.log(`  [${file}] PROMOTED → ${newFilename} (byline: ${byline})`);
    promoted++;
  }

  return { promoted, kept, rejected };
}

module.exports = { pendingPromoteRejectReason, NON_THEATRE_SECTIONS };

if (require.main === module) {
  (async () => {
    const ids = showIds();
    console.log(`Processing ${ids.length} show(s)${dryRun ? ' [DRY RUN]' : ''}\n`);

    let totalPromoted = 0, totalKept = 0, totalRejected = 0;
    for (const id of ids) {
      const { promoted, kept, rejected } = await processShow(id);
      totalPromoted += promoted;
      totalKept += kept;
      totalRejected += rejected || 0;
    }

    console.log(`\n━━━ Replay complete ━━━`);
    console.log(`Promoted: ${totalPromoted}`);
    console.log(`Rejected (wrong-prod or wrong-year, deleted): ${totalRejected}`);
    console.log(`Kept in _pending: ${totalKept}`);
  })().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
