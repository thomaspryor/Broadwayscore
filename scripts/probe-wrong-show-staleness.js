#!/usr/bin/env node
/**
 * One-off probe for the wrongShow stale-flag audit (Notion 34e637c5-416f-8121).
 *
 * For each review-text file with wrongShow=true, computes a 3-signal show-relevance
 * score:
 *   +1 if URL slug contains >=2 distinctive title tokens (>=4 chars, non-stopword)
 *   +1 if fullText contains the show title as a phrase (case-insensitive)
 *   +1 if the critic appears in another (non-flagged) review for the same show
 *
 * Files scoring 3/3 are high-confidence stale flags. The probe writes a JSONL
 * report with per-file scores so we can manually sample 30 candidates before
 * shipping a sweep predicate.
 *
 * Usage:
 *   node scripts/probe-wrong-show-staleness.js [--out=path] [--review-texts=path]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const OUT = (args.find(a => a.startsWith('--out=')) || '').split('=')[1] ||
  path.join('/tmp', 'wrong-show-staleness-probe.jsonl');
const RT_DIR = (args.find(a => a.startsWith('--review-texts=')) || '').split('=')[1] ||
  path.join(process.env.HOME || '', 'broadway-review-texts');
const SHOWS_JSON = path.join(process.env.HOME || '', 'broadway-scorecard-data', 'shows.json');

// --- show title index ---
const showsRaw = JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8'));
const showsArr = Array.isArray(showsRaw) ? showsRaw : (showsRaw.shows || []);
const showById = Object.create(null);
for (const s of showsArr) {
  if (s && s.id) showById[s.id] = s;
}

const STOPWORDS = new Set([
  'the','a','an','of','and','or','for','to','in','on','at','with','as','by',
  'is','are','was','were','be','been','it','this','that','these','those',
  'review','musical','play','show','broadway','revival','off',
]);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !STOPWORDS.has(t));
}

function urlSlugOverlapScore(url, titleTokens) {
  if (!url || titleTokens.length === 0) return 0;
  const urlTokens = new Set(tokenize(url));
  let hits = 0;
  for (const t of titleTokens) if (urlTokens.has(t)) hits++;
  return hits;
}

function fullTextContainsTitlePhrase(fullText, title) {
  if (!fullText || !title) return false;
  const t = String(title).toLowerCase().trim();
  if (t.length < 3) return false;
  return String(fullText).toLowerCase().includes(t);
}

const showDirs = fs.readdirSync(RT_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'));

const out = fs.openSync(OUT, 'w');
const buckets = { 3: 0, 2: 0, 1: 0, 0: 0 };
let scanned = 0;
let flagged = 0;
let missingShow = 0;
const setterCounts = { rejection_reason: 0, rejected_by: 0, content_fp: 0, manual_or_unknown: 0 };

for (const d of showDirs) {
  const showId = d.name;
  const show = showById[showId];
  if (!show) {
    // count flagged files but skip — show context unavailable
  }
  const showDir = path.join(RT_DIR, showId);
  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  // First pass — build critic→hasScoredHere set from non-flagged files in this show
  const criticsWithGoodReview = new Set();
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      if (data.wrongShow === true) continue;
      if (!data.criticName) continue;
      // count if there's any scoring signal
      const hasScore = !!(
        (data.llmScore && data.llmScore.score >= 1) ||
        (data.originalScore && !data.originalScoreCleared) ||
        data.adjudicatedScore ||
        data.aggregatorStars ||
        data.assignedScore
      );
      if (hasScore) criticsWithGoodReview.add(String(data.criticName).toLowerCase().trim());
    } catch { /* ignore */ }
  }

  for (const f of files) {
    scanned++;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')); } catch { continue; }
    if (data.wrongShow !== true) continue;
    flagged++;

    // setter classification (best-effort heuristic)
    if (data.rejectionReason === 'wrong_show') setterCounts.rejection_reason++;
    else if (Array.isArray(data.rejectedBy) && data.rejectedBy.length >= 2) setterCounts.rejected_by++;
    else if (data.contentVerification && data.contentVerification.wrongArticle) setterCounts.content_fp++;
    else setterCounts.manual_or_unknown++;

    if (!show || !show.title) {
      missingShow++;
      // emit with score=0 so we can still see them
      fs.writeSync(out, JSON.stringify({
        showId, file: f, score: 0, reason: 'show-not-in-shows.json',
      }) + '\n');
      buckets[0]++;
      continue;
    }
    const titleTokens = tokenize(show.title);
    const url = data.url || data.sourceUrl || '';
    const urlOverlap = urlSlugOverlapScore(url, titleTokens);
    const urlMatch = urlOverlap >= 2 || (titleTokens.length === 1 && urlOverlap === 1);
    const titleInText = fullTextContainsTitlePhrase(data.fullText, show.title);
    const criticName = String(data.criticName || '').toLowerCase().trim();
    const criticMatch = !!criticName && criticsWithGoodReview.has(criticName);

    let score = 0;
    if (urlMatch) score++;
    if (titleInText) score++;
    if (criticMatch) score++;
    buckets[score]++;
    fs.writeSync(out, JSON.stringify({
      showId,
      showTitle: show.title,
      file: f,
      score,
      urlMatch,
      titleInText,
      criticMatch,
      url,
      criticName: data.criticName || null,
      rejectionReason: data.rejectionReason || null,
      hasFullText: !!(data.fullText && data.fullText.length > 200),
      fullTextLength: (data.fullText || '').length,
      isFullReview: data.isFullReview === true,
      contentTier: data.contentTier || null,
      manualClear: !!(data.wrongShowManualClear || data.wrongShowOverride ||
        data.wrongProductionManualClear || data.wrongProductionOverride ||
        data.humanReviewedWrongProduction === false),
    }) + '\n');
  }
}
fs.closeSync(out);

console.log(`Scanned: ${scanned} files`);
console.log(`wrongShow=true: ${flagged}`);
console.log(`Setters (best-effort):`);
for (const [k, v] of Object.entries(setterCounts)) console.log(`  ${k}: ${v}`);
console.log(`\nShow-relevance score buckets:`);
for (const k of [3, 2, 1, 0]) console.log(`  ${k}/3: ${buckets[k]}`);
console.log(`\nMissing-show (showId not in shows.json): ${missingShow}`);
console.log(`\nReport: ${OUT}`);
