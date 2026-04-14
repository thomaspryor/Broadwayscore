#!/usr/bin/env node
/**
 * Score video review transcripts using Claude.
 * Usage: node scripts/video-reviews/score-video-reviews.js [--show show-id]
 * Requires: ANTHROPIC_API_KEY in environment or .env
 */

try { require('dotenv').config(); } catch(e) {}
const fs = require('fs');
const path = require('path');

const TRANSCRIPTS_DIR = path.join(__dirname, '../../data/video-reviews-transcripts');
const CREATORS_PATH = path.join(__dirname, '../../data/video-creators.json');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

const PROMPT = `You are scoring a VIDEO REVIEW of a Broadway/West End show. The text is a transcript from a TikTok or YouTube video by a theater content creator.

## REJECTION GATE (check first):
If the transcript is about casting news, show announcements, Broadway tea/gossip, or anticipation for a show the creator HASN'T SEEN YET, reject it. Look for past-tense language ("I saw", "we went to", "after the show") to confirm they actually attended.

If rejecting: {"scoreable": false, "rejection": "<reason>", "reasoning": "<explanation>"}

## SCORING (if scoreable):
- Ignore filler words, intros, subscriber plugs, sponsor segments
- Focus on the RECOMMENDATION SIGNAL
- For multi-show videos, score ONLY the target show section

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
const MODEL = MODEL_ARG || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';

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

  const showDirs = fs.readdirSync(TRANSCRIPTS_DIR).filter(d =>
    d !== '.DS_Store' && fs.statSync(path.join(TRANSCRIPTS_DIR, d)).isDirectory());

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
