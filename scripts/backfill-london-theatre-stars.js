#!/usr/bin/env node
/**
 * backfill-london-theatre-stars.js (BRO-3139): londontheatre.co.uk review pages carry the
 * critic's star rating in embedded page data (pageContent.ourCriticsRating), never in the
 * article body, so every london-theatre review was scored by the LLM alone. The extractor
 * (extractLondonTheatreRating) now reads it at collect time; this backfills the files already
 * in the corpus by refetching each review page once (plain GET, no scraping credits).
 *
 *   node scripts/backfill-london-theatre-stars.js                 # dry run: fetch, report, write nothing
 *   node scripts/backfill-london-theatre-stars.js --apply         # write originalScore* on matching files
 *   --limit=N          stop after N files that needed a fetch (use to stay inside a run's time cap)
 *   --show=ID          one show only
 *   --concurrency=N    parallel fetches (default 3)    --delay-ms=N  pause per worker between fetches (default 600)
 *   --fixture-dir=DIR  read DIR/<last-url-segment>.html instead of the network (tests)
 *
 * Resumable: files whose originalScoreSource is already the page-data source are skipped, so a
 * second run (or a --limit chunk) picks up where the last stopped. Files with a human score,
 * and files whose page has no rating, are left alone.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { safeWriteReview } = require('./lib/review-write-guard');
const { extractLondonTheatreRating } = require('./lib/score-extractors');
const { isCandidate, applyRating } = require('./lib/london-theatre-stars-backfill');

const ARGS = process.argv.slice(2);
if (hasHelpFlag(ARGS)) {
  console.log('Usage: node scripts/backfill-london-theatre-stars.js [--apply] [--limit=N] [--show=ID] [--concurrency=N] [--delay-ms=N] [--fixture-dir=DIR]');
  process.exit(0);
}
const arg = (name, dflt) => { const a = ARGS.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const APPLY = ARGS.includes('--apply');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const SHOW = arg('show', null);
const CONCURRENCY = Math.max(1, parseInt(arg('concurrency', '3'), 10) || 3);
const DELAY_MS = Math.max(0, parseInt(arg('delay-ms', '600'), 10) || 0);
const FIXTURE_DIR = arg('fixture-dir', null);

const ROOT = resolveReviewTextsDir();


async function fetchHtml(url) {
  if (FIXTURE_DIR) {
    const slug = url.replace(/[?#].*$/, '').replace(/\/+$/, '').split('/').pop();
    const p = path.join(FIXTURE_DIR, `${slug}.html`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; BroadwayScorecardBot/1.0)' }, signal: AbortSignal.timeout(30000) });
      if (res.ok) return await res.text();
      if (res.status === 404 || res.status === 410) return null;
    } catch { /* retry once */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error('fetch failed');
}


async function main() {
  const todo = [];
  for (const showId of listShowDirs(ROOT)) {
    if (SHOW && showId !== SHOW) continue;
    const dir = path.join(ROOT, showId);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      let rec;
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (isCandidate(rec, file)) todo.push({ showId, file, p: path.join(dir, file), rec });
    }
  }
  const batch = LIMIT ? todo.slice(0, LIMIT) : todo;
  const stats = { candidates: todo.length, fetched: 0, rated: 0, noRating: 0, gone: 0, errors: 0, skipped: 0, written: 0, changedValue: 0 };
  const byStars = {};
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= batch.length) return;
      const t = batch[i];
      try {
        const html = await fetchHtml(t.rec.url);
        stats.fetched++;
        if (html == null) { stats.gone++; continue; }
        const rating = extractLondonTheatreRating(html);
        if (!rating || rating.__skipGeneric || !rating.originalScore) { stats.noRating++; continue; }
        stats.rated++;
        byStars[rating.originalScore] = (byStars[rating.originalScore] || 0) + 1;
        if (t.rec.originalScoreNormalized !== rating.normalizedScore) stats.changedValue++;
        if (APPLY) {
          // Re-read right before writing: the scan copy can be minutes old and force skips the
          // merge, so anything a concurrent job changed in between must not be overwritten.
          let fresh;
          try { fresh = JSON.parse(fs.readFileSync(t.p, 'utf8')); } catch { stats.skipped++; continue; }
          if (fresh._locked === true || !isCandidate(fresh, t.file)) { stats.skipped++; continue; }
          const r = safeWriteReview(t.p, applyRating(fresh, rating), { force: true });
          if (r && r.wrote) stats.written++;
          else console.log(`  NOT WRITTEN ${t.showId}/${t.file}: ${(r && r.skipped) || 'refused'}`);
        }
      } catch (e) {
        stats.errors++;
        console.log(`  ERROR ${t.showId}/${t.file}: ${e.message}`);
      }
      if (DELAY_MS && !FIXTURE_DIR) await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, batch.length)) }, worker));
  console.log(`\n=== londontheatre.co.uk star backfill ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===`);
  console.log(`  ${JSON.stringify(stats)}`);
  console.log(`  ratings found: ${JSON.stringify(byStars)}`);
  // fetch errors are logged and counted, not fatal: files already written stay written and the next
  // run retries the rest (it skips finished files), so a transient failure must not fail the action.
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
