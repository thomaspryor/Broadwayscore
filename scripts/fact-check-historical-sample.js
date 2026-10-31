#!/usr/bin/env node
/**
 * fact-check-historical-sample.js — sourced sample audit of basic show facts
 * on a historical backfill (BRO-5080). Logic: scripts/lib/fact-check-sample.js.
 *
 *   sample  draw a seeded stratified sample and save its ids
 *   check   ask two independent web-grounded checkers (Gemini + Google Search
 *           grounding, OpenAI + web_search) for each sampled production's
 *           facts, fetch every cited page and record whether it states the
 *           value; plus synopsis judgement and poster transcription. Cached
 *           per show, so a re-run only pays for rows not yet checked.
 *   report  triage every field, merge the human adjudications file, print
 *           the per-field error table (wrong / checked, Wilson 95%).
 *   consistency  nyc-facts only: free whole-scope checks (venue registry,
 *           status vs dates, preview = opening), no model calls (BRO-6489).
 *   adjudicate-playbill  nyc-facts only: settle pending fields from
 *           validate-show-venue.js Playbill results (--results=a.json,b.json)
 *           and, with --pages, from the checkers' cited pages.
 *
 * Usage:
 *   node scripts/fact-check-historical-sample.js sample --cohort=we-historical --n=100 --seed=5080
 *   node scripts/fact-check-historical-sample.js sample --cohort=we-historical --season=2024-2025 --n=30
 *     (a season sample is cohort "we-historical-2024-2025" for check/report)
 *   node scripts/fact-check-historical-sample.js check  --cohort=we-historical [--limit=N] [--ids=a,b] [--max-usd=12] [--concurrency=4]
 *   node scripts/fact-check-historical-sample.js report --cohort=we-historical [--json] [--triage]
 *   node scripts/fact-check-historical-sample.js sample --cohort=nyc-facts --n=40 --seed=6489  (then check/report)
 *
 * Files (data/audit/fact-check/): <cohort>-sample.json (ids, seed, strata),
 * <cohort>-checks.jsonl (checker answers, cited URLs, support flags; no page
 * text), <cohort>-adjudications.json ({"<id>|<field>": {verdict, url, note}}).
 * Needs GEMINI_API_KEY and OPENAI_API_KEY for `check`.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const fc = require('./lib/fact-check-sample');
const { synopsisStoryProblems } = require('./lib/synopsis-story-audit');
const { nonStoryReason } = require('./lib/todaytix-page-identity');
const { foldDiacritics } = require('./lib/title-match');
const { hasHelpFlag } = require('./lib/cli-help');

if (require.main === module && (!process.argv[2] || hasHelpFlag(process.argv.slice(2)))) {
  console.log(fs.readFileSync(__filename, 'utf8').split("\n").slice(2, 30).join('\n'));
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'audit', 'fact-check');
const GEMINI_MODEL = 'gemini-2.5-flash';
const OPENAI_MODEL = 'gpt-5-mini';
// USD. Gemini 2.5 Flash: $0.30/M in, $2.50/M out (thinking billed as output),
// grounded prompt $0.035. gpt-5-mini: $0.25/M in, $2/M out, web search call $0.01.
const PRICE = {
  gemini: { in: 0.30e-6, out: 2.5e-6, grounded: 0.035 },
  openai: { in: 0.25e-6, out: 2e-6, search: 0.01 },
};

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? true : dflt;
}

function loadShows() {
  const p = arg('shows', path.join(ROOT, 'data', 'shows.json'));
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(j) ? j : j.shows;
}

/** Per-cohort fields and comparisons; cohorts without their own use the BRO-5080 set. */
function cohortImpl(cohort) {
  const c = fc.COHORTS[fc.parseCohortKey(cohort).base];
  return {
    fields: c.fields || fc.FACT_FIELDS,
    fieldKind: c.fieldKind || fc.FIELD_KIND,
    pageSupports: c.pageSupports || fc.pageSupports,
    storedValue: c.storedValue || fc.storedValue,
    compareField: c.compareField || fc.compareField,
    buildPrompt: c.buildPrompt ? (show) => c.buildPrompt(show, todayNy()) : (show) => fc.buildFactPrompt(show, cohort),
    skip: new Set(c.skip || []),
  };
}

