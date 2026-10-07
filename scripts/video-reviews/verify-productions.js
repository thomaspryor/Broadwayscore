#!/usr/bin/env node
/**
 * Verify each scored video review is about the SPECIFIC production it is
 * filed under (BRO-4328).
 *
 * The classifier only ever saw show titles, so West End runs, tours,
 * out-of-town tryouts, community productions and earlier revivals were filed
 * under the Broadway id with the same title (~10% of published reviews in the
 * 2026-09-29 audit). This step checks every scored per-show transcript
 * against the production's venue, city and run dates:
 *   1. Deterministic: posted before the production's first preview -> wrong.
 *   2. LLM: given the production details, the video title, post date and
 *      transcript, is it the same production? "different" at high/medium
 *      confidence, with an accepted evidence type and a quote that appears in
 *      the video, AND confirmed by a second model (Gemini) -> wrong.
 * Wrong ones get wrongProduction=true (build-video-reviews.js already skips
 * those) plus a productionCheck record. Every checked file gets
 * productionCheck, so re-runs only check new reviews.
 *
 * Pipeline: ... score-video-reviews -> verify-productions -> build-video-reviews
 *
 * Usage:
 *   node scripts/video-reviews/verify-productions.js            # check unchecked, apply
 *   node scripts/video-reviews/verify-productions.js --dry-run  # report only
 *   node scripts/video-reviews/verify-productions.js --refresh  # re-check everything
 *   node scripts/video-reviews/verify-productions.js --show=ID
 * Provider: OpenAI (GPT-4o) by default; VERIFY_PROVIDER=anthropic uses Claude.
 * LLM-based flags also need Gemini (GEMINI_API_KEY) to agree; without it they are not applied.
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('../lib/list-show-dirs');
const { describeProduction, videoPredatesProduction } = require('../lib/video-production-context');
const { GPT4O, CLAUDE_SONNET, GEMINI_FLASH } = require('../lib/models');
const { invalidateWrongProductionAutoClear } = require('../lib/review-write-guard');

const ROOT = path.resolve(__dirname, '../..');
const TRANSCRIPTS_DIR = path.join(ROOT, 'data/video-reviews-transcripts');
const SHOWS_PATH = path.join(ROOT, 'data/shows.json');
const CREATORS_PATH = path.join(ROOT, 'data/video-creators.json');

const DRY_RUN = process.argv.includes('--dry-run');
const REFRESH = process.argv.includes('--refresh');
const SHOW_FILTER = process.argv.find(a => a.startsWith('--show='))?.split('=')[1];
const PROVIDER = process.env.VERIFY_PROVIDER || (process.env.OPENAI_API_KEY ? 'openai' : 'anthropic');
const MODEL = PROVIDER === 'openai' ? GPT4O : CLAUDE_SONNET;
const CONCURRENCY = 4;

const PROMPT = `You check whether a theater creator's video review is about ONE specific stage production. Many shows exist as several productions with the same title: a Broadway run, a West End (London) run, UK or US national tours, out-of-town tryouts (e.g. Chicago, Boston, DC), regional theaters, concerts, community or school productions, the film, and earlier revivals in other years or venues.

You get the ASSIGNED production (title, city/market, venue, run dates), the date the video was posted (may be unknown), the video title and the transcript.

Answer "different" ONLY on explicit evidence in the title or transcript that it is another production:
- a different CITY or COUNTRY than the assigned one (e.g. London/West End/UK when assigned New York; Chicago, Boston, DC, Denver, Toronto, Amsterdam; a named tour stop);
- it is a national/UK/international TOUR, a pre-Broadway TRYOUT, a CONCERT or one-night staging (e.g. City Center Encores when assigned a full run), a COMMUNITY, school or amateur production, or the FILM;
- it is plainly a DIFFERENT SHOW (a different title or subject, not just a detail you do not recognise).

Do NOT answer "different" because of:
- venue or theater-company names inside the same city (companies have several stages, shows transfer between houses, and our venue data can be imprecise);
- cast names, run length, "limited run", or plot details you cannot verify: your knowledge of casts and plots is incomplete, so an unfamiliar detail is not evidence.
- where the STORY is set (a play set in England or Paris can be performed in New York): only where the PERFORMANCE happens counts.

Answer "same" when nothing explicit points elsewhere and the city fits. Answer "unsure" only when the city itself is ambiguous.

For "different", classify the evidence and quote it word for word from the title or transcript:
- "other_city": the video is set in a named city or country other than the assigned one (a tour stop elsewhere counts; a tour playing the assigned city does not);
- "tryout": an explicitly out-of-town, pre-Broadway run;
- "concert": a concert, one-night or Encores-style staging when the assigned one is a full run;
- "community": a community, school or amateur production;
- "film": the movie.

Output JSON only: {"verdict":"same"|"different"|"unsure","confidence":"high"|"medium"|"low","evidenceType":"other_city"|"tryout"|"concert"|"community"|"film"|null,"evidenceQuote":"<exact words from the title or transcript, or empty>","reason":"<one sentence>"}`;

const ACCEPTED_EVIDENCE = new Set(['other_city', 'tryout', 'concert', 'community', 'film']);

// Loose match: transcripts are auto-captions, so compare letters and digits only.
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * An LLM "different" counts only with an accepted evidence type and a quote
 * that really appears in the title or transcript. GPT-4o otherwise rejects
 * real reviews over cast, plot or same-city venue details it does not know
 * (Giant, Mary Jane, Beetlejuice in the 2026-09-29 dry run).
 */
