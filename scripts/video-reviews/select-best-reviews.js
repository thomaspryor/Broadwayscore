#!/usr/bin/env node
/**
 * Select Best Review Per Creator Per Show
 *
 * When a creator has multiple videos about the same show, picks the one that
 * is their review of it (BRO-6091):
 * 1. Must have 100+ word transcript
 * 2. Must be posted during the production's run (from a week before first
 *    preview to two weeks after closing). Earlier = another production or
 *    anticipation; much later = a retrospective.
 * 3. Skips videos that already dead-ended for this show: rejected by scoring,
 *    flagged as another production by verify-productions.js, or paid promotion.
 *    The per-show file keeps them in excludedVideoIds.
 * 4. One candidate: that one. Several: Claude reads the captions and
 *    transcript excerpts and picks the creator's main standalone review (not a
 *    revisit, reply, clip or news reaction). Without an API key or on an API
 *    error: keep the current pick if it is still a candidate, else the
 *    creator's first full-length review, else the longest.
 * 5. A Claude or single-candidate pick is cached with its candidate set
 *    (selection.candidateKey) and only re-picked when a video is added or
 *    excluded; a fallback pick is re-asked next run.
 * 6. A replaced pick that is on the site rides along as previousPick and stays
 *    published until the new pick scores and passes verification.
 * It used to take the video closest to opening night, which picked a
 * 422-word song clip over Kate Reinking's 1,230-word Tammy Faye review.
 *
 * Pipeline: discover → pre-classify → collect → classify → SELECT-BEST → score → build
 *
 * Usage:
 *   node scripts/video-reviews/select-best-reviews.js
 *   node scripts/video-reviews/select-best-reviews.js --show=chess-2025
 *   node scripts/video-reviews/select-best-reviews.js --dry-run   # report picks, write nothing
 *   node scripts/video-reviews/select-best-reviews.js --dry-run --sample=5   # also ask the picker for 5 groups
 */

const fs = require('fs');
const path = require('path');
const { CLAUDE_SONNET } = require('../lib/models');
const { finalResponseText } = require('../lib/anthropic-response-text');
const {
  MIN_WORDS, isDeadEnd, selectionCandidates, planSelection, fallbackPick, nextSelectedRecord, transcriptExcerpt, parsePickerReply,
} = require('../lib/video-review-selection');
const { describeProduction } = require('../lib/video-production-context');

const CLASSIFIED_DIR = path.join(__dirname, '../../data/video-reviews-transcripts/classified');
const SHOW_DIR = path.join(__dirname, '../../data/video-reviews-transcripts');
const SHOWS_PATH = path.join(__dirname, '../../data/shows.json');
const CREATORS_PATH = path.join(__dirname, '../../data/video-creators.json');
const THUMB_DIR = path.join(__dirname, '../../public/images/video-reviews');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
// --dry-run --sample=N: ask the picker for the first N multi-video groups, still writing nothing.
const SAMPLE = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] || '0', 10);
let sampled = 0;

// Cache shows data
let _showsCache = null;
function getShowData(showId) {
  if (!_showsCache) {
    // Missing shows.json must be fatal: with an empty cache every review's
    // date sanity-check silently degrades and CI publishes nothing while
    // reporting success (root cause of the 2026-04→07 no-op runs).
    if (!fs.existsSync(SHOWS_PATH)) {
      console.error(`Missing ${SHOWS_PATH} — data/shows.json is private core data; in CI the workflow must run .github/actions/checkout-core-data first.`);
      process.exit(1);
    }
    _showsCache = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  }
  return _showsCache.find(s => s && s.id === showId) || null;
}

async function llmPick(show, creatorName, candidates) {
  const list = candidates.map((c, i) =>
    `[${i + 1}] posted ${c.date || 'unknown'} | ${c.wordCount} words | caption: "${c.title}"\n${transcriptExcerpt(c.transcript)}`
  ).join('\n\n');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(180000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `${creatorName} posted several videos about this stage production: ${describeProduction(show)}.

We show ONE video per creator per production: their review of it. Pick the video that is the creator's main, standalone review: they saw the show and give their overall verdict on it.

Not the review: a reply to comments ("Replying to @..."), a follow-up on what changed since their review, a repeat visit centered on a cast change, understudy or debut, a seating or ticket guide, a clip of one song or moment, a reaction to news, awards or the cast album, or a video mostly about another show.

If more than one is a full review, prefer the creator's first full review after seeing the show. Prefer a later one only when it is clearly the more complete verdict (for example the first was a short first-preview reaction and the later one is the full review).

Videos (excerpt = opening ... closing of the transcript):

${list}

Output ONLY JSON: {"pick": <video number>, "reason": "<one short sentence>"}`,
      }],
    }),
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  return parsePickerReply(finalResponseText(data.content), candidates);
}