function todayNy() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()); }

const files = (cohort) => ({
  sample: path.join(OUT_DIR, `${cohort}-sample.json`),
  checks: path.join(OUT_DIR, `${cohort}-checks.jsonl`),
  adjudications: path.join(OUT_DIR, `${cohort}-adjudications.json`),
});

function readChecks(file) {
  if (!fs.existsSync(file)) return new Map();
  const m = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; /* skip torn line */ }
    // merge=union can reorder rows (BRO-5261 retro-review): keep the newest
    // check per id by checkedAt, not whichever row happens to come last.
    const prev = m.get(r.id);
    if (!prev || !(Date.parse(prev.checkedAt) > Date.parse(r.checkedAt))) m.set(r.id, r);
  }
  return m;
}

// ---------- network ----------

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// tokens = model fees (capped by --max-usd); search = grounding/search-call fees at list price, reported apart.
const spend = { usd: 0, gemini: 0, openai: 0, search: 0 };

async function askGemini(parts, { grounded }) {
  // A real thinking budget (grounded fact lookups reason over search results)
  // with room left for the JSON answer; tests/unit/gemini-thinking-budget-guard.
  const body = { contents: [{ parts }], generationConfig: { thinkingConfig: { thinkingBudget: 2048 }, maxOutputTokens: 8192 } };
  if (grounded) body.tools = [{ google_search: {} }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 120000);
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
    if (j.error) throw new Error(`gemini: ${j.error.message}`);
    const u = j.usageMetadata || {};
    const cost = (u.promptTokenCount || 0) * PRICE.gemini.in + (u.toolUsePromptTokenCount || 0) * PRICE.gemini.in
      + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * PRICE.gemini.out;
    spend.usd += cost; spend.gemini += cost;
    if (grounded) spend.search += PRICE.gemini.grounded;
    const c = (j.candidates || [])[0] || {};
    const text = ((c.content || {}).parts || []).map((p) => p.text || '').join('');
    const chunks = ((c.groundingMetadata || {}).groundingChunks || []).map((g) => g.web && g.web.uri).filter(Boolean);
    return { text, chunks };
  }
  throw new Error('gemini: retries exhausted');
}

async function askOpenAI(content, { search }) {
  const body = { model: OPENAI_MODEL, input: [{ role: 'user', content }] };
  body.reasoning = { effort: 'low' };
  if (search) body.tools = [{ type: 'web_search', search_context_size: 'low' }];
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchWithTimeout('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(body),
    }, 240000);
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
    if (j.error) throw new Error(`openai: ${j.error.message}`);
    const u = j.usage || {};
    const searches = (j.output || []).filter((o) => o.type === 'web_search_call').length;
    const cost = (u.input_tokens || 0) * PRICE.openai.in + (u.output_tokens || 0) * PRICE.openai.out;
    spend.usd += cost; spend.openai += cost;
    spend.search += searches * PRICE.openai.search;
    const msg = (j.output || []).filter((o) => o.type === 'message').pop();
    const part = msg && (msg.content || []).find((c) => c.type === 'output_text');
    const chunks = ((part && part.annotations) || []).filter((a) => a.type === 'url_citation').map((a) => a.url);
    return { text: part ? part.text : '', chunks };
  }
  throw new Error('openai: retries exhausted');
}