function isEvidencedMismatch(v, t) {
  if (v.verdict !== 'different' || !(v.confidence === 'high' || v.confidence === 'medium')) return false;
  if (!ACCEPTED_EVIDENCE.has(v.evidenceType)) return false;
  const quote = norm(v.evidenceQuote);
  if (quote.length < 4) return false;
  return norm(`${t.title || ''} ${t.transcript || ''}`).includes(quote);
}

async function ask(user) {
  if (PROVIDER === 'openai') {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: MODEL, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: user }] }),
    });
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
    return (await resp.json()).choices[0].message.content;
  }
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, system: PROMPT, messages: [{ role: 'user', content: user }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  return (await resp.json()).content.find(c => c.type === 'text')?.text || '';
}

function parseVerdict(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON: ' + String(text).substring(0, 200));
  const v = JSON.parse(m[0]);
  if (!['same', 'different', 'unsure'].includes(v.verdict)) throw new Error('Bad verdict: ' + m[0].substring(0, 200));
  return v;
}

const CONFIRM_PROMPT = `A video review has been filed under one stage production. A first checker thinks the video is about a DIFFERENT production and cites evidence. Decide whether the evidence really shows that.

Say "yes" only if the evidence shows the video is about a performance in a different city or country, an out-of-town pre-Broadway tryout, a concert or one-night staging, a community/school/amateur production, or the film.
Say "no" if the evidence is a different theater, venue or theater company in the SAME city (companies have several stages; shows transfer), a tour or production that is playing the assigned city, a cast or plot detail, where the story is SET (a play set in England can be performed in New York), or anything else.

Output JSON only: {"confirm":"yes"|"no","reason":"<one sentence>"}`;

/**
 * Second, independent model (Gemini) must agree before an LLM-based flag hides
 * a review. In the 2026-09-29 dry run GPT-4o alone flagged Giant (a play about
 * Roald Dahl), a Mamma Mia tour back at the Winter Garden, and two Second Stage
 * productions: all the real New York runs. Date-based flags skip this.
 * Returns null when Gemini is unavailable, so the flag is not applied.
 */
async function confirmWithGemini(v, t, show) {
  if (!process.env.GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const user = `${CONFIRM_PROMPT}

Assigned production: ${describeProduction(show)}
Video title: "${t.title || ''}"
Evidence type claimed: ${v.evidenceType}
Evidence quote: "${v.evidenceQuote}"
First checker's reason: ${v.reason}
Transcript excerpt:
---
${String(t.transcript || '').substring(0, 3000)}
---`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }),
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const text = (await resp.json()).candidates?.[0]?.content?.parts?.[0]?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Gemini no JSON: ' + text.substring(0, 200));
  const c = JSON.parse(m[0]);
  return { confirmed: c.confirm === 'yes', reason: c.reason, model: GEMINI_FLASH };
}

async function checkOne(t, show, creatorName) {
  if (videoPredatesProduction(t.publishedAt, show)) {
    return { verdict: 'different', confidence: 'high', reason: `Video posted ${t.publishedAt}, before this production's first performance (${show.previewsStartDate || show.openingDate}).`, method: 'date' };
  }
  const user = `ASSIGNED production: ${describeProduction(show)}
Creator: ${creatorName}
Video posted: ${t.publishedAt && t.publishedAt !== 'NA' ? t.publishedAt : 'unknown'}
Video title: "${t.title || ''}"

Transcript:
---
${String(t.transcript || '').substring(0, 6000)}
---`;
  return { ...parseVerdict(await ask(user)), method: 'llm', model: MODEL };
}

