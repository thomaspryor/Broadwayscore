#!/usr/bin/env node
/**
  * venue-write-guard-ok: reads venue from shows.json to compare against model extraction; writes nothing.
 * audit-city-hub-dual-model.js — pre-launch audit of one city hub by two independent model
 * families (Gemini + OpenAI), BRO-7256. Rerunnable for any hub in data/city-hubs.json.
 *
 *   node scripts/audit-city-hub-dual-model.js inventory --city=washington-dc
 *   node scripts/audit-city-hub-dual-model.js shows|images|reviews|coverage|tours|ingest-plan --city=... [--limit=N] [--max-usd=4]
 *   node scripts/audit-city-hub-dual-model.js pages --city=...        (live hub + app feed vs shows.json, no LLM)
 *   node scripts/audit-city-hub-dual-model.js report --city=... [--write]  (scorecard; --write saves JSON + MD)
 *
 * The models extract facts blind from the source text (they never see our dates, critic, score
 * or rating); scripts/lib/city-hub-dual-audit.js compares the extraction with our record. A flag
 * is a lead, not a verdict: a confirmed problem needs source evidence, recorded in
 * data/audit/city-hub-dual/<city>/triage.json. Page/review text is sent to the models and never
 * stored (only hashes and the models' short extractions are cached, one jsonl per check, resumable).
 */
'use strict';

require('./lib/llm-usage-install'); // LLM spend meter before any client exists
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const A = require('./lib/city-hub-dual-audit');
const { askGemini, askOpenAI, pool, spend, GEMINI_MODEL, OPENAI_MODEL } = require('./lib/dual-model-client');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  if (a) return a.slice(n.length + 3);
  return process.argv.includes(`--${n}`) ? true : d;
};
const TODAY = arg('today', new Date().toISOString().slice(0, 10));
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ---------- inventory ----------
function loadCity(city) {
  const hubs = readJson('data/city-hubs.json').hubs;
  const hub = hubs[city];
  if (!hub) throw new Error(`unknown hub ${city}; known: ${Object.keys(hubs).join(', ')}`);
  const shows = readJson('data/shows.json'); const all = shows.shows || shows;
  // in scope = what the hub can list: a closed show that opened before the hub's `since` never appears (sectionHubShows)
  const cityAll = all.filter((s) => s.city === city);
  const mine = all.filter((s) => s.city === city && !(hub.since && A.hubPhase(s, TODAY) === 'closed' && (s.openingDate || '') < hub.since));
  const ids = new Set(mine.map((s) => s.id));
  const reviews = readJson('data/reviews.json').reviews.filter((r) => ids.has(r.showId));
  const textsDir = path.join(ROOT, 'data', 'review-texts');
  const files = {};
  for (const id of ids) {
    const d = path.join(textsDir, id); files[id] = [];
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.json')) continue;
      try { files[id].push({ file: f, ...JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) }); } catch (_) { /* skip */ }
    }
  }
  const normUrl = (u) => String(u || '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  const used = new Set();
  const items = reviews.map((r) => {
    const fl = (files[r.showId] || []).find((f) => normUrl(f.url) === normUrl(r.url) && (!r.criticName || fold(f.criticName) === fold(r.criticName)))
      || (files[r.showId] || []).find((f) => normUrl(f.url) === normUrl(r.url));
    if (fl) used.add(`${r.showId}/${fl.file}`);
    return { kind: 'published', id: `${r.showId}|${normUrl(r.url)}|${fold(r.criticName)}`, row: r, file: fl || null };
  });
  const excluded = [];
  for (const id of ids) for (const f of files[id]) if (!used.has(`${id}/${f.file}`)) excluded.push({ kind: 'excluded', id: `${id}/${f.file}`, row: null, file: f, showId: id });
  const tours = tourStops(city, hub, all);
  return { city, hub, cityAll, shows: mine, reviews: items, excluded, tours, allShows: all };
}
const fold = A.fold;

function tourStops(city, hub, all) {
  let sched; try { sched = readJson('data/tour-schedules.json').tours; } catch (_) { return []; }
  const home = String(hub.home || '').toLowerCase();
  const byId = new Map(all.map((s) => [s.id, s]));
  const out = [];
  for (const [id, t] of Object.entries(sched)) {
    for (const st of t.stops || []) {
      if (String(st.city || '').toLowerCase() !== home) continue;
      const s = byId.get(id);
      if (!s || s.category !== 'tour' || s.status === 'closed') continue;
      out.push({ id: `${id}|${st.start}|${st.venue}`, showId: id, title: s.title, venue: st.venue, city: st.city, start: st.start, end: st.end, source: t.source });
    }
  }
  return out;
}

