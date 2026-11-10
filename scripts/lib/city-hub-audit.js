#!/usr/bin/env node
/**
 * city-hub-audit.js — pre-launch dual-model audit of a city hub (BRO-7257). Reusable for any hub slug.
 *
 * Two independent model families (Gemini + GPT) check every review and every show; Claude triages the flags
 * against the quoted source evidence (the hand-written triage lives in data/audit/city-hub-triage-<slug>.json).
 *
 *   node scripts/lib/city-hub-audit.js --hub=san-diego-ca [--reviews-dir=/home/user/broadway-review-texts]
 *        [--extra-shows=data/pending-fixes/bro-7250.json] [--cache=dir] [--limit=N] [--no-fetch] [--only=shows|reviews]
 *
 * Reviews: per review, fetchPage (disk-cached) for byline/date/meta, stored fullText as the body fallback
 * (paywalled pages), both models answer the same JSON questions blind to our record, the diff happens in code
 * (lessons of lib/audit-city-reviews.js: the byline beats Theatre-In-X names; never anchor on our dates).
 * Shows: deterministic checks (dupes, dates, closingDateSource, status vs today, image files) plus, for a show
 * with a theatre page in evidenceUrls, both models read that page against our record.
 */
'use strict';
require('./llm-usage-install');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { articleText, parseJson, sameCritic } = require('./audit-city-reviews');
const { foldDiacritics } = require('./title-match');

const ROOT = path.join(__dirname, '..', '..');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const has = (n) => process.argv.includes(`--${n}`);
const TODAY = arg('today', new Date().toISOString().slice(0, 10));
const ISO = /^\d{4}-\d{2}-\d{2}/;

// ---------- models ----------
async function gemini(prompt) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('GEMINI_API_KEY is not set');
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return parseJson(j.candidates?.[0]?.content?.parts?.[0]?.text);
}
async function gpt(prompt) {
  const key = process.env.OPENAI_API_KEY; if (!key) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: 'gpt-4.1', temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(90000),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${JSON.stringify(j).slice(0, 160)}`);
  return parseJson(j.choices?.[0]?.message?.content);
}
const MODELS = { gemini, gpt };
async function both(prompt) {
  const out = {};
  await Promise.all(Object.entries(MODELS).map(async ([k, fn]) => {
    for (let i = 0; i < 3; i++) { try { out[k] = await fn(prompt); return; } catch (e) { out[k] = { error: e.message }; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); } }
  }));
  return out;
}

// ---------- review prompt + judge (pure, tested) ----------
function reviewPrompt(show, meta, body) {
  return `You audit a theatre-review database. Answer ONLY with JSON.
Production we believe the article reviews: "${show.title}" at ${show.venue}.
Rules: judge the production from the article itself, not from dates (a remount can be reviewed outside our window). The critic is the byline author, not a site name. An article reviewing two productions can still be a valid review of this one. A preview, interview, listing, "what to see" roundup or news item is not a review.
Page meta: ${meta || '(none)'}
Article text (truncated):
${body.slice(0, 7000)}
JSON keys: rightProduction (true/false/"unclear"), productionSeen (title and theatre the article is about), critic (byline author or null), publishDate (YYYY-MM-DD or null), outlet (publication), isReview (true/false), isRoundup (true if it is a multi-show roundup or listicle rather than a critique of this show), impliedScore (integer 0-100 for how positive the critic's verdict is, 0 awful, 50 mixed, 100 rave; null if no verdict), stars (the star rating printed in the article as a number out of 5, or null), quote (one verbatim sentence from the article that best captures the verdict, copied exactly), note (one short sentence).`;
}
const norm = (s) => foldDiacritics(String(s || '')).toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').replace(/[^a-z0-9' ]/g, '').trim();
/** Stars to score band per CLAUDE.md. */
function starBand(stars) { return { 1: [0, 30], 2: [31, 50], 3: [51, 70], 4: [71, 90], 5: [91, 100] }[Math.round(Number(stars))] || null; }