async function main() {
  if (PROVIDER === 'openai' && !process.env.OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }
  if (PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }
  if (!fs.existsSync(SHOWS_PATH)) { console.error(`Missing ${SHOWS_PATH} (private core data)`); process.exit(1); }

  const shows = new Map(JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows.map(s => [s.id, s]));
  const creators = JSON.parse(fs.readFileSync(CREATORS_PATH, 'utf8')).creators;
  const creatorName = id => (creators.find(c => [c.id, c.platforms?.youtube?.channelHandle, c.platforms?.tiktok?.handle].filter(Boolean).map(x => x.toLowerCase()).includes(String(id).toLowerCase()))?.name) || id;

  const jobs = [];
  for (const showId of listShowDirs(TRANSCRIPTS_DIR).filter(d => d !== 'raw' && d !== 'classified')) {
    if (SHOW_FILTER && showId !== SHOW_FILTER) continue;
    const show = shows.get(showId);
    if (!show) continue; // build-video-reviews.js drops unknown ids
    for (const f of fs.readdirSync(path.join(TRANSCRIPTS_DIR, showId)).filter(x => x.endsWith('.json'))) {
      const file = path.join(TRANSCRIPTS_DIR, showId, f);
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (t.score === undefined || t.scoreable === false || t.wrongProduction === true) continue;
      if (t.productionCheck && !REFRESH) continue;
      jobs.push({ file, showId, show, t });
    }
  }
  console.log(`Checking ${jobs.length} reviews with ${PROVIDER}/${MODEL}${DRY_RUN ? ' (dry run)' : ''}`);

  let wrong = 0, errors = 0, i = 0;
  const flagged = [];
  const disputed = [];
  async function worker() {
    while (i < jobs.length) {
      const job = jobs[i++];
      let v;
      try {
        v = await checkOne(job.t, job.show, creatorName(job.t.creatorId));
      } catch (err) {
        errors++;
        console.log(`  ERROR ${job.showId}/${job.t.creatorId}: ${err.message}`);
        continue;
      }
      let isWrong = v.method === 'date';
      if (!isWrong && isEvidencedMismatch(v, job.t)) {
        try {
          v.confirmation = await confirmWithGemini(v, job.t, job.show);
        } catch (err) {
          errors++;
          console.log(`  ERROR confirming ${job.showId}/${job.t.creatorId}: ${err.message}`);
          continue; // leave unchecked so the next run retries
        }
        if (v.confirmation === null) {
          // No GEMINI_API_KEY: leave unchecked so a run with the key retries it.
          disputed.push(`${job.showId}  ${job.t.creatorId}  no GEMINI_API_KEY, left unchecked`);
          continue;
        }
        isWrong = v.confirmation.confirmed === true;
        if (!isWrong) disputed.push(`${job.showId}  ${job.t.creatorId}  not confirmed: ${v.confirmation.reason}`);
      }
      if (isWrong) {
        wrong++;
        flagged.push(`${job.showId}  ${job.t.creatorId}  ${job.t.videoUrl}  [${v.method}] ${v.reason}`);
      }
      if (DRY_RUN) continue;
      const fresh = JSON.parse(fs.readFileSync(job.file, 'utf8'));
      fresh.productionCheck = { ...v, checkedAt: new Date().toISOString() };
      if (isWrong) {
        fresh.wrongProduction = true;
        fresh.wrongProductionReason = v.reason;
        // a stale auto-clear breadcrumb beside a fresh flag would let the guards clear it again
        invalidateWrongProductionAutoClear(fresh);
      }
      fs.writeFileSync(job.file, JSON.stringify(fresh, null, 2) + '\n');
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n=== Production check: ${jobs.length} checked, ${wrong} wrong production, ${errors} errors ===`);
  for (const line of flagged.sort()) console.log('  ' + line);
  if (disputed.length) {
    console.log(`\n${disputed.length} flagged by the first checker but not confirmed (kept):`);
    for (const line of disputed.sort()) console.log('  ' + line);
  }
  // Errors leave files unchecked so the next run retries them; a run where
  // most calls fail is a provider outage, not data.
  if (jobs.length >= 10 && errors > jobs.length / 2) {
    console.error(`::error::Production check failed for ${errors}/${jobs.length} reviews`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