// ---------- cache ----------
function cacheFile(city, kind) {
  const d = path.join(ROOT, 'data', 'audit', 'city-hub-dual', city); fs.mkdirSync(d, { recursive: true });
  return path.join(d, `${kind}.jsonl`);
}
function loadCache(city, kind) {
  const f = cacheFile(city, kind); const m = new Map();
  if (!fs.existsSync(f)) return m;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l.trim()) continue; try { const j = JSON.parse(l); m.set(j.id, j); } catch (_) { /* skip */ } }
  return m;
}
function appendCache(city, kind, row) { fs.appendFileSync(cacheFile(city, kind), `${JSON.stringify(row)}\n`); }

// ---------- source text ----------
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
function htmlToText(html) {
  return String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#8217;|&#x27;/g, "'").replace(/\s+/g, ' ');
}
const pageCache = new Map();
async function fetchPageText(url, { chain = false } = {}) {
  if (pageCache.has(url)) return pageCache.get(url);
  const p = (async () => {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
      let res; try { res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html' }, signal: ctl.signal }); } finally { clearTimeout(t); }
      let html;
      if (res.ok) html = await res.text();
      else if (!chain) return { error: `http-${res.status}` };
      else {
        const { fetchPage } = require('./lib/scraper'); // paid provider chain, opt-in only
        const r = await fetchPage(url); html = r && r.content;
        if (!html) return { error: `http-${res.status}` };
      }
      const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].slice(0, 2500)).join('\n');
      const meta = [...html.matchAll(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished|og:published_time|author|article:author|og:site_name|og:title)["'][^>]*>/gi)].map((m) => m[0]).join('\n');
      return { text: htmlToText(html.slice(0, 3_000_000)), meta: `${meta}\n${ld}`.slice(0, 4000), finalUrl: res.url };
    } catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : 'fetch-failed' }; }
  })();
  pageCache.set(url, p);
  return p;
}
/** Up to `max` chars: the windows around title mentions first, then the start of the page. */
function excerptAround(text, title, max = 6500) {
  const t = String(text || ''); if (t.length <= max) return t;
  const key = fold(title).split(' ').filter((w) => w.length > 3)[0] || fold(title);
  const low = fold(t); const idx = key ? low.indexOf(key) : -1;
  const approx = idx < 0 ? 0 : Math.max(0, Math.floor((idx / low.length) * t.length) - 1500);
  return `${t.slice(0, 1500)}\n[...]\n${t.slice(approx, approx + max - 1600)}`;
}
const reviewExcerpt = (text) => (String(text).length <= 7000 ? String(text) : `${String(text).slice(0, 5200)}\n[...]\n${String(text).slice(-1600)}`);
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

function showPageUrl(s) {
  if (s.officialUrl) return s.officialUrl;
  const t = (s.ticketLinks || []).find((x) => /venue|box office|official/i.test(x.platform || '')) || (s.ticketLinks || [])[0];
  return t && t.url;
}

// ---------- prompts ----------
const JSON_ONLY = 'Reply with one JSON object only, no prose.';
function reviewPrompt(show, text, meta) {
  return `You are auditing a theatre review database. Read ONLY the article below (it may be truncated) and extract facts from it. TARGET PRODUCTION we believe it reviews: "${show.title}" at ${show.venue || 'unknown venue'} (${show.city}). Judge matchesProduction from what the article itself states (title, theatre, company, city, cast, run), not from anything else.
${JSON_ONLY} Keys:
isReview: "review" | "roundup" (several productions reviewed) | "preview" | "interview" | "news" | "other"
productionsReviewed: [{title, theatre|null, city|null}]
matchesProduction: "yes" | "no" | "unclear"
matchQuote: short verbatim quote that shows the theatre/company/city (or why it is a different production)
publishDateInText: "YYYY-MM-DD" | null (the article's own date line or metadata)
bylineInText: string | null (the critic who wrote THIS article)
outletInText: string | null
ratingInText: verbatim star/grade/score printed in the article | null
verdict: "rave" | "positive" | "mixed" | "negative" | "pan" | "unclear" (the critic's overall judgement)
notes: one short sentence

METADATA:
${meta || '(none)'}

ARTICLE:
${reviewExcerpt(text)}`;
}
function showPrompt(show, pageText, meta) {
  return `Extract facts about ONE theatre production from the web page text below. Production we are checking: "${show.title}" at ${show.venue || 'unknown venue'}. Use only what the page says; give dates as printed (assume the year of the current run if the page shows none and say so in runDatesVerbatim). Today is ${TODAY}.
${JSON_ONLY} Keys:
pageIsAboutProduction: "yes" | "no" | "unclear"
title: string | null   venue: string | null   city: string | null
previewStart: "YYYY-MM-DD" | null   opening: "YYYY-MM-DD" | null (press opening / first performance if no preview/opening distinction)   closing: "YYYY-MM-DD" | null (last performance)
runDatesVerbatim: the date text as printed
productionType: "local" (made by a resident company/theatre in the city) | "tour" (touring/visiting production) | "unclear"
status: "upcoming" | "running" | "closed" | "cancelled" | "unclear"
quote: short verbatim quote with the dates

META:
${meta || '(none)'}

PAGE:
${excerptAround(pageText, show.title)}`;
}
const imagePrompt = (show) => `This is the poster/key art for a theatre production. First read any text printed on the image. ${JSON_ONLY} Keys: visibleTitle (title text on the image or null), isPlaceholderOrBanner (true if it is a generic site banner, logo, theatre building photo, blank/placeholder, or clearly not key art for one specific production), description (one short sentence). Production it should depict: "${show.title}" (${show.venue || 'venue unknown'}).`;

