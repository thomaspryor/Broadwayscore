#!/usr/bin/env node
/**
 * audit-pull-quote-other-show.js (BRO-8326): lists stored llmPullQuote values that
 * sit in another show's part of the article (Village Voice's paragraph on The Price
 * shown on Come From Away) or in a news column's lede ahead of the show's blurb
 * (Out Magazine). The rebuild already drops these (Layer 0b) and the extractor
 * re-extracts them, so a hit here means a stored value waiting on that re-extraction.
 *
 *   node scripts/audit-pull-quote-other-show.js [--show=ID] [--max=N]
 *
 * Exit: 0 report / under --max, 1 over --max, 2 corpus missing.
 * Rules and measured hit rate (12 of 50,375 on 2026-11-25): scripts/lib/pull-quote-other-show.js.
 */
const fs = require('fs');
const path = require('path');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { listShowDirs } = require('./lib/list-show-dirs');
const { quoteInOtherShowPassage, buildEvidenceIndex } = require('./lib/pull-quote-other-show');

const RT = resolveReviewTextsDir();
if (!RT || !fs.existsSync(RT)) { console.error(`review-texts dir not found: ${RT}`); process.exit(2); }

const arg = (k) => (process.argv.slice(2).find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const only = arg('show');
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
const shows = Array.isArray(raw) ? raw : (raw.shows || Object.values(raw));
const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
const index = buildEvidenceIndex(shows);

let scanned = 0;
const hits = [];
for (const showId of listShowDirs(RT)) {
  if (showId.startsWith('_') || !byId[showId] || (only && showId !== only)) continue;
  const dir = path.join(RT, showId);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!d.llmPullQuote || typeof d.fullText !== 'string' || d.wrongProduction || d.wrongShow || d.duplicateOf) continue;
    scanned++;
    const r = quoteInOtherShowPassage(d.llmPullQuote, d, byId[showId], index);
    if (r) hits.push({ showId, f, ...r, q: d.llmPullQuote });
  }
}
for (const h of hits) console.log(`${h.showId}/${h.f}\n  ${h.rule}: ${h.detail}\n  quote: ${h.q.slice(0, 100)}`);
console.log(`[audit-pull-quote-other-show] ${hits.length} stored quote(s) in another show's passage, of ${scanned} scanned`);
const maxArg = arg('max');
if (maxArg !== '') {
  const max = Number(maxArg);
  if (!Number.isFinite(max)) { console.error(`bad --max=${maxArg}`); process.exit(2); }
  if (hits.length > max) { console.log(`[audit-pull-quote-other-show] DRIFT: ${hits.length} > --max=${max}`); process.exitCode = 1; }
}