function judgeReview(rev, v) {
  const p = [];
  if (!v || v.error) return [`model-error ${v && v.error}`];
  if (v.rightProduction === false) p.push(`wrong production (${typeof v.productionSeen === 'object' ? JSON.stringify(v.productionSeen) : v.productionSeen})`);
  if (v.rightProduction === 'unclear') p.push('production unclear');
  if (v.isReview === false) p.push('not a review');
  if (v.isRoundup === true) p.push('roundup');
  if (v.critic && rev.criticName && !/^unknown$/i.test(rev.criticName) && !sameCritic(v.critic, rev.criticName)) p.push(`critic ${rev.criticName} vs byline ${v.critic}`);
  if (v.publishDate && ISO.test(String(v.publishDate)) && rev.publishDate && String(v.publishDate).slice(0, 10) !== String(rev.publishDate).slice(0, 10)) {
    const d = Math.abs((Date.parse(v.publishDate) - Date.parse(rev.publishDate)) / 864e5);
    if (d > 3) p.push(`date ${rev.publishDate} vs page ${v.publishDate}`);
  }
  if (typeof v.impliedScore === 'number' && typeof rev.assignedScore === 'number' && Math.abs(v.impliedScore - rev.assignedScore) > 20) p.push(`score ${rev.assignedScore} vs text-implied ${v.impliedScore}`);
  if (v.stars != null) { const b = starBand(v.stars); if (b && typeof rev.assignedScore === 'number' && (rev.assignedScore < b[0] || rev.assignedScore > b[1])) p.push(`stars ${v.stars}/5 outside score ${rev.assignedScore}`); }
  return p;
}
/** Deterministic: our pull quote must appear (loosely) in the stored text. */
function quoteProblem(rev, text) {
  if (!rev.pullQuote) return null;
  if (!text) return 'no stored text to check pull quote';
  const t = norm(text);
  const parts = String(rev.pullQuote).split(/\s*(?:…|\.\.\.|—|--)\s*/).map(norm).filter((x) => x.length > 12);
  if (!parts.length) return null;
  return parts.every((x) => t.includes(x)) ? null : 'pull quote not found in stored text';
}