// ---------- runners ----------
async function both(promptFn, opts = {}) {
  const [g, o] = await Promise.all([
    askGemini(promptFn.gemini || promptFn, opts.gemini || opts).catch((e) => `ERROR ${e.message}`),
    askOpenAI(promptFn.openai || promptFn, opts.openai || opts).catch((e) => `ERROR ${e.message}`),
  ]);
  return { gemini: A.parseJson(g) || { _raw: String(g).slice(0, 200) }, openai: A.parseJson(o) || { _raw: String(o).slice(0, 200) } };
}

async function runShows(L, limit) {
  const cache = loadCache(L.city, 'shows'); const stale = (c, h) => !c || (c.recHash !== undefined && c.recHash !== h); // rows cached before BRO-7256 carry no hash and stay valid
  const todo = L.shows.filter((s) => stale(cache.get(s.id), A.recordHash(s, A.SHOW_RECORD_FIELDS))).slice(0, limit);
  console.log(`shows: ${todo.length} to check (${cache.size} cached)`);
  await pool(todo, 4, async (s) => {
    const url = showPageUrl(s);
    const page = url ? await fetchPageText(url) : { error: 'no-url' };
    let src = 'page'; let ex;
    if (!page.error && page.text && fold(page.text).includes(fold(s.title).split(' ').slice(0, 2).join(' '))) {
      ex = await both(showPrompt(s, page.text, page.meta));
    } else {
      // no usable theatre page: both models search the web instead (blind; the query names title + venue only)
      src = page.error ? `search(${page.error})` : 'search(page-lacks-title)';
      const q = `Find the official run dates for the production "${s.title}" at ${s.venue || ''}. Search the theatre's own website first. ${showPrompt(s, '(use your web search instead of this page)', '')}`;
      const [g, o] = await Promise.all([askGemini(q, { grounded: true }).catch((e) => `ERROR ${e.message}`), askOpenAI(q, { search: true }).catch((e) => `ERROR ${e.message}`)]);
      ex = { gemini: A.parseJson(g) || { _raw: String(g).slice(0, 200) }, openai: A.parseJson(o) || { _raw: String(o).slice(0, 200) } };
    }
    const row = { id: s.id, recHash: A.recordHash(s, A.SHOW_RECORD_FIELDS), url: url || null, src, pageHash: page.text ? sha(page.text) : null, ...ex };
    appendCache(L.city, 'shows', row); return row;
  });
}

function posterPathFor(s) { return s.images && typeof s.images === 'object' ? s.images.poster || null : null; }

