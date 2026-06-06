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
 */

const fs = require('fs');
const path = require('path');
const { CLAUDE_SONNET, CLAUDE_OPUS } = require('../lib/models');

const RAW_DIR = path.join(__dirname, '../../data/video-reviews-transcripts/raw');
const CLASSIFIED_DIR = path.join(__dirname, '../../data/video-reviews-transcripts/classified');
const SHOWS_PATH = path.join(__dirname, '../../data/shows.json');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY');
  process.exit(1);
}

function getOpenBroadwayShows() {
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
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'advisor-tool-2026-03-01' },
    body: JSON.stringify({
      model: CLAUDE_SONNET,
      max_tokens: 2048,
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
  const text = data.content.find(c => c.type === 'text')?.text;
  if (!text) throw new Error(`No text block in response. Block types: ${data.content.map(c => c.type).join(', ')}`);
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
  if (start === -1) throw new Error('No JSON array in response: ' + text.substring(0, 200));
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
  if (end === -1) throw new Error('Unclosed JSON in response');
  return JSON.parse(text.substring(start, end));
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const batchSize = parseInt(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] || '5');

  if (!fs.existsSync(CLASSIFIED_DIR)) fs.mkdirSync(CLASSIFIED_DIR, { recursive: true });

  const shows = getOpenBroadwayShows();
  console.log(`Loaded ${shows.length} open/previews Broadway shows`);

  const rawFiles = fs.readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  console.log(`Found ${rawFiles.length} raw transcripts`);

  // Load all raw transcripts
  const allTranscripts = rawFiles.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(RAW_DIR, f), 'utf8'));
    return { ...data, fileName: f };
  });

  // Filter out already-classified unless --refresh
  const toClassify = refresh
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

main().catch(console.error);