async function main() {
  const showFilter = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];

  if (!fs.existsSync(CLASSIFIED_DIR)) {
    console.error('No classified directory found');
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) console.log('No ANTHROPIC_API_KEY: multi-video groups keep their pick or use the first full-length review.');

  const creators = JSON.parse(fs.readFileSync(CREATORS_PATH, 'utf8')).creators;
  const creatorNames = Object.fromEntries(creators.map(c => [c.id.toLowerCase(), c.name]));

  const files = fs.readdirSync(CLASSIFIED_DIR).filter(f => f.endsWith('.json'));

  // Group by showId + creatorId
  const groups = {};
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(CLASSIFIED_DIR, f), 'utf8'));
    if (d.reviewType !== 'review' || !d.showId || d.wordCount < MIN_WORDS) continue;
    if (showFilter && d.showId !== showFilter) continue;

    const key = `${d.showId}/${d.creatorId}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push({ file: f, ...d });
  }

  const stats = { written: 0, restamped: 0, unchanged: 0, llm: 0, fallback: 0, deadEnds: 0, empty: 0 };

  for (const [key, allCandidates] of Object.entries(groups)) {
    const [showId, creatorId] = key.split('/');
    const showDir = path.join(SHOW_DIR, showId);
    const show = getShowData(showId);
    const outFile = path.join(showDir, `${creatorId}.json`);
    const existing = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;

    const excluded = new Set(existing?.excludedVideoIds || []);
    if (existing && isDeadEnd(existing, show) && existing.videoId) excluded.add(existing.videoId);

    const candidates = selectionCandidates(allCandidates, show, excluded);
    const plan = planSelection(existing, candidates, show);
    if (plan.action === 'none') {
      if (existing && isDeadEnd(existing, show)) stats.empty++;
      continue;
    }
    if (plan.action === 'unchanged') { stats.unchanged++; continue; }

    let best, method, reason = '';
    if (plan.action === 'pick') {
      ({ pick: best, method } = plan);
    } else {
      let picked = null;
      if (ANTHROPIC_API_KEY && (!DRY_RUN || sampled < SAMPLE)) {
        sampled++;
        try {
          picked = await llmPick(show || { title: showId }, creatorNames[creatorId.toLowerCase()] || creatorId, candidates);
          if (!picked) console.log(`  ${key}: unparseable picker reply`);
        } catch (err) {
          console.error(`  ${key}: picker error ${err.message?.substring(0, 150)}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
      if (picked) {
        best = picked.pick; method = 'llm'; reason = picked.reason; stats.llm++;
      } else {
        ({ pick: best, method } = fallbackPick(existing, candidates, plan.existingValid)); stats.fallback++;
      }
    }

    const selection = { method, candidateKey: plan.candidateKey, ...(reason && { reason }), at: new Date().toISOString() };
    const excludedVideoIds = [...excluded].sort();
    const deadEnd = !!existing && isDeadEnd(existing, show);
    const changed = !existing || existing.videoId !== best.videoId || deadEnd;
    if (deadEnd) stats.deadEnds++;
    if (changed || candidates.length > 1) {
      console.log(`  ${key}: ${candidates.length} candidate(s) → ${best.videoId} ${best.date || ''} ${best.wordCount}w [${method}]${changed && existing ? ` (was ${existing.videoId})` : ''}${reason ? ` — ${reason}` : ''}`);
    }
    if (DRY_RUN) { if (changed) stats.written++; continue; }
    if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });

    if (!changed) {
      // Same video: keep its score, record the selection (unless nothing but the time changed).
      const prev = existing.selection;
      if (prev && prev.method === method && prev.candidateKey === plan.candidateKey
        && JSON.stringify(existing.excludedVideoIds || []) === JSON.stringify(excludedVideoIds)) { stats.unchanged++; continue; }
      fs.writeFileSync(outFile, JSON.stringify({ ...existing, excludedVideoIds, selection }, null, 2));
      stats.restamped++;
      continue;
    }

    const { record, deleteThumbnail } = nextSelectedRecord(existing, best, { excludedVideoIds, selection });
    fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
    stats.written++;
    // backfill-thumbnails.js reuses any image already at this path, which
    // would show the old video's thumbnail on the new pick. A published
    // previous pick keeps its image until build-video-reviews.js retires it.
    const oldThumb = path.join(THUMB_DIR, `${creatorId}-${showId}.jpg`);
    if (deleteThumbnail && fs.existsSync(oldThumb)) fs.unlinkSync(oldThumb);
  }

  console.log(`\nSelection: ${stats.written} new picks${DRY_RUN ? ' would be' : ''} to score (${stats.deadEnds} replacing dead ends), ${stats.restamped} same pick re-stamped, ${stats.unchanged} unchanged; ${stats.llm} picked by Claude, ${stats.fallback} by fallback; ${stats.empty} dead ends with no other video${DRY_RUN ? ' (dry run)' : ''}`);
}

main().catch(e => { console.error(e); process.exit(1); });