async function runImages(L, limit) {
  const cache = loadCache(L.city, 'images'); const todo = L.shows.filter((s) => !cache.has(s.id) || (cache.get(s.id) || {}).missing).slice(0, limit);
  console.log(`images: ${todo.length} to check`);
  await pool(todo, 4, async (s) => {
    const posterPath = posterPathFor(s); // the show's own images.poster (webp or jpg), never an assumed filename
    const p = posterPath && path.join(ROOT, 'public', posterPath.replace(/^\//, ''));
    if (!p || !fs.existsSync(p)) { const row = { id: s.id, missing: true, poster: posterPath || null }; appendCache(L.city, 'images', row); return row; }
    const image = { mime: /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/webp', b64: fs.readFileSync(p).toString('base64') };
    const ex = await both(imagePrompt(s), { image });
    const row = { id: s.id, ...ex }; appendCache(L.city, 'images', row); return row;
  });
}

async function runReviews(L, limit) {
  const cache = loadCache(L.city, 'reviews');
  const showBy = new Map(L.shows.map((s) => [s.id, s]));
  const all = [...L.reviews, ...L.excluded.map((e) => ({ ...e, row: null }))];
  const recOf = (it) => A.recordHash({ ...(it.row || {}), textHash: sha((it.file && (it.file.fullText || it.file.text)) || '') }, [...A.REVIEW_RECORD_FIELDS, 'textHash']);
  const todo = all.filter((it) => { const c = cache.get(it.id); return !c || (c.recHash !== undefined && c.recHash !== recOf(it)); }).slice(0, limit);
  console.log(`reviews: ${todo.length} to check (${cache.size} cached; ${L.reviews.length} published + ${L.excluded.length} excluded files)`);
  await pool(todo, 6, async (it) => {
    const showId = it.row ? it.row.showId : it.showId; const show = showBy.get(showId);
    const text = it.file && (it.file.fullText || it.file.text);
    if (!text || String(text).length < 200) {
      const row = { id: it.id, recHash: recOf(it), kind: it.kind, noText: true, textLen: text ? String(text).length : 0 }; appendCache(L.city, 'reviews', row); return row;
    }
    const meta = `url: ${it.file.url || ''}\nfetched: ${it.file.textFetchedAt || ''}`;
    const ex = await both(reviewPrompt({ ...show, city: L.hub.name }, text, meta));
    const row = { id: it.id, recHash: recOf(it), kind: it.kind, textHash: sha(text), ...ex }; appendCache(L.city, 'reviews', row); return row;
  });
}

// ---------- coverage (missing reviews) ----------
const C = require('./lib/city-hub-coverage');
/**
 * BRO-7291 class 7: the coverage gaps become an ingest plan (registry outlets) plus registry candidates (unknown
 * hosts), in dispatch-ingest-batch.js's format, at data/audit/city-hub-dual/<city>/ingest-plan.json.
 */
/** HTTP status per URL (0 = no answer), for dropping invented links before they reach the ingest plan. */
async function linkStatus(urls) {
  const out = new Map();
  for (const u of urls) {
    try {
      const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0' } });
      out.set(u, r.status);
    } catch { out.set(u, 0); }
  }
  return out;
}
async function writeIngestPlan(L, { checkLinks = true } = {}) {
  const cov = loadCache(L.city, 'coverage');
  const have = new Map();
  for (const x of L.reviews) {
    const h = have.get(x.row.showId) || { urls: new Set(), hosts: new Set() };
    h.urls.add(C.normUrl(x.row.url)); h.hosts.add(C.host(x.row.url || ''));
    have.set(x.row.showId, h);
  }
  const gaps = C.coverageGaps(L.shows, cov, have);
  const { resolveOutletFromUrl } = require('./lib/review-normalization');
  const status = checkLinks ? await linkStatus([...new Set(gaps.map((g) => g.url).filter((u) => !C.REDIRECT_HOSTS.test(C.host(u))))]) : null;
  const out = { generatedAt: new Date().toISOString(), city: L.city, gaps: gaps.length, ...C.ingestPlan(gaps, resolveOutletFromUrl, { status }) };
  const d = path.join(ROOT, 'data', 'audit', 'city-hub-dual', L.city); fs.mkdirSync(d, { recursive: true });
  saveAuditJson(path.join(d, 'ingest-plan.json'), out);
  const planned = Object.values(out.plan).reduce((n, v) => n + v.length, 0);
  console.error(`ingest plan: ${planned} URLs for ${Object.keys(out.plan).length} shows; ${Object.keys(out.registryCandidates).length} hosts not in the outlet registry; ${out.redirects} redirect links skipped; ${out.dead} dead links (404/410) dropped`);
  return out;
}
async function resolveRedirect(url) {
  if (!url || !C.REDIRECT_HOSTS.test(C.host(url))) return url;
  try { const r = await fetch(url, { redirect: 'manual' }); const loc = r.headers.get('location'); return loc && /^https?:/.test(loc) ? loc : url; } catch { return url; }
}
async function runCoverage(L, limit) {
  const cache = loadCache(L.city, 'coverage');
  const cutoff = A.addDays(TODAY, -120);
  const targets = L.shows.filter((s) => { const p = A.hubPhase(s, TODAY); return p === 'now' || (p === 'closed' && (s.closingDate || s.openingDate || '') >= cutoff); });
  const todo = targets.filter((s) => !cache.has(s.id)).slice(0, limit);
  console.log(`coverage: ${todo.length} to check of ${targets.length} now-playing/recent-closed (${cache.size} cached)`);
  await pool(todo, 3, async (s) => {
    const q = `List professional critic reviews (published reviews only, not previews, not ticket pages) of the stage production "${s.title}" at ${s.venue} (${L.hub.name}), run ${s.openingDate || ''} to ${s.closingDate || ''}. Look especially at: ${C.outletHint(L.reviews.map((x) => x.row)) || 'the main local newspapers and theatre sites'}. ${JSON_ONLY} Format: {"reviews":[{"outlet":"","critic":"","url":"","date":"YYYY-MM-DD"}]}. Only include reviews you found at a real URL.`;
    const [g, o] = await Promise.all([askGemini(q, { grounded: true }).catch((e) => `ERROR ${e.message}`), askOpenAI(q, { search: true }).catch((e) => `ERROR ${e.message}`)]);
    const row = { id: s.id, gemini: A.parseJson(g) || { _raw: String(g).slice(0, 200) }, openai: A.parseJson(o) || { _raw: String(o).slice(0, 200) } };
    // Grounded search returns short-lived redirect links (they 404 within days): resolve them now so the gap is ingestable.
    for (const m of ['gemini', 'openai']) for (const rv of ((row[m] || {}).reviews) || []) rv.url = await resolveRedirect(rv.url);
    appendCache(L.city, 'coverage', row); return row;
  });
}

// ---------- tour stops ----------
async function runTours(L, limit) {
  const cache = loadCache(L.city, 'tours'); const live = A.addDays(TODAY, -14); const todo = L.tours.filter((t) => t.end >= live && !cache.has(t.id)).slice(0, limit);
  console.log(`tour stops: ${todo.length} to check (${L.tours.length} total)`);
  await pool(todo, 3, async (t) => {
    const q = `Find the booked dates of the national tour of "${t.title}" at ${t.venue} in ${t.city}. Check the venue's own website or the tour's official site. ${JSON_ONLY} Keys: found (true/false), start ("YYYY-MM-DD"|null), end ("YYYY-MM-DD"|null), venue, quote (verbatim dates text), url.`;
    const [g, o] = await Promise.all([askGemini(q, { grounded: true }).catch((e) => `ERROR ${e.message}`), askOpenAI(q, { search: true }).catch((e) => `ERROR ${e.message}`)]);
    const row = { id: t.id, gemini: A.parseJson(g) || { _raw: String(g).slice(0, 200) }, openai: A.parseJson(o) || { _raw: String(o).slice(0, 200) } };
    appendCache(L.city, 'tours', row); return row;
  });
}

// ---------- pages (no LLM) ----------
async function checkPages(L) {
  const out = { hub: { problems: [] }, app: { problems: [] } };
  const res = await fetch(`https://broadwayscorecard.com/tours/${L.city}`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  out.hub.status = res.status;
  const live = A.parseLiveHub(await res.text());
  const exp = A.sectionHubShows(L.shows, L.city, L.hub.since, TODAY);
  const titles = (arr) => arr.map((s) => fold(s.title));
  const shown = (sec) => live[sec].map((x) => fold(x.title));
  const localTitles = new Set(L.shows.map((s) => fold(s.title)));
  const tourTitles = new Set(L.tours.map((t) => fold(t.title)));
  out.hub.counts = { now: live.now.length, soon: live.soon.length, closed: live.closed.length };
  out.hub.expectedLocal = { now: exp.now.length, soon: exp.soon.length, closedRecent: exp.closedRecent.length, archive: exp.archive.length };
  for (const [sec, arr] of [['now', exp.now], ['soon', exp.soon], ['closed', exp.closedRecent]]) {
    for (const t of titles(arr)) if (!shown(sec).includes(t)) out.hub.problems.push({ code: 'missing-from-section', section: sec, title: t });
  }
  const should = { now: new Set(titles(exp.now)), soon: new Set(titles(exp.soon)), closed: new Set(titles(exp.closedRecent)) };
  for (const sec of ['now', 'soon', 'closed']) {
    for (const t of shown(sec)) {
      const isLocal = localTitles.has(t); const isTour = tourTitles.has(t);
      if (isLocal && !should[sec].has(t) && !isTour) out.hub.problems.push({ code: 'wrong-section', section: sec, title: t });
      if (!isLocal && !isTour) out.hub.problems.push({ code: 'unknown-listing', section: sec, title: t });
    }
  }
  // app feed
  const fr = await fetch('https://broadwayscorecard.com/data/mobile-shows.json', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  const feed = (await fr.json()).shows.filter((x) => x.cy === L.city);
  const feedIds = new Set(feed.map((x) => x.id));
  out.app = { feedStatus: fr.status, feedCount: feed.length, webCount: L.shows.length, problems: [] };
  // generate-mobile-data.js leaves out a CLOSED show with no scored review (by design); anything else missing is a problem
  const scored = new Set(L.reviews.filter((r) => r.row.assignedScore != null).map((r) => r.row.showId));
  out.app.byDesignUnscoredClosed = [];
  for (const s of L.shows) {
    if (feedIds.has(s.id)) continue;
    if (s.status === 'closed' && !scored.has(s.id)) out.app.byDesignUnscoredClosed.push(s.id);
    else out.app.problems.push({ code: 'in-web-not-app', id: s.id, title: s.title });
  }
  const webIds = new Set(L.cityAll.map((s) => s.id));
  for (const f of feed) if (!webIds.has(f.id)) out.app.problems.push({ code: 'in-app-not-web', id: f.id, title: f.t });
  return out;
}

// ---------- report ----------
function saveAuditJson(dest, obj) { A.writeAuditJson(dest, obj); }
function triageFile(city) { const f = path.join(ROOT, 'data', 'audit', 'city-hub-dual', city, 'triage.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { items: {} }; }

function computeFlags(L) {
  const flags = []; // { kind, id, label, model, code, detail }
  const showBy = new Map(L.shows.map((s) => [s.id, s]));
  const sc = loadCache(L.city, 'shows'); const ic = loadCache(L.city, 'images'); const rc = loadCache(L.city, 'reviews');
  const checked = { shows: 0, images: 0, reviews: 0, excluded: 0, noText: 0, tours: 0, coverage: 0 };
  const add = (kind, id, label, model, fl) => fl.forEach((f) => flags.push({ kind, id, label, model, ...f }));
  for (const s of L.shows) {
    const r = sc.get(s.id); if (r) { checked.shows++; ['gemini', 'openai'].forEach((m) => add('show', s.id, s.title, m, A.showFlags(s, r[m]))); }
    const i = ic.get(s.id); if (i && !i.missing) { checked.images++; ['gemini', 'openai'].forEach((m) => add('image', s.id, s.title, m, A.imageFlags(s, i[m]))); }
    else if (i && i.missing) flags.push({ kind: 'image', id: s.id, label: s.title, model: 'local', code: 'no-poster', detail: i.poster ? `file missing: ${i.poster}` : 'show has no images.poster' });
    const fl = [];
    if (!s.closingDate && A.hubPhase(s, TODAY) !== 'closed') fl.push({ code: 'no-closing-date', detail: 'open show without closingDate' });
    if (s.closingDate && !s.closingDateSource && s.status !== 'closed' && A.hubPhase(s, TODAY) !== 'closed') fl.push({ code: 'closing-unsourced', detail: 'closingDateSource missing' });
    add('show', s.id, s.title, 'local', fl);
  }
  const textBy = new Map();
  for (const it of [...L.reviews, ...L.excluded]) {
    const r = rc.get(it.id); if (!r) continue;
    if (r.noText) { checked.noText++; continue; }
    const showId = it.row ? it.row.showId : it.showId; const show = showBy.get(showId);
    const label = `${show ? show.title : showId} | ${it.row ? `${it.row.outlet} / ${it.row.criticName}` : it.id}`;
    if (it.kind === 'published') {
      checked.reviews++;
      ['gemini', 'openai'].forEach((m) => add('review', it.id, label, m, A.reviewFlags(it.row, r[m], { opening: show && show.openingDate, closing: show && show.closingDate })));
      const q = A.quoteInText(it.row.pullQuote, it.file && (it.file.fullText || it.file.text));
      if (q === false) add('review', it.id, label, 'local', [{ code: 'pull-quote-not-in-text', detail: String(it.row.pullQuote).slice(0, 140) }]);
    } else {
      checked.excluded++;
      // an excluded file both models say IS this production and IS a review was possibly wrongly excluded
      ['gemini', 'openai'].forEach((m) => { const e = r[m] || {}; if (e.matchesProduction === 'yes' && e.isReview === 'review') add('excluded', it.id, label, m, [{ code: 'excluded-looks-valid', detail: `${e.matchQuote || ''} | flags on file: ${(it.file.wrongProduction || it.file.incompleteReason || '')}` }]); });
    }
  }
  // local review-level checks
  const seen = new Map();
  const runEndTexts = new Map();
  for (const it of L.reviews) {
    const k = `${it.row.showId}|${fold(it.row.outletId)}|${fold(it.row.criticName)}`;
    if (seen.has(k)) add('review', it.id, `${it.row.showId} | ${it.row.outlet}`, 'local', [{ code: 'duplicate-outlet-critic', detail: `also ${seen.get(k)}` }]); else seen.set(k, it.row.url);
    if (it.file && !it.file.wrongProduction && !it.file.wrongShow && !it.file.isRoundupArticle) {
      if (!runEndTexts.has(it.row.showId)) runEndTexts.set(it.row.showId, []);
      runEndTexts.get(it.row.showId).push({ text: it.file.fullText || it.file.text || '', url: it.row.url, articleDate: (it.row.publishDate || '').slice(0, 10) || null });
    }
    if (!it.file) add('review', it.id, `${it.row.showId} | ${it.row.outlet}`, 'local', [{ code: 'no-review-text-file', detail: it.row.url }]);
    if (!/^https?:/.test(it.row.url || '')) add('review', it.id, `${it.row.showId} | ${it.row.outlet}`, 'local', [{ code: 'no-url', detail: '' }]);
    const sb = A.starBandProblem(it.row.originalRating, it.row.assignedScore);
    if (sb) add('review', it.id, `${it.row.showId} | ${it.row.outlet}`, 'local', [{ code: 'star-band-record', detail: sb }]);
  }
  // BRO-7291 class 1: the same decision the daily writer (scripts/harvest-hub-run-dates.js) makes, so a finding here
  // means the writer would move the date too (or it is a pinned conflict). Listing dates come from its report.
  let listings = {};
  try { listings = readJson('data/audit/hub-run-dates.json').listings || {}; } catch { /* no report yet: texts only */ }
  for (const s of L.shows) {
    const r = A.showRunEndFinding(s, runEndTexts.get(s.id) || [], listings[s.id] || null);
    if (r) add('show', s.id, s.title, 'local', [{ code: 'review-text-later-closing', detail: `ours ${s.closingDate} / ${r.source}` }]);
  }
  // BRO-7291 class 3: a published review about the same title at another theatre in another state, and a stored
  // venue every outlet contradicts (octet-regional-2026: stored Goodman, seven outlets review Raven Theatre's).
  const V = require('./lib/regional-venue-mismatch');
  const cityVenues = L.shows.map((s) => s.venue).filter(Boolean);
  const textsBy = new Map();
  for (const it of L.reviews) {
    if (!it.file || it.file.wrongProduction || it.file.wrongShow || it.file.isRoundupArticle) continue;
    const show = showBy.get(it.row.showId); if (!show) continue;
    const rv = { fullText: it.file.fullText || it.file.text || '', url: it.row.url, outletId: it.row.outletId };
    const hit = V.regionalVenueMismatch(rv, show);
    if (hit) add('review', it.id, `${it.row.showId} | ${it.row.outlet}`, 'local', [{ code: 'review-other-venue', detail: `names ${hit.venue} (${hit.state}) ${hit.mentions}x, never ${show.venue}` }]);
    if (!textsBy.has(show.id)) textsBy.set(show.id, []);
    textsBy.get(show.id).push(rv);
  }
  for (const s of L.shows) {
    const d = V.showVenueDisagreement(s, textsBy.get(s.id) || [], cityVenues);
    if (d) add('show', s.id, s.title, 'local', [{ code: 'venue-contradicted', detail: `ours ${s.venue} / ${d.outlets.length} outlets name ${d.venue}: ${d.outlets.join(', ')}` }]);
  }
  // BRO-7291 class 4: a title typo copied from a listing ("Hangman" staged, every review prints "Hangmen").
  const T = require('./lib/title-spelling-check');
  const knownTitles = readJson('data/shows.json').shows.map((x) => x.title);
  for (const s of L.shows) {
    const texts = (textsBy.get(s.id) || []).map((x) => x.fullText);
    const t = T.titleSpellingFinding(s, texts, knownTitles.filter((x) => x !== s.title));
    if (t) add('show', s.id, s.title, 'local', [{ code: 'title-spelling', detail: `ours "${s.title}" (${t.ours}x) / reviews print "${t.title}" ${t.theirs}x in ${t.texts} texts` }]);
  }
  // duplicates by title
  const tcount = new Map(); for (const s of L.shows) { const k = `${fold(s.title)}|${fold(s.venue)}`; tcount.set(k, [...(tcount.get(k) || []), s.id]); }
  for (const [k, ids] of tcount) if (ids.length > 1) add('show', ids[0], k, 'local', [{ code: 'duplicate-show', detail: ids.join(', ') }]);
  const tc = loadCache(L.city, 'tours');
  for (const t of L.tours) {
    const r = tc.get(t.id); if (!r) continue; checked.tours++;
    ['gemini', 'openai'].forEach((m) => {
      const e = r[m] || {}; const d1 = A.dateDiffDays(t.start, e.start); const d2 = A.dateDiffDays(t.end, e.end);
      if (e.found === true && ((d1 != null && d1 > 2) || (d2 != null && d2 > 2))) add('tour', t.id, `${t.title} @ ${t.venue}`, m, [{ code: 'tour-dates', detail: `ours ${t.start}..${t.end} / source ${e.start}..${e.end} ${e.quote || ''}` }]);
    });
  }
  const cov = loadCache(L.city, 'coverage'); const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
  for (const s of L.shows) {
    const r = cov.get(s.id); if (!r) continue; checked.coverage++;
    const ours = L.reviews.filter((x) => x.row.showId === s.id); const oursHosts = new Set(ours.map((x) => host(x.row.url || ''))); const oursUrls = new Set(ours.map((x) => (x.row.url || '').replace(/\/+$/, '')));
    ['gemini', 'openai'].forEach((m) => (((r[m] || {}).reviews) || []).forEach((rv) => {
      if (!rv.url || oursUrls.has(rv.url.replace(/\/+$/, '')) || oursHosts.has(host(rv.url))) return;
      add('coverage', s.id, s.title, m, [{ code: 'missing-review-candidate', detail: `${rv.outlet} / ${rv.critic} ${rv.date} ${rv.url}` }]);
    }));
  }
  return { flags, checked };
}

function scorecard(L, triage) {
  const { flags, checked } = computeFlags(L);
  const itemSets = { gemini: new Set(), openai: new Set(), local: new Set(), all: new Set() };
  flags.forEach((f) => { const k = `${f.kind}:${f.id}`; itemSets[f.model].add(k); itemSets.all.add(k); });
  const t = triage.items || {};
  const confirmed = Object.values(t).filter((x) => x.verdict === 'confirmed');
  const fixed = confirmed.filter((x) => x.status === 'fixed');
  const remaining = confirmed.filter((x) => x.status !== 'fixed');
  return {
    city: L.city, today: TODAY, models: { gemini: GEMINI_MODEL, openai: OPENAI_MODEL },
    itemsChecked: { shows: checked.shows, images: checked.images, publishedReviews: checked.reviews, excludedFiles: checked.excluded, reviewsWithoutText: checked.noText, tourStops: checked.tours, coverageShows: checked.coverage, totalShows: L.shows.length, totalPublished: L.reviews.length },
    flaggedByGemini: itemSets.gemini.size, flaggedByOpenAI: itemSets.openai.size, flaggedLocalChecks: itemSets.local.size, flaggedAny: itemSets.all.size,
    flaggedByBoth: [...itemSets.gemini].filter((k) => itemSets.openai.has(k)).length,
    triagedItems: Object.keys(t).length, confirmed: confirmed.length, falsePositives: Object.values(t).filter((x) => x.verdict === 'false-positive').length,
    fixed: fixed.length, remaining: remaining.map((x) => ({ item: x.item, reason: x.reason })), untriaged: [...itemSets.all].filter((k) => !t[k]).length,
    flags,
  };
}

async function main() {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  const mode = process.argv[2];
  if (hasHelpFlag(process.argv) || !mode || mode.startsWith('--')) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^[\s\S]*?\/\*\*/, '')); return; }
  const city = arg('city'); if (!city || city === true) throw new Error('--city=<hub slug> required');
  spend.maxUsd = Number(arg('max-usd', 5));
  const limit = Number(arg('limit', 1e9));
  const L = loadCity(city);
  if (mode === 'inventory') {
    console.log(JSON.stringify({ city, shows: L.shows.length, published: L.reviews.length, withText: L.reviews.filter((r) => r.file).length, excludedFiles: L.excluded.length, tourStops: L.tours.length, phases: Object.fromEntries(Object.entries(A.sectionHubShows(L.shows, city, L.hub.since, TODAY)).map(([k, v]) => [k, v.length])) }, null, 1));
  } else if (mode === 'shows') await runShows(L, limit);
  else if (mode === 'images') await runImages(L, limit);
  else if (mode === 'reviews') await runReviews(L, limit);
  else if (mode === 'coverage') { await runCoverage(L, limit); await writeIngestPlan(L); }
  else if (mode === 'ingest-plan') await writeIngestPlan(L);
  else if (mode === 'tours') await runTours(L, limit);
  else if (mode === 'pages') console.log(JSON.stringify(await checkPages(L), null, 1));
  else if (mode === 'report') {
    const sc = scorecard(L, triageFile(city)); sc.pages = await checkPages(L);
    const brief = { ...sc, flags: undefined };
    console.log(JSON.stringify(brief, null, 1));
    if (arg('write')) {
      const d = path.join(ROOT, 'data', 'audit', 'city-hub-dual', city); fs.mkdirSync(d, { recursive: true });
      saveAuditJson(path.join(d, 'scorecard.json'), sc);
      await writeIngestPlan(L);
    }
    if (arg('flags')) saveAuditJson(arg('flags'), sc.flags);
  } else throw new Error(`unknown mode ${mode}`);
  if (spend.calls) {
    console.error(`spend: $${spend.usd.toFixed(3)} (gemini $${spend.gemini.toFixed(3)}, openai $${spend.openai.toFixed(3)}, ${spend.calls} calls)`);
    fs.appendFileSync(path.join(ROOT, 'data', 'audit', 'city-hub-dual', 'spend.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), city, mode, usd: +spend.usd.toFixed(4), calls: spend.calls })}\n`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message || e); process.exit(1); });
module.exports = { loadCity, computeFlags, scorecard, checkPages, writeIngestPlan };
