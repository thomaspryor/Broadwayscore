#!/usr/bin/env node
/**
 * Video Review Classification Script
 *
 * Reads raw transcripts and uses Claude to classify:
 * 1. Which specific Broadway show is being reviewed
 * 2. Whether it's an actual review (creator saw the show) vs commentary/news
 *
 * This is the KEY step that title-matching can't do — it reads the actual
 * transcript content to identify the show.
 *
 * Pipeline: discover-videos → collect-transcripts → classify-reviews → score-video-reviews → build-video-reviews
 *
 * Process:
 * 1. Read raw transcripts from data/video-reviews-transcripts/raw/
 * 2. Read currently-open shows from data/shows.json
 * 3. Send batches of transcripts to Claude for classification
 * 4. Output classified results to data/video-reviews-transcripts/classified/
 *
 * Usage:
 *   node scripts/video-reviews/classify-reviews.js
 *   node scripts/video-reviews/classify-reviews.js --refresh    # Re-classify all
 *   node scripts/video-reviews/classify-reviews.js --batch=10   # Batch size (default 5)
 *   node scripts/video-reviews/classify-reviews.js --rematch-only --dry-run  # list re-match candidates, no API calls
 *
 * After classifying, reviews left without a show id are re-matched (BRO-6091):
 * title + run dates against every production in shows.json (London too,
 * BRO-6095), confirmed by
 * the model. Re-runs each week, so a show added to shows.json later still
 * picks up the reviews posted during its run.
 */

const fs = require('fs');
const path = require('path');
const { CLAUDE_SONNET, CLAUDE_OPUS } = require('../lib/models');
const { finalResponseText, describeResponse } = require('../lib/anthropic-response-text');
const { indexShowsByTitle, rematchCandidates, parseRematchReply } = require('../lib/video-review-selection');
const { describeProduction } = require('../lib/video-production-context');
const { creatorLookup } = require('../lib/video-review-guards');

const RAW_DIR = path.join(__dirname, '../../data/video-reviews-transcripts/raw');
const CLASSIFIED_DIR = path.join(__dirname, '../../data/video-reviews-transcripts/classified');
const SHOWS_PATH = path.join(__dirname, '../../data/shows.json');
const CREATORS_PATH = path.join(__dirname, '../../data/video-creators.json');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
if (!ANTHROPIC_API_KEY && !DRY_RUN) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

function getOpenBroadwayShows() {
  if (!fs.existsSync(SHOWS_PATH)) {
    console.error(`Missing ${SHOWS_PATH} — data/shows.json is private core data; in CI the workflow must run .github/actions/checkout-core-data first.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  // Include open/previews shows plus closed shows from the last 3 seasons
  // (June 2023 onward) so transcripts can be matched to historical productions.
  // West End shows are excluded — video creators in the registry are US-centric.
  const historyCutoff = new Date('2023-06-01');
  return data.shows
    .filter(s => {
      if (!s || !s.title) return false;
      if (s.id.includes('west-end')) return false;
      if (s.status === 'open' || s.status === 'previews') return true;
      if (s.status === 'closed' && s.openingDate && new Date(s.openingDate) >= historyCutoff) return true;
      return false;
    })
    .map(s => ({ id: s.id, title: s.title, category: s.category || 'broadway' }));
}

async function classifyBatch(transcripts, showList) {
  const showNames = showList.map(s => `${s.title} (${s.id})`).join(', ');

  // Include a 1200-char snippet. Short TikTok vlogs often structure as
  // "before the show ... after the show" — a 400-char snippet only captures
  // the pre-show part and misclassifies legit reviews as non-attended.
  const items = transcripts.map((t, i) =>
    `[${i + 1}] Creator: ${t.creatorId} | Title: "${t.title}" | ${t.wordCount}w\nTranscript (first 1200 chars): ${t.transcript.substring(0, 1200)}`
  ).join('\n\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(300000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'advisor-tool-2026-03-01' },
    body: JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 2048,
      // Do NOT add cache_control to this request: the advisor tool makes the
      // cache prefix non-byte-stable (2026-07-26 probe on the sibling caller
      // classify-non-reviews.js) — a breakpoint pays the 1.25x write premium
      // on every call and never hits.
      tools: [{ type: 'advisor_20260301', name: 'advisor', model: CLAUDE_OPUS, max_uses: 1 }],
      messages: [{
        role: 'user',
        content: `Classify these video transcripts. For each, determine:
1. Which specific Broadway/West End STAGE production is being reviewed (must be from this list: ${showNames})
2. Type: "review" | "commentary" | "roundup" | "other"
3. If it's a review, did the creator clearly see THIS stage production?

Type definitions — we only score first-hand opinions about live stage productions:

- **review**: Creator is sharing their OPINION about a specific live stage production in this list. Accept:
  - Past-tense attendance ("I saw", "we went to", "after the show")
  - Before-and-after vlog structure ("this is us before... this is us after... 10/10")
  - Present-tense review/summary style ("X is the kind of play that...", "this is brilliant on every level")
  - First-preview reaction videos (attended = still counts)

  Require an OPINION about the production itself (acting, direction, writing, experience). A show summary alone is a review only if it leads to recommendation/critique.

- **commentary**: Casting news, anticipation, cast announcements, show announcements, OR reactions to news/closure/controversy about a show the creator has NOT personally reviewed. Discussion without first-hand opinion on the production. Set showId if clear.

- **roundup**: List of 3+ shows with no single focus ("here are the shows I've seen", "top 10 Broadway", "shows coming to NYC", "my favorites from 2025"). Brief mention in a list is not a review. Set showId=null.

- **other**: Catch-all. Includes:
  - FILM/MOVIE reviews of stage adaptations (Wicked 2024 movie, West Side Story movies) — set showId=null. We don't score films even when the stage version is in the list.
  - Reply-to-comments or follow-up videos — primary purpose is responding to prior video's reaction, not reviewing the show ("replying to @...", "since my last video", "a lot of you were mad about...", "people in the comments said...")
  - Non-theater content

Output JSON array:
[{"index": 1, "showId": "show-id-here" or null, "showTitle": "title", "type": "review"|"commentary"|"roundup"|"other", "confidence": "high"|"medium"|"low", "reason": "brief explanation"}]

If a transcript covers 2 shows, pick the PRIMARY show being reviewed. 3+ shows = roundup. If it doesn't match any show on the list, set showId to null.

Transcripts:

${items}`
      }]
    })
  });

  if (!resp.ok) throw new Error(`API error ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  const text = finalResponseText(data.content);
  if (!text) throw new Error(`No text block in response (${describeResponse(data)})`);
  // Find the outermost JSON array. Walk to the first '[' that's followed
  // (after optional whitespace) by '{' — that's the object-array opener.
  // Tolerates markdown code fences (```json\n[\n  {...) and stray "[foo]"
  // tokens that can appear inside reason text.
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '{') { start = i; break; }
  }
  if (start === -1) throw new Error(`No JSON array in response (${describeResponse(data)}): ` + text.substring(0, 200));
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error(`Unclosed JSON in response (${describeResponse(data)})`);
  return JSON.parse(text.substring(start, end));
}

