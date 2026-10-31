#!/usr/bin/env node
'use strict';
/**
 * BRO-5081 review fact-check, step 3: two web-grounded model checkers.
 *   gemini  gemini-2.5-pro + google_search + url_context tools
 *   openai  gpt-5.4-mini (Responses API) + web_search tool
 * Each gets the production facts, our claimed outlet/critic/date, the URL and
 * the page snapshot fetch-pages.js saved. It never sees our score. Every answer
 * must carry a verbatim evidence quote and the URL it came from; vote.js only
 * counts an answer whose quote is on the page (or whose cited page the model's
 * own search/URL tool actually opened).
 *
 * Usage: node scripts/review-factcheck/check.js --model=gemini|openai [--only=..] [--concurrency=4] [--max-usd=20]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const MODEL = args.model;
const SAMPLE = path.resolve(ROOT, args.sample || 'data/audit/review-factcheck/sample.json');
const CACHE = process.env.FACTCHECK_CACHE || path.join(os.tmpdir(), 'review-factcheck');
const OUT_DIR = path.join(CACHE, 'checks', MODEL || 'none');
const CONC = Number(args.concurrency || 4);
const MAX_USD = Number(args['max-usd'] || 20);
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const MAX_TEXT = 24000;

const GEMINI_MODEL = 'gemini-2.5-pro';
const OPENAI_MODEL = 'gpt-5.4-mini';
// USD per 1M tokens (Gemini 2.5 Pro <=200k prompt; OpenAI per scripts/lib/research-cost.js).
const PRICE = {
  gemini: { input: 1.25, output: 10.0, perSearch: 0.035 },
  openai: { input: 0.75, output: 4.5, perSearch: 0.01 },
};

function productionFacts(show) {
  const cast = (show.cast || []).slice(0, 8).map(c => c.name + (c.role ? ` (${c.role})` : '')).join('; ');
  const team = (show.creativeTeam || []).filter(c => /direct|book|music|lyric|playwright|writer|author/i.test(c.role || '')).slice(0, 6).map(c => `${c.name} (${c.role})`).join('; ');
  return [
    `Title: ${show.title}`,
    `Market: ${show.market === 'west-end' ? 'London (West End / Off-West End)' : show.market}`,
    `Venue: ${show.venue || 'unknown'}`,
    `Previews began: ${show.previewsStartDate || 'unknown'}; opening (press) night: ${show.openingDate || 'unknown'}; closed: ${show.closingDate || 'unknown'}`,
    cast ? `Cast: ${cast}` : null,
    team ? `Creative team: ${team}` : null,
  ].filter(Boolean).join('\n');
}

function buildPrompt(item, show, page) {
  const text = (page.text || '').slice(0, MAX_TEXT);
  const metaLines = page.meta ? Object.entries(page.meta).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n') : '(none)';
  return `You are fact-checking one entry on a theatre review aggregator. Check it against the review page itself, never against memory.

PRODUCTION THIS ENTRY IS FILED UNDER
${productionFacts(show)}

WHAT WE CLAIM
Outlet (publication): ${item.outlet}
Critic: ${item.criticName || '(no byline recorded)'}
Publish date: ${item.publishDate || '(none recorded)'}
Review URL: ${item.url || '(none recorded; we hold only the text below)'}

PAGE SNAPSHOT (source: ${page.source}${page.sourceUrl ? ', ' + page.sourceUrl : ''})
Page metadata:
${metaLines}
Page text:
"""
${text || '(no text could be fetched)'}
"""

Use your web tools to open the review URL (or find the review if the snapshot is empty or looks incomplete). Then answer.

Checks:
a) isReview: is this a critic's review of a performance (not a preview, interview, news item, feature, listing page, or a round-up of other critics' reviews)?
b) thisProduction: is it a review of THIS production (same city/venue and run, consistent year, cast and director), not another run, a tour, a transfer, a film or a different show with the same title? Answer "no" only with concrete evidence (a different venue, year or cast named on the page).
c) outletMatches: is the page published by the claimed outlet? (Syndication: the original publisher counts; a different publication's page does not.)
d) criticMatches: does the page's byline name the claimed critic?
e) dateMatches: does the page's publish date fall within 7 days of the claimed date? (If the page shows no date, answer "unclear".)
f) score: from the WHOLE text, how positive is the critic about this production? Give a 0-100 score and bucket: Rave 83-100, Positive 70-82, Mixed 55-69, Negative 35-54, Pan 0-34. If the review prints a star rating or grade anywhere (headline, standfirst, end), report it exactly (e.g. "4/5", "3 stars", "B+"); otherwise null.

For every check give: "answer" ("yes" | "no" | "unclear"), "evidence" (a short VERBATIM quote from the page, max 25 words, that supports the answer), and "citation" (the exact URL you read it on: the review URL, an archive.org URL, or "snapshot" if only the text above had it).

Reply with JSON only, no prose, in exactly this shape:
{"isReview":{"answer":"","kind":"review|preview|interview|news|feature|listing|roundup|other","evidence":"","citation":""},
"thisProduction":{"answer":"","reason":"","evidence":"","citation":""},
"outletMatches":{"answer":"","pageOutlet":"","evidence":"","citation":""},
"criticMatches":{"answer":"","pageByline":"","evidence":"","citation":""},
"dateMatches":{"answer":"","pageDate":"YYYY-MM-DD or null","evidence":"","citation":""},
"score":{"score":0,"bucket":"","printedRating":null,"ratingEvidence":"","evidence":"","citation":""}}`;
}

async function postJson(url, body, headers) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(300000), method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const txt = await res.text();
    if (res.ok) return JSON.parse(txt);
    if (res.status === 429 || res.status >= 500) { await new Promise(r => setTimeout(r, 10000 * (attempt + 1))); continue; }
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 300)}`);
  }
  throw new Error('retries exhausted');
}

function parseJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const j = await postJson(url, { contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }, { url_context: {} }], generationConfig: { temperature: 0 } }, {});
  const cand = (j.candidates || [])[0] || {};
  const text = (cand.content && cand.content.parts || []).map(p => p.text || '').join('');
  const gm = cand.groundingMetadata || {};
  const sources = [
    ...(gm.groundingChunks || []).map(c => c.web && (c.web.uri + ' ' + (c.web.title || ''))).filter(Boolean),
    ...((cand.urlContextMetadata || cand.url_context_metadata || {}).urlMetadata || (cand.urlContextMetadata || {}).url_metadata || []).map(u => (u.retrievedUrl || u.retrieved_url) + ' ' + (u.urlRetrievalStatus || u.url_retrieval_status || '')),
  ];
  const u = j.usageMetadata || {};
  const searches = (gm.webSearchQueries || []).length ? 1 : 0;
  const usd = ((u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0)) * PRICE.gemini.input / 1e6 + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * PRICE.gemini.output / 1e6 + searches * PRICE.gemini.perSearch;
  return { raw: text, parsed: parseJson(text), sources, usd };
}

async function callOpenAI(prompt) {
  const j = await postJson('https://api.openai.com/v1/responses', { model: OPENAI_MODEL, input: prompt, tools: [{ type: 'web_search' }], reasoning: { effort: 'low' } }, { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` });
  const out = j.output || [];
  const msg = out.filter(o => o.type === 'message').flatMap(o => o.content || []);
  const text = msg.map(c => c.text || '').join('');
  const sources = [
    ...msg.flatMap(c => (c.annotations || []).filter(a => a.type === 'url_citation').map(a => a.url)),
    ...out.filter(o => o.type === 'web_search_call').flatMap(o => { const a = o.action || {}; return [a.url, ...((a.sources || []).map(s => s.url))].filter(Boolean); }),
  ];
  const searches = out.filter(o => o.type === 'web_search_call').length;
  const u = j.usage || {};
  const usd = (u.input_tokens || 0) * PRICE.openai.input / 1e6 + (u.output_tokens || 0) * PRICE.openai.output / 1e6 + searches * PRICE.openai.perSearch;
  return { raw: text, parsed: parseJson(text), sources, usd };
}

async function main() {
  if (!['gemini', 'openai'].includes(MODEL)) throw new Error('--model=gemini|openai');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shows = new Map(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows.map(s => [s.id, s]));
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).sample.filter(s => !ONLY || ONLY.has(s.sampleId));
  const queue = sample.filter(s => ONLY || !fs.existsSync(path.join(OUT_DIR, s.sampleId + '.json')));
  let spent = 0; let done = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
      if (spent >= MAX_USD) { console.error(`cost cap $${MAX_USD} reached; stopping`); return; }
      const item = queue.shift();
      const pagePath = path.join(CACHE, item.sampleId + '.json');
      const page = fs.existsSync(pagePath) ? JSON.parse(fs.readFileSync(pagePath, 'utf8')) : { source: 'none', text: '' };
      const prompt = buildPrompt(item, shows.get(item.showId) || { title: item.showTitle }, page);
      try {
        const call = MODEL === 'gemini' ? callGemini : callOpenAI;
        let r = await call(prompt);
        // Gemini 2.5 Pro with tools sometimes returns an empty turn; retry once.
        if (!r.parsed) { const usd = r.usd; r = await call(prompt); r.usd += usd; }
        spent += r.usd;
        fs.writeFileSync(path.join(OUT_DIR, item.sampleId + '.json'), JSON.stringify({ sampleId: item.sampleId, model: MODEL === 'gemini' ? GEMINI_MODEL : OPENAI_MODEL, ...r, checkedAt: new Date().toISOString() }));
        done++;
        console.error(`${item.sampleId} ${r.parsed ? 'ok' : 'UNPARSED'} $${r.usd.toFixed(4)} total $${spent.toFixed(2)}`);
      } catch (e) {
        console.error(`${item.sampleId} ERROR ${e.message}`);
      }
    }
  }));
  console.log(JSON.stringify({ model: MODEL, done, spentUsd: Number(spent.toFixed(2)) }));
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { buildPrompt, parseJson, productionFacts };