const pageCache = new Map();
/** Resolve redirects (Gemini cites vertexaisearch redirect links) and return {url, text} or {url, error}. */
async function fetchPage(url) {
  if (!url || !/^https?:\/\//.test(url)) return { url, error: 'no-url' };
  if (pageCache.has(url)) return pageCache.get(url);
  const p = (async () => {
    try {
      const res = await fetchWithTimeout(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', accept: 'text/html,*/*' } }, 25000);
      const finalUrl = res.url || url;
      if (!res.ok) return { url: finalUrl, error: `http-${res.status}` };
      const html = (await res.text()).slice(0, 3_000_000);
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#8217;/g, "'").replace(/\s+/g, ' ');
      return { url: finalUrl, text };
    } catch (e) { return { url, error: e.name === 'AbortError' ? 'timeout' : 'fetch-failed' }; }
  })();
  pageCache.set(url, p);
  return p;
}

/** For each fact field: does the cited page state the answered value? */
async function supportFor(rawAnswer, impl = cohortImpl('we-historical')) {
  const answer = fc.normalizeAnswer(rawAnswer);
  const support = {}; const resolved = {};
  for (const field of impl.fields) {
    const f = answer && answer[field];
    if (!f || f.value == null || (Array.isArray(f.value) && !f.value.length)) continue;
    const page = await fetchPage(f.source);
    resolved[field] = page.error ? `${page.url} (${page.error})` : page.url;
    // Gemini cites redirect links: keep the resolved URL as the source, and never count our own site.
    if (!page.error && page.url) f.source = page.url;
    if (page.error || fc.isSelfSource(page.url)) { support[field] = false; continue; }
    const kind = impl.fieldKind[field];
    // 'run' items ({theatre, began, relation}) are checked whole by the cohort's pageSupports.
    const values = Array.isArray(f.value) ? f.value.map((v) => (v && typeof v === 'object' && kind !== 'run' ? v.name : v)) : [f.value];
    let ok = true;
    for (let i = 0; i < values.length; i++) {
      if (!values[i]) continue;
      const own = f.itemSources && f.itemSources[i] && f.itemSources[i] !== f.source ? await fetchPage(f.itemSources[i]) : page;
      if (own.error || fc.isSelfSource(own.url) || !impl.pageSupports(own.text, values[i], kind)) { ok = false; break; }
    }
    support[field] = ok;
  }
  return { support, resolved, answer };
}

// ---------- per-show checks ----------

function synopsisPrompt(show, cohort) {
  return `Use web search to learn what this theatre production is: "${show.title}", ${fc.cohortMarket(cohort)}, ${fc.productionTimePhrase(show)}.
Then judge this synopsis text a website shows for it:
"""${String(show.synopsis || '').slice(0, 2000)}"""
Return JSON only: {"describesThisWork": true|false (is it about this show's story/subject, not a different show of a similar name), "otherProductionDetails": ["any person, theatre, city or year in the text that belongs to a different production of this title than the one above"], "marketingCopy": true|false (mostly praise, booking or star-billing pitch rather than describing the story), "note": "one short sentence", "source": "url of a page describing this production"}`;
}

const POSTER_PROMPT = 'This image is used as the poster for a theatre production. Transcribe it. Return JSON only: {"title": "the show title as printed, or null", "people": ["every person name printed"], "venues": ["every theatre or venue name printed"], "places": ["city or district names printed, e.g. Broadway, West End, London, New York"], "years": ["any 4-digit years or dates printed"], "otherText": "other visible words, short", "isTheatreArt": true|false}';

function posterPath(show) {
  const p = show.images && (show.images.poster || show.images.thumbnail);
  if (!p || !p.startsWith('/images/')) return null;
  const file = path.join(ROOT, 'public', p);
  return fs.existsSync(file) ? file : null;
}

async function checkShow(show, cohort) {
  const out = { id: show.id, checkedAt: new Date().toISOString(), facts: {}, synopsis: {}, poster: {} };
  const impl = cohortImpl(cohort);
  const prompt = impl.buildPrompt(show);
  const runs = await Promise.allSettled([
    askGemini([{ text: prompt }], { grounded: true }),
    askOpenAI([{ type: 'input_text', text: prompt }], { search: true }),
  ]);
  for (const [i, name] of [[0, 'gemini'], [1, 'openai']]) {
    const r = runs[i];
    if (r.status !== 'fulfilled') { out.facts[name] = { error: String(r.reason && r.reason.message || r.reason).slice(0, 200) }; continue; }
    const { support, resolved, answer } = await supportFor(fc.parseJsonReply(r.value.text), impl);
    out.facts[name] = { answer, support, resolved, citations: [...new Set(r.value.chunks)].slice(0, 8) };
  }

  if (show.synopsis && !impl.skip.has('synopsis')) {
    out.synopsis.rules = synopsisStoryProblems(show, nonStoryReason);
    const sp = synopsisPrompt(show, cohort);
    const s = await Promise.allSettled([
      askGemini([{ text: sp }], { grounded: true }),
      askOpenAI([{ type: 'input_text', text: sp.replace(/^Use web search to learn/, 'From what you know, identify') }], { search: false }),
    ]);
    out.synopsis.gemini = s[0].status === 'fulfilled' ? fc.parseJsonReply(s[0].value.text) : { error: String(s[0].reason).slice(0, 200) };
    out.synopsis.openai = s[1].status === 'fulfilled' ? fc.parseJsonReply(s[1].value.text) : { error: String(s[1].reason).slice(0, 200) };
  }

  const pfile = impl.skip.has('poster') ? null : posterPath(show);
  if (pfile) {
    const ext = path.extname(pfile).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    const b64 = fs.readFileSync(pfile).toString('base64');
    out.poster.file = path.relative(ROOT, pfile);
    const v = await Promise.allSettled([
      askGemini([{ inline_data: { mime_type: mime, data: b64 } }, { text: POSTER_PROMPT }], { grounded: false }),
      askOpenAI([{ type: 'input_image', image_url: `data:${mime};base64,${b64}` }, { type: 'input_text', text: POSTER_PROMPT }], { search: false }),
    ]);
    out.poster.gemini = v[0].status === 'fulfilled' ? fc.parseJsonReply(v[0].value.text) : { error: String(v[0].reason).slice(0, 200) };
    out.poster.openai = v[1].status === 'fulfilled' ? fc.parseJsonReply(v[1].value.text) : { error: String(v[1].reason).slice(0, 200) };
  }
  return out;
}

// ---------- commands ----------

/** Re-normalize cached answers and re-fetch cited pages (no model calls). */
async function cmdResupport() {
  const f = files(arg('cohort'));
  const impl = cohortImpl(arg('cohort'));
  const checks = readChecks(f.checks);
  const out = [];
  for (const r of checks.values()) {
    for (const k of ['gemini', 'openai']) {
      const x = r.facts[k];
      if (!x || !x.answer) continue;
      const { support, resolved, answer } = await supportFor(x.answer, impl);
      // Never downgrade: a page that supported the value at check time and
      // fails now (throttled, moved) keeps its earlier support.
      for (const [field, v] of Object.entries(x.support || {})) if (v) support[field] = true;
      Object.assign(x, { answer, support, resolved: { ...(x.resolved || {}), ...resolved } });
    }
    out.push(JSON.stringify(r));
  }
  fs.writeFileSync(`${f.checks}.tmp`, out.join('\n') + '\n');
  fs.renameSync(`${f.checks}.tmp`, f.checks);
  console.log(`re-supported ${out.length} rows`);
}

function cmdSample() {
  const cohort = arg('season') ? `${arg('cohort')}-${arg('season')}` : arg('cohort');
  const n = Number(arg('n', 100));
  const seed = Number(arg('seed', 5080));
  const s = fc.drawSample(loadShows(), cohort, n, seed);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const f = files(cohort).sample;
  fs.writeFileSync(f, JSON.stringify({ ...s, drawnAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`${cohort}: sampled ${s.n} of ${s.population} (seed ${seed}) -> ${path.relative(ROOT, f)}`);
  console.log(JSON.stringify(s.strata));
}

async function cmdCheck() {
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY']) if (!process.env[k]) { console.error(`${k} not set`); process.exit(2); }
  require('./lib/gemini-usage-ledger').install();
  const cohort = arg('cohort');
  const f = files(cohort);
  const sample = JSON.parse(fs.readFileSync(f.sample, 'utf8'));
  const byId = new Map(loadShows().map((s) => [s.id, s]));
  const done = readChecks(f.checks);
  const only = arg('ids') ? new Set(String(arg('ids')).split(',')) : null;
  let todo = sample.ids.map((r) => r.id).filter((id) => (only ? only.has(id) : !done.has(id)));
  if (arg('limit')) todo = todo.slice(0, Number(arg('limit')));
  const maxUsd = Number(arg('max-usd', 12));
  const conc = Number(arg('concurrency', 4));
  console.log(`${cohort}: checking ${todo.length} shows (cap $${maxUsd})`);
  let i = 0; let stopped = false;
  async function worker() {
    while (i < todo.length && !stopped) {
      const id = todo[i++];
      if (spend.usd + spend.search >= maxUsd) { stopped = true; break; }
      const show = byId.get(id);
      if (!show) { console.log(`  ${id}: not in shows.json, skipped`); continue; }
      try {
        const r = await checkShow(show, cohort);
        fs.appendFileSync(f.checks, JSON.stringify(r) + '\n');
        console.log(`  ${id}: done (model $${spend.usd.toFixed(2)}, search $${spend.search.toFixed(2)})`);
      } catch (e) { console.log(`  ${id}: ERROR ${e.message}`); }
    }
  }
  await Promise.all([...Array(conc)].map(worker));
  console.log(`model fees: $${spend.usd.toFixed(2)} (gemini $${spend.gemini.toFixed(2)}, openai $${spend.openai.toFixed(2)}); search fees at list price: $${spend.search.toFixed(2)}${stopped ? ' — STOPPED at cap' : ''}`);
}

/** Triage rows for every sampled show: per fact field, plus synopsis and poster flags. */
function triage(cohort) {
  const f = files(cohort);
  const sample = JSON.parse(fs.readFileSync(f.sample, 'utf8'));
  const byId = new Map(loadShows().map((s) => [s.id, s]));
  const checks = readChecks(f.checks);
  const market = fc.parseCohortKey(cohort).base === 'we-historical' ? 'west-end' : 'broadway';
  const impl = cohortImpl(cohort);
  const shows = [...byId.values()];
  const rows = [];
  for (const { id, stratum } of sample.ids) {
    const show = byId.get(id); const c = checks.get(id);
    if (!show || !c) continue;
    const cs = ['gemini', 'openai'].map((k) => ({ checker: k, answer: c.facts[k] && c.facts[k].answer, support: c.facts[k] && c.facts[k].support }));
    for (const field of impl.fields) {
      if (field === 'otherRuns') {
        const t = require('./lib/nyc-facts-audit').otherRunsTriage(show, shows, cs.map((x) => ({ ...x, answer: fc.normalizeAnswer(x.answer) })));
        rows.push({ id, stratum, title: show.title, field, stored: (show.priorRuns || []).map((p) => p.venue), status: t.status, detail: t.runs });
        continue;
      }
      const t = fc.triageField(field, show, cs, market, impl);
      rows.push({ id, stratum, title: show.title, field, stored: impl.storedValue(show, field), status: t.status, detail: t.detail });
    }
    if (impl.skip.has('category')) continue; // nyc-facts checks category as its own `tier` field and skips synopsis/poster
    // Category = market. Flag when a checker places the production outside it.
    const cities = cs.map((x) => { const a = fc.normalizeAnswer(x.answer); return a && a.city && a.city.value; }).filter(Boolean).map(String);
    const wrongCity = cities.filter((x) => (market === 'west-end' ? !/london/i.test(x) : !/new york|manhattan|broadway/i.test(x)));
    rows.push({ id, title: show.title, field: 'category', stored: show.category, status: show.category ? (wrongCity.length ? 'adjudicate' : (cities.length ? 'ok' : 'unsourced')) : 'not-stored', detail: cities });
    if (show.synopsis) {
      const s = c.synopsis || {};
      const flags = [];
      if (s.rules && s.rules.hard && s.rules.hard.length) flags.push(`rule-hard: ${s.rules.hard.join('; ')}`);
      if (s.rules && s.rules.soft && s.rules.soft.length) flags.push(`rule-soft: ${s.rules.soft.map((x) => x.reason).join('; ')}`);
      for (const k of ['gemini', 'openai']) {
        const j = s[k];
        if (!j || j.error) continue;
        if (j.describesThisWork === false) flags.push(`${k}: not this work (${j.note || ''})`);
        if (Array.isArray(j.otherProductionDetails) && j.otherProductionDetails.length) flags.push(`${k}: other-production ${JSON.stringify(j.otherProductionDetails)}`);
        if (j.marketingCopy === true) flags.push(`${k}: marketing copy`);
      }
      rows.push({ id, title: show.title, field: 'synopsis', stored: String(show.synopsis).slice(0, 160), status: flags.length ? 'adjudicate' : 'ok', detail: flags });
    } else rows.push({ id, title: show.title, field: 'synopsis', status: 'not-stored' });
    // The row's CURRENT art decides: art cleared since the check is "not stored", not still wrong.
    const currentArt = show.images && (show.images.poster || show.images.thumbnail);
    if (c.poster && c.poster.file && currentArt) {
      const flags = [];
      const tnorm = (s) => foldDiacritics(String(s || '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
      for (const k of ['gemini', 'openai']) {
        const j = c.poster[k];
        if (!j || j.error) continue;
        if (j.title && !tnorm(j.title).includes(tnorm(show.title).slice(0, 12)) && !tnorm(show.title).includes(tnorm(j.title).slice(0, 12))) flags.push(`${k}: title "${j.title}"`);
        const places = (j.places || []).join(' ');
        if (market === 'west-end' ? /broadway|new york/i.test(places) : /west end|london/i.test(places)) flags.push(`${k}: place ${places}`);
        for (const v of j.venues || []) if (show.venue && !fc.sameVenue(v, show.venue, market)) flags.push(`${k}: venue "${v}"`);
        const yrs = (j.years || []).map((y) => String(y).match(/(19|20)\d\d/)).filter(Boolean).map((m) => Number(m[0]));
        const sy = Number(String(show.season || show.openingDate || '').slice(0, 4));
        for (const y of yrs) if (sy && (y < sy - 1 || y > sy + 2)) flags.push(`${k}: year ${y}`);
        if (j.isTheatreArt === false) flags.push(`${k}: not theatre art`);
        if ((j.people || []).length) flags.push(`${k}: people ${JSON.stringify(j.people.slice(0, 6))}`);
      }
      const hard = flags.filter((x) => !/: people /.test(x));
      rows.push({ id, title: show.title, field: 'poster', stored: c.poster.file, status: hard.length ? 'adjudicate' : (flags.length ? 'people-check' : 'ok'), detail: flags });
    } else rows.push({ id, title: show.title, field: 'poster', status: 'not-stored' });
  }
  return rows;
}

/** Final per-field verdicts for a cohort: adjudication first, then triage. */
function verdictsFor(cohort) {
  const f = files(cohort);
  if (!fs.existsSync(f.sample) || !fs.existsSync(f.checks)) return [];
  const adj = fs.existsSync(f.adjudications) ? JSON.parse(fs.readFileSync(f.adjudications, 'utf8')) : {};
  return triage(cohort).map((r) => {
    const a = adj[`${r.id}|${r.field}`];
    // An adjudication judged the value stored THEN (judgedStored). Once the row
    // changes, a fix that matches correctValue counts correct; anything else
    // needs a fresh look rather than the old verdict.
    const stale = a && 'judgedStored' in a && JSON.stringify(a.judgedStored) !== JSON.stringify(r.stored);
    if (stale && a.correctValue != null && JSON.stringify(a.correctValue) === JSON.stringify(r.stored)) {
      return { id: r.id, field: r.field, verdict: 'correct', url: a.url, note: `fixed: ${a.note || ''}` };
    }
    // A stale adjudication says nothing about the new value: fall through to triage.
    if (a && !stale) return { id: r.id, field: r.field, verdict: a.verdict, url: a.url, note: a.note };
    if (r.status === 'ok' || r.status === 'ok-cited') return { id: r.id, field: r.field, verdict: 'correct', weak: r.status === 'ok-cited' };
    if (r.status === 'not-stored') return { id: r.id, field: r.field, verdict: 'not-stored' };
    return { id: r.id, field: r.field, verdict: r.status === 'adjudicate' || r.status === 'people-check' ? 'pending' : 'unverifiable' };
  });
}

function cmdReport() {
  const cohort = arg('cohort');
  const rows = triage(cohort);
  if (arg('triage')) {
    const want = String(arg('status', 'adjudicate')).split(',');
    const fld = arg('field');
    for (const r of rows.filter((x) => want.includes(x.status) && (!fld || x.field === fld))) console.log(JSON.stringify(r));
    return;
  }
  const verdicts = verdictsFor(cohort);
  const asTable = (vs) => fc.errorTable(vs.map((v) => (v.verdict === 'pending' ? { ...v, verdict: 'unverifiable' } : v)));
  const table = asTable(verdicts);
  const pending = verdicts.filter((v) => v.verdict === 'pending').length;
  // An equal-allocation sample over-weights small strata: the pooled rate is not a
  // population rate, so report each stratum on its own (BRO-6489).
  const sample = JSON.parse(fs.readFileSync(files(cohort).sample, 'utf8'));
  const stratumOf = new Map(sample.ids.map((r) => [r.id, r.stratum]));
  const byStratum = {};
  for (const k of new Set(sample.ids.map((r) => r.stratum))) byStratum[k] = asTable(verdicts.filter((v) => stratumOf.get(v.id) === k));
  if (arg('json')) { console.log(JSON.stringify({ cohort, table, byStratum, strata: sample.strata, pending, wrong: verdicts.filter((v) => v.verdict === 'wrong') }, null, 2)); return; }
  console.log(`${cohort}: ${new Set(rows.map((r) => r.id)).size} shows checked; ${pending} field verdicts still pending adjudication`);
  const print = (tbl) => {
    console.log('field          wrong/checked   rate    95% CI          unverifiable  not stored');
    for (const [field, t] of Object.entries(tbl)) {
      console.log(`${field.padEnd(14)} ${`${t.wrong}/${t.checked}`.padEnd(15)} ${(t.rate * 100).toFixed(1).padStart(5)}%  ${(t.ci95[0] * 100).toFixed(1)}-${(t.ci95[1] * 100).toFixed(1)}%`.padEnd(64) + `${String(t.unverifiable).padEnd(13)} ${t.notStored}`);
    }
  };
  print(table);
  if (fc.COHORTS[fc.parseCohortKey(cohort).base].allocation === 'equal') {
    for (const [k, tbl] of Object.entries(byStratum)) { console.log(`\n[${k}] population ${(sample.strata[k] || {}).population}`); print(tbl); }
  }
}

/** Free whole-scope NYC checks (nyc-facts-audit consistencyFindings); no model calls. */
function cmdConsistency() {
  const findings = require('./lib/nyc-facts-audit').consistencyFindings(loadShows(), todayNy());
  const counts = {};
  for (const f of findings) counts[f.class] = (counts[f.class] || 0) + 1;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, 'nyc-facts-consistency.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), counts, findings }, null, 2) + '\n');
  console.log(JSON.stringify(counts));
  if (arg('list')) for (const f of findings.filter((x) => !arg('class') || x.class === arg('class'))) console.log(`${f.class}\t${f.id}\t${f.detail}`);
  console.log(`-> ${path.relative(ROOT, out)}`);
}

/**
 * nyc-facts only: settle pending fields from Playbill production pages, as
 * parsed by validate-show-venue.js (--results=a.json,b.json, each written via
 * VENUE_AUDIT_PATH). Adds an adjudication per field Playbill settles
 * (nyc-facts-audit playbillVerdict) and, with --pages, per field the
 * checkers' cited pages settle (pagesVerdict, by: 'pages-auto'; counted in
 * the error table, never a basis for a row fix). Never replaces an existing one.
 */
function cmdAdjudicatePlaybill() {
  const cohort = arg('cohort');
  const { playbillVerdict, pagesVerdict, nycStoredValue } = require('./lib/nyc-facts-audit');
  const pbById = new Map();
  for (const f of String(arg('results', '')).split(',').filter(Boolean)) {
    for (const r of JSON.parse(fs.readFileSync(f, 'utf8')).results || []) pbById.set(r.id, r);
  }
  const showById = new Map(loadShows().map((s) => [s.id, s]));
  const f = files(cohort);
  const adj = fs.existsSync(f.adjudications) ? JSON.parse(fs.readFileSync(f.adjudications, 'utf8')) : {};
  const counts = {};
  for (const r of triage(cohort).filter((x) => x.status === 'adjudicate')) {
    const key = `${r.id}|${r.field}`;
    if (adj[key]) continue;
    const show = showById.get(r.id);
    if (!show) continue;
    let v = playbillVerdict(r.field, show, (r.detail || []).map((d) => d.value), pbById.get(r.id));
    let by = 'playbill-auto';
    if (!v && arg('pages')) { v = pagesVerdict(r.field, show, r.detail); by = 'pages-auto'; }
    if (!v) continue;
    adj[key] = { ...v, judgedStored: nycStoredValue(show, r.field), by };
    counts[`${by}:${r.field}:${v.verdict}`] = (counts[`${by}:${r.field}:${v.verdict}`] || 0) + 1;
  }
  if (!arg('dry-run')) fs.writeFileSync(f.adjudications, JSON.stringify(adj, null, 2) + '\n');
  console.log(JSON.stringify(counts));
}

/**
 * nyc-facts only: write Playbill-validated pending-fix plans (data/pending-fixes/
 * <prefix>-N.json, 25 edits each) from the playbill-auto "wrong" adjudications.
 * --hold=id,id skips rows whose production identity a person must settle.
 */
function cmdPlanPlaybill() {
  const cohort = arg('cohort');
  const prefix = arg('prefix');
  if (!prefix) throw new Error('--prefix=<plan file stem> is required');
  const { buildPlaybillFixActions } = require('./lib/nyc-facts-audit');
  const crypto = require('crypto');
  const adj = JSON.parse(fs.readFileSync(files(cohort).adjudications, 'utf8'));
  const hold = new Set(String(arg('hold', '')).split(',').filter(Boolean));
  const { actions, held } = buildPlaybillFixActions(adj, new Map(loadShows().map((s) => [s.id, s])), hold);
  for (let i = 0; i * 25 < actions.length; i++) {
    const acts = actions.slice(i * 25, i * 25 + 25);
    const name = `${prefix}-${i + 1}`;
    const rows = new Set(acts.map((a) => a.showId)).size;
    const plan = {
      issueNumber: name, planId: crypto.randomUUID(), status: 'pending', createdAt: new Date().toISOString(), submitter: { name: null, email: null },
      plan: {
        summary: `${prefix}: ${acts.length} edits on ${rows} rows where the Playbill production page (venue and year matched) contradicts the stored value and a checker agreed with Playbill`,
        steps: acts.map((a) => `shows.json: ${a.showId}.${a.field}`), riskLevel: 'low', actions: acts,
      },
    };
    if (!arg('dry-run')) fs.writeFileSync(path.join(ROOT, 'data', 'pending-fixes', `${name}.json`), JSON.stringify(plan, null, 1) + '\n');
    console.log(name, acts.length, 'edits', rows, 'rows');
  }
  console.log('held:', held.join('; ') || '(none)');
}

if (require.main === module) {
  const cmd = process.argv[2];
  const run = { sample: cmdSample, check: cmdCheck, report: cmdReport, resupport: cmdResupport, consistency: cmdConsistency, 'adjudicate-playbill': cmdAdjudicatePlaybill, 'plan-playbill': cmdPlanPlaybill }[cmd];
  if (!run) { console.error(`unknown command ${cmd}`); process.exit(2); }
  if (cmd !== 'consistency' && !arg('cohort')) { console.error(`${cmd} needs --cohort=<name> (e.g. we-historical, nyc-facts)`); process.exit(2); }
  Promise.resolve(run()).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = { triage, checkShow, verdictsFor, files };