async function confirmRematch(c, candidates, homeMarket) {
  const options = candidates.map((s, i) => `${i + 1}. ${describeProduction(s)}`).join('\n');
  // BRO-6095: London and New York runs of one title can overlap, and creators
  // rarely name their own city in a review. Only a London-vs-elsewhere
  // tie-break: creators travel, so with one candidate the home market is no
  // evidence against it (Kate Reinking, Denver, reviewed The Witches in London).
  const isLondon = s => s.category === 'west-end' || s.category === 'off-west-end';
  const splitsLondon = candidates.some(isLondon) && candidates.some(s => !isLondon(s));
  const home = homeMarket && splitsLondon
    ? `\nThe creator is based in ${homeMarket}. If both a London and a non-London production fit and the video names no city or venue, prefer the one in ${homeMarket}; a named city or venue always wins.\n`
    : '';
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    signal: AbortSignal.timeout(120000),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `A theater creator's video review was classified as a review of "${c.showTitle}" (classifier note: ${c.classificationReason || 'none'}).
Posted: ${c.date}. Caption: "${c.title}"
${home}
Which of these stage productions did the creator see and review in this video?
${options}

Answer 0 when the video is about a different show whose title only resembles a listed one, or another production of the same title: a different city or venue than the one listed, a tour when only a New York run is listed (or the reverse), a regional, community, school, workshop or reading staging, a concert staging when the listed production is not one (Encores! is one), or the film. Pick a number only when the transcript and caption fit that production's city, venue or tour and its dates.

Transcript (first 1500 chars): ${String(c.transcript || '').substring(0, 1500)}

Output ONLY JSON: {"match": <number or 0>, "reason": "<one short sentence>"}`,
      }],
    }),
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  return parseRematchReply(finalResponseText(data.content), candidates);
}

/**
 * BRO-6091: reviews the classifier could not tie to a show. Re-matched by title
 * and run dates against all of shows.json, then confirmed by the model. A
 * classified file records the candidates it was checked against, so it is
 * only asked again when shows.json gains a matching production.
 */
