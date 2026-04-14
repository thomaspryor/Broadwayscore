/**
 * Scan all unflagged WE reviews for cross-market contamination the LLM can detect
 * with market + venue context. Uses targeted pre-filter (text must reference a
 * known Broadway venue or strong marker) to keep LLM calls bounded.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildScoringInput } from './llm-scoring/input-builder';
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are a theater critic review scorer for Broadway and West End shows. Your task is to determine how strongly a critic recommends seeing a show based on their review text.

## Step 0: Is This Text Scoreable?

| Rejection Reason | Description |
|-----------------|-------------|
| wrong_show | Text is about a completely different show or topic |
| wrong_production | Reviews a different production than the one specified in the Show context. **Check the venue and market carefully**: if the context says "at Lyric Theatre (West End)" but the review discusses a production at the National Theatre, a Broadway theatre, or any other venue, reject as wrong_production. Same show title at the wrong venue/market = wrong production. |
| not_a_review | Press release, plot summary, roundup, or promotional content |
| garbage_text | Navigation menus, error pages, ad copy |

If rejecting: { "scoreable": false, "rejection": "<reason>", "reasoning": "Quote the venue/market evidence" }
If scoreable: { "scoreable": true, "bucket": "Rave|Positive|Mixed|Negative|Pan", "score": 50 }`;

// Strong Broadway venue markers — if text contains these without being flagged, suspicious
const STRONG_MARKERS = [
  'Walter Kerr Theatre', 'Winter Garden Theatre', 'Majestic Theatre',
  'Broadhurst Theatre', 'Neil Simon Theatre', 'Gerald Schoenfeld',
  'Booth Theatre', 'Lunt-Fontanne', 'Minskoff Theatre',
  'Music Box Theatre', 'Al Hirschfeld', 'Imperial Theatre',
  'Gershwin Theatre', 'Stephen Sondheim Theatre', 'Nederlander Theatre',
  'Eugene O\'Neill Theatre', 'Richard Rodgers Theatre',
  'New Amsterdam Theatre', 'Shubert Theatre, New York',
  'Broadway debut', 'Great White Way',
];

// Load shows
const showsData = JSON.parse(fs.readFileSync('data/shows.json', 'utf8'));
const showMap: any = {};
for (const s of (showsData.shows || [])) { if (s.id) showMap[s.id] = s; }

// Find candidates
const reviewDir = 'data/review-texts';
const weDirs = fs.readdirSync(reviewDir).filter(d => d.includes('-west-end-') && fs.statSync(path.join(reviewDir, d)).isDirectory());

const candidates: any[] = [];
for (const showDir of weDirs) {
  const showPath = path.join(reviewDir, showDir);
  const files = fs.readdirSync(showPath).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showPath, f), 'utf8'));
      if (data.wrongProduction || data.wrongShow || data.fabricatedEntry) continue;
      if (!data.fullText || data.fullText.length < 200) continue;
      for (const marker of STRONG_MARKERS) {
        if (data.fullText.includes(marker)) {
          candidates.push({ show: showDir, file: f, path: path.join(showPath, f), marker });
          break;
        }
      }
    } catch {}
  }
}

console.log(`Strong-signal candidates: ${candidates.length}\n`);

async function checkOne(c: any) {
  const review = JSON.parse(fs.readFileSync(c.path, 'utf8'));
  const show = showMap[c.show];
  if (!show) return { c, error: 'show-not-found' };
  
  const input = buildScoringInput({
    showTitle: show.title, showId: c.show,
    category: show.category, venue: show.venue,
    outletId: review.outletId, outlet: review.outlet,
    criticName: review.criticName || 'Unknown',
    fullText: review.fullText,
  });
  
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input.context + '\n\n## Review Text\n\n' + input.text }],
    });
    const text = (response as any).content[0].text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { c, error: 'no-json' };
    return { c, result: JSON.parse(m[0]) };
  } catch (e: any) {
    return { c, error: e.message.slice(0, 100) };
  }
}

async function main() {
  const flagged: any[] = [];
  let clean = 0, errored = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`[${i + 1}/${candidates.length}] ${c.show}/${c.file.split('--')[0]}... `);
    const r = await checkOne(c);
    if ((r as any).error) { errored++; console.log(`ERR ${(r as any).error}`); continue; }
    const res = (r as any).result;
    if (!res.scoreable && (res.rejection === 'wrong_production' || res.rejection === 'wrong_show')) {
      flagged.push({ ...c, rejection: res.rejection, reasoning: res.reasoning });
      console.log(`FLAG ${res.rejection}`);
    } else {
      clean++;
      console.log('OK');
    }
  }
  
  console.log(`\n=== ${flagged.length} flagged, ${clean} clean, ${errored} errored ===\n`);
  if (flagged.length > 0) {
    console.log('--- Details ---');
    for (const f of flagged) {
      console.log(`\n${f.show}/${f.file}`);
      console.log(`  marker: "${f.marker}"`);
      console.log(`  rejection: ${f.rejection}`);
      console.log(`  reasoning: ${f.reasoning}`);
    }
    // Save to file for follow-up
    fs.writeFileSync('data/audit/we-cross-market-scan.json', JSON.stringify(flagged, null, 2));
    console.log('\nSaved to data/audit/we-cross-market-scan.json');
  }
}
main();
