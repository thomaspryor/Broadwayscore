#!/usr/bin/env node
/**
 * repair-page-bleed.js — re-extract stored review texts that have other
 * articles glued onto them, now that the extractor is fixed (BRO-4977).
 *
 * Times Square Chronicles (t2conline.com, Zox News theme) auto-loads the next
 * stories inside the same <article>, and the collector kept them: 66 of 102
 * stored T2C reviews carried 2-6 other articles, and Soon's live pull quote
 * praised an actor in a different show. The extractors now take the body
 * container only (extractZoxNewsBody / dom-article-extractor). This refetches
 * each affected review, re-extracts it, and replaces fullText ONLY when the
 * new body is provably the same article minus the tail (checkBleedTrim), then
 * queues a rescore (the score and pull quote were computed on the glued text).
 *
 * Usage:
 *   node scripts/repair-page-bleed.js [--host=t2conline.com] [--show=ID]
 *        [--limit=N] [--apply]
 * Dry run by default. Skips excluded files (wrongShow / wrongProduction /
 * duplicateOf) and files already repaired. Idempotent.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const { safeWriteReview } = require('./lib/review-write-guard');
const { fetchPage } = require('./lib/scraper');
const { extractArticleText } = require('./lib/article-extractor');
const { cleanText } = require('./lib/text-cleaning');
const { checkBleedTrim, applyBleedTrim } = require('./lib/page-bleed-repair');

const USAGE = `repair-page-bleed.js — re-extract stored review texts with other articles glued on (BRO-4977).

Usage:
  node scripts/repair-page-bleed.js [--host=t2conline.com] [--show=ID] [--limit=N] [--budget-sec=210] [--apply]
  node scripts/repair-page-bleed.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

const arg = (name) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};
const APPLY = process.argv.includes('--apply');
const HOST = (arg('host') || 't2conline.com').toLowerCase();
const ONLY_SHOW = arg('show');
const LIMIT = Number(arg('limit') || 0);
const CONCURRENCY = 4;
const BUDGET_MS = Number(arg('budget-sec') || 210) * 1000;
const DIR = path.join(__dirname, '..', 'data', 'review-texts');

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function candidates() {
  const out = [];
  const shows = ONLY_SHOW ? [ONLY_SHOW] : listShowDirs(DIR);
  for (const showId of shows) {
    const showDir = path.join(DIR, showId);
    if (!fs.existsSync(showDir)) continue;
    for (const f of fs.readdirSync(showDir).filter(x => x.endsWith('.json'))) {
      const file = path.join(showDir, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (hostOf(d.url) !== HOST || !d.fullText) continue;
      if (d.wrongShow || d.wrongProduction || d.duplicateOf || d._locked) continue;
      if (d.pageBleedRepair) continue;
      out.push({ file, showId, d });
    }
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

async function main() {
  const list = candidates();
  console.log(`${list.length} stored ${HOST} review(s) to check${APPLY ? '' : ' (dry run)'}`);
  const tally = { trimmed: 0, unchanged: 0, refused: 0, fetchFailed: 0 };
  // execute-approved-fix.js gives a run-script 5 minutes; fetch a few at once.
  // Stop starting new fetches before the runner's kill; the rest are picked up
  // by the next run (repaired files are skipped), so a plan just lists this
  // script more than once.
  const startedAt = Date.now();
  const queue = list.slice();
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      if (Date.now() - startedAt > BUDGET_MS) { tally.deferred = queue.length; queue.length = 0; break; }
      await repairOne(queue.shift(), tally);
    }
  });
  await Promise.all(workers);
  console.log(`\n${APPLY ? 'Trimmed' : 'Would trim'} ${tally.trimmed}; no tail ${tally.unchanged}; refused ${tally.refused}; fetch failed ${tally.fetchFailed}${tally.deferred ? `; ${tally.deferred} left for the next run (time budget)` : ''}`);
}

async function repairOne({ file, showId, d }, tally) {
  {
    const rel = `${showId}/${path.basename(file)}`;
    let page;
    try {
      page = await fetchPage(d.url);
    } catch (e) {
      tally.fetchFailed++;
      console.log(`  ✗ ${rel}: fetch failed (${(e.message || '').slice(0, 80)})`);
      return;
    }
    if (!page || page.format !== 'html' || !page.content) {
      tally.fetchFailed++;
      console.log(`  ✗ ${rel}: no html (${page && page.format})`);
      return;
    }
    const raw = extractArticleText(page.content, HOST);
    const newText = raw ? cleanText(raw) : '';
    // The author box opens the glued part: critic name or outlet name.
    const critic = /^unknown$/i.test(d.criticName || '') ? '' : (d.criticName || '');
    const tailMarkers = [...critic.split(/\s+/), d.outlet || '', 'T2C'].filter(m => m.length >= 3);
    const verdict = checkBleedTrim(d, newText, { tailMarkers });
    if (!verdict.ok) {
      if (verdict.reason === 'stored text has no tail to trim') tally.unchanged++;
      else tally.refused++;
      console.log(`  · ${rel}: kept (${verdict.reason}; stored ${d.fullText.length}, new ${newText.length})`);
      return;
    }
    if (!APPLY) {
      tally.trimmed++;
      console.log(`  ✓ ${rel}: ${d.fullText.length} → ${newText.length} chars (would trim)`);
      return;
    }
    const res = safeWriteReview(file, applyBleedTrim(d, newText, { source: page.source }), { force: true });
    if (res && res.wrote === false) {
      tally.refused++;
      console.log(`  ✗ ${rel}: write refused (${res.skipped || res.reason || 'guard'})`);
      return;
    }
    tally.trimmed++;
    // The write guard's wrong-article screen runs on the new text; say so if
    // it flagged the trimmed body (the old show mention was in the tail).
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const flag = after.wrongShow && !d.wrongShow ? ' — write guard flagged wrongShow, check by hand' : '';
    console.log(`  ✓ ${rel}: ${d.fullText.length} → ${newText.length} chars${flag}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