// ---------- show checks (pure, tested) ----------
const STRIP = /\b(the|a|an|at|in|of|and|north|sullivan|central|hub|huntington|old|moonlight|cygnet|lajolla|boston|regional)\b/g;
const keyTitle = (s) => norm(s).replace(STRIP, '').replace(/\s+/g, ' ').trim();
function showChecks(shows, today) {
  const issues = [];
  const add = (id, kind, msg) => issues.push({ id, kind, msg });
  const byTitle = {};
  for (const s of shows) {
    const venueKey = norm(String(s.venue || '').split(',')[0]);
    (byTitle[keyTitle(s.title) + '|' + venueKey] ||= []).push(s);
    if (!s.title || !s.venue) add(s.id, 'missing-field', 'title or venue empty');
    if (s.openingDate && s.closingDate && s.closingDate < s.openingDate) add(s.id, 'dates', `closing ${s.closingDate} before opening ${s.openingDate}`);
    if (s.previewsStartDate && s.openingDate && s.previewsStartDate > s.openingDate) add(s.id, 'dates', `previews ${s.previewsStartDate} after opening ${s.openingDate}`);
    if (!s.closingDate && s.status === 'closed') add(s.id, 'closing-date-missing', 'status closed but no closingDate');
    if (s.closingDate && !s.closingDateSource) add(s.id, 'closing-source-missing', `closingDate ${s.closingDate} has no closingDateSource`);
    if (s.closingDate && s.closingDate < today && s.status === 'open') add(s.id, 'status', `open but closingDate ${s.closingDate} is past`);
    if (s.closingDate && s.closingDate >= today && s.status === 'closed') add(s.id, 'status', `closed but closingDate ${s.closingDate} is in the future`);
    if (s.openingDate && s.openingDate > today && s.status === 'closed') add(s.id, 'status', `closed but opens ${s.openingDate}`);
    const img = s.images && (s.images.poster || s.images.thumbnail || s.images.hero);
    if (!img) add(s.id, 'image-missing', 'no image'); else if (!fs.existsSync(path.join(ROOT, 'public', String(img).replace(/^\//, '')))) add(s.id, 'image-file-missing', String(img));
    if (s.category !== 'regional' && s.category !== 'tour') add(s.id, 'category', `category ${s.category}`);
  }
  for (const [k, list] of Object.entries(byTitle)) if (list.length > 1) add(list.map((x) => x.id).join(' + '), 'duplicate', `same title+venue: ${k}`);
  return issues;
}
function showPrompt(show, pageText) {
  return `You audit a theatre database against the producing theatre's own page. Answer ONLY with JSON.
Our record: title "${show.title}", venue "${show.venue}", previews ${show.previewsStartDate || 'n/a'}, opening ${show.openingDate || 'n/a'}, closing ${show.closingDate || 'n/a'}.
Page text:
${pageText.slice(0, 9000)}
Find the production of this title on the page. JSON keys: found (true/false), titleOnPage, venueOnPage (theatre/stage name), startOnPage (YYYY-MM-DD or null), endOnPage (YYYY-MM-DD or null), isProfessionalLocalProduction (true/false), datesMatch (true/false/"unclear": do start/end on the page agree with ours within 2 days), venueMatches (true/false/"unclear"), note (one sentence quoting the page text you relied on).`;
}

// ---------- main ----------
function loadData(hub, extraPlan) {
  const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')); const arr = Array.isArray(S) ? S : S.shows;
  const Rv = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8')); const R = Array.isArray(Rv) ? Rv : (Rv.reviews || Object.values(Rv));
  const shows = arr.filter((s) => s.city === hub);
  const season = [];
  if (extraPlan) {
    const plan = JSON.parse(fs.readFileSync(extraPlan, 'utf8'));
    for (const a of (plan.plan && plan.plan.actions) || []) if (a.type === 'add-show' && a.show && a.show.city === hub && !arr.some((x) => x.id === a.show.id)) season.push(a.show);
  }
  const ids = new Set([...shows, ...season].map((s) => s.id));
  return { shows: [...shows, ...season], season, reviews: R.filter((r) => ids.has(r.showId)) };
}
async function getPage(url, cache) {
  const f = path.join(cache, crypto.createHash('sha1').update(url).digest('hex') + '.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* fetch */ }
  if (has('no-fetch')) return null;
  try {
    const { fetchPage } = require('./scraper');
    const p = await fetchPage(url, { skipVerify: true });
    const page = p && p.content ? { content: p.content, finalUrl: p.finalUrl || p.url || null } : null;
    if (page) fs.writeFileSync(f, JSON.stringify(page));
    return page;
  } catch { return null; }
}
const metaOf = (html, re) => { const m = String(html).match(re); return m ? m[1] : ''; };
function storedText(dir, rev) {
  try {
    const d = path.join(dir, rev.showId);
    for (const f of fs.readdirSync(d)) if (f.startsWith(`${rev.outletId}--`)) { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); if (!rev.url || j.url === rev.url) return j.fullText || ''; }
  } catch { /* none */ }
  return '';
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

async function main() {
  const hub = arg('hub'); if (!hub) throw new Error('--hub=<city-hub slug> required');
  const dir = arg('reviews-dir', '/home/user/broadway-review-texts');
  const cache = arg('cache', path.join(os.tmpdir(), 'city-hub-audit-cache')); fs.mkdirSync(cache, { recursive: true });
  const { shows, season, reviews } = loadData(hub, arg('extra-shows'));
  const only = arg('only', 'all'); const limit = Number(arg('limit', 0)) || Infinity;
  const out = { hub, today: TODAY, counts: { shows: shows.length, seasonShows: season.length, reviews: reviews.length }, showIssues: [], showModelFlags: [], reviewFlags: [], perReview: [] };

  if (only !== 'reviews') {
    out.showIssues = showChecks(shows, TODAY);
    const withPage = shows.filter((s) => (s.evidenceUrls || []).length).slice(0, limit);
    await pool(withPage, 4, async (s) => {
      const url = s.evidenceUrls.find((u) => !/broadwayworld|playbill/.test(u)) || s.evidenceUrls[0];
      const page = await getPage(url, cache); if (!page) { out.showModelFlags.push({ id: s.id, url, problem: 'theatre page unfetchable' }); return; }
      const m = await both(showPrompt(s, articleText(page.content)));
      const flags = {};
      for (const [k, v] of Object.entries(m)) { const p = []; if (v.error) p.push('error ' + v.error); else { if (v.found === false) p.push('not on page'); if (v.datesMatch === false) p.push(`dates (page ${v.startOnPage}..${v.endOnPage})`); if (v.venueMatches === false) p.push(`venue (page ${v.venueOnPage})`); if (v.isProfessionalLocalProduction === false) p.push('not professional/local'); } if (p.length) flags[k] = p; }
      out.showModelFlags.push({ id: s.id, url, checked: true, flags, models: m });
    });
  }

  if (only !== 'shows') {
    const showMap = Object.fromEntries(shows.map((s) => [s.id, s]));
    const todo = reviews.slice(0, limit);
    let n = 0;
    await pool(todo, 6, async (rev) => {
      const show = showMap[rev.showId]; const text = storedText(dir, rev);
      const page = rev.url ? await getPage(rev.url, cache) : null;
      const pageBody = page ? articleText(page.content) : '';
      const body = pageBody.length >= 400 ? pageBody : text;
      const meta = page ? [metaOf(page.content, /<title[^>]*>([^<]+)/i), metaOf(page.content, /property="article:published_time"\s+content="([^"]+)/i), metaOf(page.content, /name="author"\s+content="([^"]+)/i)].filter(Boolean).join(' | ') : '';
      const rec = { showId: rev.showId, outlet: rev.outlet, url: rev.url || null, critic: rev.criticName, date: rev.publishDate, score: rev.assignedScore, fetched: !!page, storedChars: text.length };
      const det = [];
      if (!rev.url) det.push('no url');
      else if (!page) det.push('url unfetched');
      else if (page.finalUrl && String(page.finalUrl).replace(/[?#].*$/, '').replace(/\/+$/, '') !== String(rev.url).replace(/[?#].*$/, '').replace(/\/+$/, '')) det.push(`redirected to ${page.finalUrl}`);
      if (rev.contentTier && rev.contentTier !== 'complete') det.push(`contentTier ${rev.contentTier}`);
      const qp = quoteProblem(rev, text); if (qp) det.push(qp);
      if (!rev.publishDate) det.push('no publishDate');
      if (!rev.criticName || /^unknown$/i.test(rev.criticName)) det.push('critic unknown');
      rec.det = det;
      if (body.length < 400) { rec.models = null; rec.problems = { gemini: ['no article text'], gpt: ['no article text'] }; }
      else {
        const m = await both(reviewPrompt(show, meta, body));
        rec.models = m; rec.problems = { gemini: judgeReview(rev, m.gemini), gpt: judgeReview(rev, m.gpt) };
      }
      out.perReview.push(rec);
      if (++n % 25 === 0) console.error(`reviews ${n}/${todo.length}`);
    });
    out.reviewFlags = out.perReview.filter((r) => r.det.length || (r.problems && (r.problems.gemini.length || r.problems.gpt.length)));
  }
  out.summary = {
    showsChecked: shows.length, showDeterministicIssues: out.showIssues.length,
    showsModelChecked: out.showModelFlags.filter((x) => x.checked).length,
    showsFlaggedGemini: out.showModelFlags.filter((x) => x.flags && x.flags.gemini).length,
    showsFlaggedGpt: out.showModelFlags.filter((x) => x.flags && x.flags.gpt).length,
    reviewsChecked: out.perReview.length,
    reviewsFlaggedGemini: out.perReview.filter((r) => r.problems && r.problems.gemini.length).length,
    reviewsFlaggedGpt: out.perReview.filter((r) => r.problems && r.problems.gpt.length).length,
    reviewsFlaggedDeterministic: out.perReview.filter((r) => r.det.length).length,
  };
  const file = arg('out', path.join(ROOT, 'data', 'audit', `city-hub-audit-${hub}.json`));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  try { require('./scraper').cleanup(); } catch { /* none */ }
  console.log(JSON.stringify(out.summary), '->', file);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { judgeReview, quoteProblem, showChecks, starBand, keyTitle, reviewPrompt, showPrompt };
