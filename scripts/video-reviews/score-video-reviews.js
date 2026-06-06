#!/usr/bin/env node
/**
 * Score video review transcripts using Claude.
 * Usage: node scripts/video-reviews/score-video-reviews.js [--show show-id]
 * Requires: ANTHROPIC_API_KEY in environment or .env
 */

try { require('dotenv').config(); } catch(e) {}
const fs = require('fs');
const path = require('path');
const { CLAUDE_OPUS } = require('../lib/models');

const TRANSCRIPTS_DIR = path.join(__dirname, '../../data/video-reviews-transcripts');
const CREATORS_PATH = path.join(__dirname, '../../data/video-creators.json');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

const PROMPT = `You are scoring a VIDEO REVIEW of a Broadway/West End STAGE production. The text is a transcript from a TikTok or YouTube video by a theater content creator.

## REJECTION GATE (check first — bias toward rejection if uncertain):

Reject if ANY of these are true:

1. **Not a first-hand review.** Casting news, show announcements, Broadway tea/gossip, closure/controversy reactions, or anticipation for a show the creator HASN'T SEEN YET. Accept past-tense attendance ("I saw", "after the show"), before-and-after vlog structure ("this is us before... this is us after"), or first-preview reactions. Reject pure commentary where the creator is reacting to news about a show without giving opinions on the production itself.

2. **Film/TV adaptation, not the stage show.** If the transcript reviews the MOVIE or FILM adaptation of a musical (mentions "the movie", "the film", "in theaters", Oscar/Academy Award discussion, screen-only cast like Ariana Grande in Wicked 2024), reject — we only score live stage productions.

3. **Reply or follow-up video.** If the transcript's primary purpose is responding to comments on a previous video or continuing a prior video's topic ("okay so a lot of you were mad that I said...", "replying to @username", "since my last video", "people in the comments said..."), reject — it's not a standalone review.

4. **Roundup / list video.** If the transcript covers 3+ shows with no single focus ("here are the shows I've seen this year", "top 10 Broadway shows", "shows coming to NYC", "my favorites from 2025"), reject — the brief mention of the target show is not a review.

5. **Casting announcement.** If the transcript opens with or centers on casting news ("what a casting announcement", "they just announced", "X is joining the cast"), reject — this is news/commentary, not a review of a performance the creator saw.

If rejecting: {"scoreable": false, "rejection": "<short category>", "reasoning": "<which signal above triggered and what you saw>"}

## SCORING (if scoreable):
- Ignore filler words, intros, subscriber plugs, sponsor segments
- Focus on the RECOMMENDATION SIGNAL
- For multi-show videos (2 shows max), score ONLY the target show section

| Bucket | Score Range | Signal |
|--------|------------|--------|
| Rave | 83-100 | Strong enthusiasm, clear recommendation |
| Positive | 70-82 | Recommends with caveats |
| Mixed | 55-69 | Neither recommends nor discourages |
| Negative | 35-54 | Would not recommend |
| Pan | 0-34 | Strongly negative |

Output JSON:
{"scoreable": true, "score": <0-100>, "bucket": "<Rave|Positive|Mixed|Negative|Pan>", "confidence": "<high|medium|low>", "reasoning": "<1-2 sentences>", "keyQuote": "<most representative quote>"}`;

const MODEL_ARG = process.argv.find(a => a.startsWith('--model='))?.split('=')[1];
// Opus is the default for scoring. Sonnet was false-rejecting legit reviews
// with nuanced framing (Eddie Redmayne Cabaret critique tagged "reply/follow-up").
// Eval: Opus 9/9 legit accepted + 5/5 bad rejected; Sonnet 8/9 + 5/5.
// See scripts/video-reviews/eval-prompts.js.
const MODEL = MODEL_ARG || process.env.ANTHROPIC_MODEL || CLAUDE_OPUS;

async function scoreTranscript(transcript, showTitle, creatorName, platform) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, system: PROMPT,
      messages: [{ role: 'user', content: `Score this video review of "${showTitle}" by ${creatorName} (${platform}):\n\n---\n${transcript}\n---` }]
    })
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  const jsonMatch = data.content[0].text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in response');
  return JSON.parse(jsonMatch[0]);
}

async function main() {
  const showFilter = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];
  const creators = JSON.parse(fs.readFileSync(CREATORS_PATH, 'utf8')).creators;
  const creatorMap = Object.fromEntries(creators.map(c => [c.id, c]));

  // Skip pipeline buckets (raw/, classified/) — they contain unsorted transcripts
  // that aren't associated with a real show yet.
  const EXCLUDE = new Set(['.DS_Store', 'raw', 'classified']);
  const showDirs = fs.readdirSync(TRANSCRIPTS_DIR).filter(d =>
    !EXCLUDE.has(d) && fs.statSync(path.join(TRANSCRIPTS_DIR, d)).isDirectory());

  for (const showId of showDirs) {
    if (showFilter && showId !== showFilter) continue;
    const showDir = path.join(TRANSCRIPTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
    const showTitle = showId.replace(/-\d{4}$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    console.log(`\n=== ${showId} (${files.length} transcripts) ===`);
    for (const file of files) {
      const filePath = path.join(showDir, file);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data.score !== undefined || data.scoreable === false) {
        console.log(`  ${data.creatorId}: already processed, skipping`);
        continue;
      }
      const creator = creatorMap[data.creatorId];
      console.log(`  Scoring ${data.creatorId} (${data.wordCount} words)...`);
      try {
        let transcript = data.transcript;
        if (data.wordCount > 2000) {
          const lower = transcript.toLowerCase();
          const term = showTitle.toLowerCase().split(' ').slice(0, 2).join(' ');
          const mentions = [];
          let idx = 0;
          while ((idx = lower.indexOf(term, idx)) !== -1) { mentions.push(idx); idx += term.length; }
          if (mentions.length > 0) {
            const start = Math.max(0, mentions[0] - 500);
            const end = Math.min(transcript.length, mentions[mentions.length - 1] + 3000);
            transcript = transcript.substring(start, end);
          }
        }
        const result = await scoreTranscript(transcript, showTitle, creator?.name || data.creatorId, data.platform);
        if (result.scoreable) {
          Object.assign(data, { score: result.score, bucket: result.bucket, confidence: result.confidence, reasoning: result.reasoning, keyQuote: result.keyQuote, scoredAt: new Date().toISOString(), scoringModel: MODEL });
          console.log(`    ✓ ${result.score} (${result.bucket}) — "${(result.keyQuote || '').substring(0, 80)}"`);
        } else {
          Object.assign(data, { scoreable: false, rejection: result.rejection, reasoning: result.reasoning, scoredAt: new Date().toISOString() });
          console.log(`    ✗ Not scoreable: ${result.rejection}`);
        }
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        console.error(`    Error: ${err.message?.substring(0, 200)}`);
      }
    }
  }
  console.log('\nDone.');
}
main().catch(console.error);
