#!/usr/bin/env node
/**
 * Pre-classify Video Titles via LLM
 *
 * Takes ALL video titles from discovery data and uses Claude to identify
 * which ones are likely show reviews (not just the ones with "review" in title).
 * This catches videos like "this show blew my mind" that title heuristics miss.
 *
 * Pipeline: discover-videos → PRE-CLASSIFY-TITLES → collect-transcripts → classify-reviews → score → build
 *
 * Process:
 * 1. Read discovery data for each creator
 * 2. Send ALL titles to Claude in batches: "Which of these are likely show reviews?"
 * 3. Update discovery files with llmFlagged=true for identified reviews
 *
 * Usage:
 *   node scripts/video-reviews/pre-classify-titles.js
 *   node scripts/video-reviews/pre-classify-titles.js --creator=broadwayben
 *
 * Requires: ANTHROPIC_API_KEY
 */

const fs = require('fs');
const path = require('path');
const { CLAUDE_HAIKU } = require('../lib/models');

const DISCOVERY_DIR = path.join(__dirname, '../../data/video-reviews-discovery');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

async function classifyTitleBatch(titles, creatorName, platform) {
  const list = titles.map((t, i) => `${i + 1}. [${t.duration || '?'}] ${t.title}`).join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_HAIKU,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are classifying video titles from ${creatorName}, a ${platform} theater critic/creator.

For each video, classify as:
- "review" — creator likely SAW a specific show and is sharing their opinion/reaction
- "not" — news, casting, tea/gossip, ranking list, general commentary, non-theater content

Be GENEROUS with "review" — include first preview reactions, "I just saw X", post-show thoughts, even if they don't use the word "review". The key signal is: did the creator SEE a specific show and talk about it?

Output ONLY a JSON array of the indices that are reviews: [1, 5, 12, ...]
If none are reviews, output: []

Videos:
${list}`
      }]
    })
  });

  if (!resp.ok) throw new Error(`API error ${resp.status}`);
  const data = await resp.json();
  const text = data.content[0].text;
  const match = text.match(/\[[\d,\s]*\]/);
  if (!match) return [];
  return JSON.parse(match[0]);
}

async function main() {
  const creatorFilter = process.argv.find(a => a.startsWith('--creator='))?.split('=')[1];
  const discoveryFiles = fs.readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'));

  let totalFlagged = 0;

  for (const file of discoveryFiles) {
    const filePath = path.join(DISCOVERY_DIR, file);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (creatorFilter && data.handle !== creatorFilter) continue;

    // Skip YouTube — Mickey-Jo's 300 videos are mostly review content, already well-tagged
    if (data.platform === 'youtube') {
      console.log(`\n${data.handle} (YouTube): skipping LLM pre-classification (title heuristics sufficient for YouTube)`);
      continue;
    }

    const unflagged = data.videos.filter(v => !v.isReviewCandidate && !v.llmFlagged);
    console.log(`\n=== ${data.handle}: ${unflagged.length} unclassified videos ===`);

    // Process in batches of 50
    const batchSize = 50;
    let creatorFlagged = 0;

    for (let i = 0; i < unflagged.length; i += batchSize) {
      const batch = unflagged.slice(i, i + batchSize);
      process.stdout.write(`  Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(unflagged.length / batchSize)}... `);

      try {
        const reviewIndices = await classifyTitleBatch(batch, data.handle, data.platform);

        // Flag the identified reviews in the original data
        for (const idx of reviewIndices) {
          const video = batch[idx - 1]; // 1-indexed
          if (video) {
            const origVideo = data.videos.find(v => v.id === video.id);
            if (origVideo) {
              origVideo.llmFlagged = true;
              origVideo.classification = 'llm-review-candidate';
              creatorFlagged++;
            }
          }
        }
        console.log(`${reviewIndices.length} flagged`);
      } catch (err) {
        console.log(`error: ${err.message?.substring(0, 100)}`);
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    // Save updated discovery file
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    totalFlagged += creatorFlagged;

    const totalCandidates = data.videos.filter(v => v.isReviewCandidate || v.llmFlagged).length;
    console.log(`  ${data.handle}: ${creatorFlagged} new flags → ${totalCandidates} total candidates (was ${data.videos.filter(v => v.isReviewCandidate).length})`);
  }

  console.log(`\n=== Pre-classification complete: ${totalFlagged} new review candidates flagged ===`);
}

main().catch(console.error);
