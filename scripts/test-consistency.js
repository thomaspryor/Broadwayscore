/**
 * Test model self-consistency by scoring the same reviews twice
 */

const Anthropic = require('@anthropic-ai/sdk').default;
const OpenAI = require('openai').default;
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// Load a few reviews with full text
const reviewsDir = 'data/review-texts';
const testReviews = [];

// Find 5 reviews with full text
const shows = fs.readdirSync(reviewsDir).filter(f =>
  fs.statSync(path.join(reviewsDir, f)).isDirectory()
);

outer:
for (const show of shows) {
  const files = fs.readdirSync(path.join(reviewsDir, show))
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(reviewsDir, show, file), 'utf8'));
      if (data.fullText && data.fullText.length > 500) {
        testReviews.push({
          id: show + '/' + data.outlet,
          text: data.fullText.substring(0, 2000), // Truncate for speed
          dtliThumb: data.dtliThumb
        });
        if (testReviews.length >= 5) break outer;
      }
    } catch(e) {}
  }
}

console.log('Found ' + testReviews.length + ' test reviews\n');

const PROMPT = `You are a theater critic scoring system. Score this Broadway review on a 0-100 scale.

First, classify into a bucket:
- Rave (85-100): Enthusiastic, unreserved praise
- Positive (68-84): Generally favorable with minor reservations
- Mixed (50-67): Balanced pros and cons
- Negative (30-49): More negative than positive
- Pan (0-29): Strongly negative

Then give a specific score within that bucket's range.

Respond with ONLY valid JSON:
{"bucket": "Positive", "score": 75}

REVIEW TEXT:
`;

async function scoreWithClaude(client, text) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 100,
    messages: [{ role: 'user', content: PROMPT + text }]
  });
  const content = response.content[0].text.trim();
  try {
    return JSON.parse(content.replace(/```json\n?|\n?```/g, ''));
  } catch(e) {
    const match = content.match(/"score"\s*:\s*(\d+)/);
    return match ? { score: parseInt(match[1]), bucket: 'Unknown' } : null;
  }
}

async function scoreWithOpenAI(client, text) {
  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 100,
    messages: [{ role: 'user', content: PROMPT + text }]
  });
  const content = response.choices[0].message.content.trim();
  try {
    return JSON.parse(content.replace(/```json\n?|\n?```/g, ''));
  } catch(e) {
    const match = content.match(/"score"\s*:\s*(\d+)/);
    return match ? { score: parseInt(match[1]), bucket: 'Unknown' } : null;
  }
}

async function scoreWithGemini(client, text) {
  const model = client.getGenerativeModel({ model: 'gemini-2.0-flash' });
  const result = await model.generateContent(PROMPT + text);
  const content = result.response.text().trim();
  try {
    return JSON.parse(content.replace(/```json\n?|\n?```/g, ''));
  } catch(e) {
    const match = content.match(/"score"\s*:\s*(\d+)/);
    return match ? { score: parseInt(match[1]), bucket: 'Unknown' } : null;
  }
}

async function main() {
  const claudeKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!claudeKey || !openaiKey) {
    console.error('Need ANTHROPIC_API_KEY and OPENAI_API_KEY');
    process.exit(1);
  }

  const claude = new Anthropic({ apiKey: claudeKey });
  const openai = new OpenAI({ apiKey: openaiKey });
  const gemini = geminiKey ? new GoogleGenerativeAI(geminiKey) : null;

  console.log('=== SELF-CONSISTENCY TEST ===');
  console.log('Scoring each review TWICE with each model\n');

  const results = {
    claude: { diffs: [], bucketMatches: 0, total: 0 },
    openai: { diffs: [], bucketMatches: 0, total: 0 },
    gemini: { diffs: [], bucketMatches: 0, total: 0 }
  };

  for (let i = 0; i < testReviews.length; i++) {
    const review = testReviews[i];
    console.log('--- Review ' + (i+1) + ': ' + review.id + ' ---');
    if (review.dtliThumb) console.log('DTLI thumb: ' + review.dtliThumb);

    // Claude twice
    try {
      const c1 = await scoreWithClaude(claude, review.text);
      await new Promise(r => setTimeout(r, 500)); // Small delay
      const c2 = await scoreWithClaude(claude, review.text);

      if (c1 && c2) {
        const diff = Math.abs(c1.score - c2.score);
        results.claude.diffs.push(diff);
        results.claude.total++;
        if (c1.bucket === c2.bucket) results.claude.bucketMatches++;
        console.log('Claude:  Run1=' + c1.bucket + '(' + c1.score + ')  Run2=' + c2.bucket + '(' + c2.score + ')  Δ=' + diff);
      }
    } catch(e) {
      console.log('Claude error: ' + e.message);
    }

    // OpenAI twice
    try {
      const o1 = await scoreWithOpenAI(openai, review.text);
      await new Promise(r => setTimeout(r, 500));
      const o2 = await scoreWithOpenAI(openai, review.text);

      if (o1 && o2) {
        const diff = Math.abs(o1.score - o2.score);
        results.openai.diffs.push(diff);
        results.openai.total++;
        if (o1.bucket === o2.bucket) results.openai.bucketMatches++;
        console.log('OpenAI:  Run1=' + o1.bucket + '(' + o1.score + ')  Run2=' + o2.bucket + '(' + o2.score + ')  Δ=' + diff);
      }
    } catch(e) {
      console.log('OpenAI error: ' + e.message);
    }

    // Gemini twice (if available)
    if (gemini) {
      try {
        const g1 = await scoreWithGemini(gemini, review.text);
        await new Promise(r => setTimeout(r, 500));
        const g2 = await scoreWithGemini(gemini, review.text);

        if (g1 && g2) {
          const diff = Math.abs(g1.score - g2.score);
          results.gemini.diffs.push(diff);
          results.gemini.total++;
          if (g1.bucket === g2.bucket) results.gemini.bucketMatches++;
          console.log('Gemini:  Run1=' + g1.bucket + '(' + g1.score + ')  Run2=' + g2.bucket + '(' + g2.score + ')  Δ=' + diff);
        }
      } catch(e) {
        console.log('Gemini error: ' + e.message);
      }
    }

    console.log('');
  }

  console.log('=== CONSISTENCY SUMMARY ===\n');

  for (const model of ['claude', 'openai', 'gemini']) {
    const r = results[model];
    if (r.total === 0) continue;

    const avgDiff = (r.diffs.reduce((a,b) => a+b, 0) / r.diffs.length).toFixed(1);
    const maxDiff = Math.max(...r.diffs);
    const bucketConsistency = ((r.bucketMatches / r.total) * 100).toFixed(0);

    console.log(model.toUpperCase() + ':');
    console.log('  Avg score difference between runs: ' + avgDiff + ' points');
    console.log('  Max score difference: ' + maxDiff + ' points');
    console.log('  Bucket consistency: ' + r.bucketMatches + '/' + r.total + ' (' + bucketConsistency + '%)');
    console.log('');
  }
}

main().catch(console.error);