async function rematchUnmatched() {
  if (!fs.existsSync(SHOWS_PATH)) {
    console.error(`Missing ${SHOWS_PATH}; skipping re-match.`);
    return;
  }
  const byTitle = indexShowsByTitle(JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows);
  const findCreator = creatorLookup(JSON.parse(fs.readFileSync(CREATORS_PATH, 'utf8')).creators);
  const files = fs.readdirSync(CLASSIFIED_DIR).filter(f => f.endsWith('.json'));
  let checked = 0, matched = 0;
  console.log('\n=== Re-matching reviews with no show ===');
  for (const f of files) {
    const filePath = path.join(CLASSIFIED_DIR, f);
    const c = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (c.reviewType !== 'review' || c.showId) continue;
    const candidates = rematchCandidates(c, byTitle);
    if (!candidates.length) continue;
    const ids = candidates.map(s => s.id);
    if (c.rematch && c.rematch.candidates?.join(',') === ids.join(',')) continue;
    checked++;
    if (DRY_RUN) {
      console.log(`  ${c.creatorId} ${c.date} "${c.showTitle}" -> ${ids.join(' | ')}`);
      continue;
    }
    try {
      const r = await confirmRematch(c, candidates, findCreator(c.creatorId)?.homeMarket);
      if (!r.ok) { console.log(`  ? ${c.creatorId} "${c.showTitle}": unparseable reply, retry next run`); continue; }
      c.rematch = { candidates: ids, result: r.show ? r.show.id : null, reason: r.reason, checkedAt: new Date().toISOString() };
      if (r.show) {
        c.showId = r.show.id;
        c.showTitle = r.show.title;
        c.showIdSource = 'rematch';
        matched++;
      }
      fs.writeFileSync(filePath, JSON.stringify(c, null, 2));
      console.log(`  ${r.show ? '✓' : '✗'} ${c.creatorId} ${c.date} "${c.showTitle}" -> ${r.show ? r.show.id : 'none'} (${r.reason})`);
    } catch (err) {
      console.error(`  Error re-matching ${f}: ${err.message?.substring(0, 200)}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`Re-match: ${checked} checked, ${matched} matched${DRY_RUN ? ' (dry run)' : ''}`);
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const rematchOnly = process.argv.includes('--rematch-only');
  const batchSize = parseInt(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] || '5');

  if (!fs.existsSync(CLASSIFIED_DIR)) fs.mkdirSync(CLASSIFIED_DIR, { recursive: true });

  const shows = rematchOnly ? [] : getOpenBroadwayShows();
  if (!rematchOnly) console.log(`Loaded ${shows.length} open/previews Broadway shows`);

  const rawFiles = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  console.log(`Found ${rawFiles.length} raw transcripts`);

  // Load all raw transcripts
  const allTranscripts = rawFiles.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), 'utf8'));
    return { ...data, fileName: f };
  });

  // Filter out already-classified unless --refresh
  const toClassify = rematchOnly ? []
    : refresh
    ? allTranscripts
    : allTranscripts.filter(t => !fs.existsSync(path.join(CLASSIFIED_DIR, t.fileName)));

  console.log(`Need to classify: ${toClassify.length} (${allTranscripts.length - toClassify.length} already done)`);

  // Process in batches
  let reviewsFound = 0;
  for (let i = 0; i < toClassify.length; i += batchSize) {
    const batch = toClassify.slice(i, i + batchSize);
    console.log(`\nBatch ${Math.floor(i / batchSize) + 1}/${Math.ceil(toClassify.length / batchSize)} (${batch.length} transcripts)...`);

    try {
      const results = await classifyBatch(batch, shows);

      for (let j = 0; j < results.length && j < batch.length; j++) {
        const classification = results[j];
        const transcript = batch[j];

        const classified = {
          ...transcript,
          showId: classification.showId,
          showTitle: classification.showTitle,
          reviewType: classification.type,
          classificationConfidence: classification.confidence,
          classificationReason: classification.reason,
          classifiedAt: new Date().toISOString()
        };

        fs.writeFileSync(path.join(CLASSIFIED_DIR, transcript.fileName), JSON.stringify(classified, null, 2));

        const icon = classification.type === 'review' ? '✓' : classification.type === 'commentary' ? '~' : '✗';
        console.log(`  ${icon} ${transcript.creatorId}: ${classification.showTitle || 'unknown'} (${classification.type}, ${classification.confidence})`);

        if (classification.type === 'review' && classification.showId) reviewsFound++;
      }
    } catch (err) {
      console.error(`  Batch error:`, err.message?.substring(0, 200));
    }

    // Rate limit between batches
    if (i + batchSize < toClassify.length) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  await rematchUnmatched();

  // Summary
  console.log('\n=== Classification Summary ===');
  const classifiedFiles = fs.readdirSync(CLASSIFIED_DIR).filter(f => f.endsWith('.json'));
  const byType = { review: 0, commentary: 0, other: 0 };
  const byShow = {};

  for (const f of classifiedFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(CLASSIFIED_DIR, f), 'utf8'));
    byType[data.reviewType] = (byType[data.reviewType] || 0) + 1;
    if (data.reviewType === 'review' && data.showId) {
      if (!byShow[data.showId]) byShow[data.showId] = [];
      byShow[data.showId].push(data.creatorId);
    }
  }

  console.log(`Reviews: ${byType.review}, Commentary: ${byType.commentary}, Other: ${byType.other}`);
  console.log('\nShows with video reviews:');
  const sorted = Object.entries(byShow).sort((a, b) => b[1].length - a[1].length);
  for (const [showId, creators] of sorted) {
    console.log(`  ${showId}: ${creators.length} reviews (${creators.join(', ')})`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
