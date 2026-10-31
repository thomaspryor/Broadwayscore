#!/usr/bin/env node
// hygiene-help-flag-ok: all work happens inside subcommands; --help is handled first in the main IIFE and runs nothing before it
/**
 * audit-review-crossmodel.js — non-Claude (Gemini + OpenAI) audit of the
 * historical backfill at REVIEW level (BRO-5951). Companion of
 * fact-check-historical-sample.js, which covers show facts.
 *
 *   completeness  per sampled production, a web-grounded Gemini search lists the
 *                 major-outlet reviews it should have; diff against reviews.json
 *                 (and review-texts, if present) and verify each apparent miss by
 *                 fetching the cited page. Metadata only, no prose is stored.
 *   pages         per sampled review, fetch the cited page and ask Gemini AND
 *                 OpenAI (no search) for publish date, critic, outlet and whether
 *                 the page reviews THIS production. Compare to our row. Page text
 *                 is sent to the model and never written to disk or logs.
 *   report        per-cohort error rates (wrong / checked, Wilson 95%).
 *
 *   node scripts/audit-review-crossmodel.js inventory
 *   node scripts/audit-review-crossmodel.js completeness --cohort=we-2023-2024 --n=15 [--max-usd=8]
 *   node scripts/audit-review-crossmodel.js pages --cohort=bw-historical --n=60 [--max-usd=4]
 *   node scripts/audit-review-crossmodel.js report [--cohort=...] [--json]
 *
 * Cohorts: we-<YYYY-YYYY> (we-historical:* by season), bw-historical (Broadway,
 * tag "historical"), ob-historical (Off-Broadway, tag "historical").
 * Cache: data/audit/crossmodel/<check>-<cohort>.jsonl (resumable, one row per id).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isBroadwayCategory } = require('./lib/venue-classification');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'data', 'audit', 'crossmodel');
const GEMINI_MODEL = 'gemini-2.5-flash';
const OPENAI_MODEL = 'gpt-5-mini';
const PRICE = {
  gemini: { in: 0.30e-6, out: 2.5e-6, grounded: 0.035 },
  openai: { in: 0.25e-6, out: 2e-6 },
};
const spend = { usd: 0, gemini: 0, openai: 0 };

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  if (a) return a.slice(n.length + 3);
  return process.argv.includes(`--${n}`) ? true : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(p) { return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8')); }
function loadShows() { const j = loadJson('data/shows.json'); return Array.isArray(j) ? j : j.shows; }

// ---------- cohorts ----------
const isHist = (s) => Array.isArray(s.tags) && s.tags.includes('historical');
const COHORT_FILTERS = {
  'bw-historical': (s) => s.market === 'broadway' && isBroadwayCategory(s) && isHist(s),
  'ob-historical': (s) => require('./lib/ob-historical-cohort').isObHistoricalRow(s),
};
function cohortFilter(c) {
  if (COHORT_FILTERS[c]) return COHORT_FILTERS[c];
  const m = /^we-(\d{4}-\d{4})$/.exec(c);
  if (m) return (s) => String(s.discoverySource || '').startsWith('we-historical') && s.season === m[1];
  if (c === 'we-all') return (s) => String(s.discoverySource || '').startsWith('we-historical');
  throw new Error(`unknown cohort ${c}`);
}
function stratum(c, s) {
  if (c === 'bw-historical') { const y = parseInt(String(s.openingDate || '').slice(0, 4), 10); return Number.isFinite(y) ? `${Math.floor(y / 10) * 10}s` : 'undated'; }
  return 'all';
}
const h = (seed, id) => crypto.createHash('sha1').update(`${seed}|${id}`).digest('hex');
/** Deterministic stratified draw: n total, allocated proportionally to stratum size (min 1). */
function drawShows(shows, c, n, seed, keep = () => true) {
  const rows = shows.filter(cohortFilter(c)).filter(keep);
  const strata = new Map();
  for (const r of rows) { const k = stratum(c, r); (strata.get(k) || strata.set(k, []).get(k)).push(r); }
  const out = [];
  for (const [k, list] of strata) {
    list.sort((a, b) => h(seed, a.id).localeCompare(h(seed, b.id)));
    const take = n >= rows.length ? list.length : Math.max(1, Math.round((n * list.length) / rows.length));
    for (const r of list.slice(0, take)) out.push({ show: r, stratum: k });
  }
  return { rows: rows.length, picked: out };
}

// ---------- models ----------
async function fetchT(url, opts = {}, ms = 30000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
async function askGemini(prompt, { grounded, urlctx } = {}) {
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { thinkingConfig: { thinkingBudget: grounded ? 2048 : 512 }, maxOutputTokens: 8192 } };
  if (grounded) body.tools = [{ google_search: {} }];
  if (urlctx) body.tools = [{ url_context: {} }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  for (let a = 0; a < 3; a++) {
    const res = await fetchT(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 120000);
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) { await sleep(5000 * (a + 1)); continue; }
    if (j.error) throw new Error(`gemini: ${j.error.message}`);
    const u = j.usageMetadata || {};
    const cost = ((u.promptTokenCount || 0) + (u.toolUsePromptTokenCount || 0)) * PRICE.gemini.in + ((u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0)) * PRICE.gemini.out + (grounded ? PRICE.gemini.grounded : 0);
    spend.usd += cost; spend.gemini += cost;
    const c = (j.candidates || [])[0] || {};
    return ((c.content || {}).parts || []).map((p) => p.text || '').join('');
  }
  throw new Error('gemini: retries exhausted');
}
async function askOpenAI(prompt) {
  const body = { model: OPENAI_MODEL, input: [{ role: 'user', content: prompt }], reasoning: { effort: 'low' } };
  for (let a = 0; a < 3; a++) {
    const res = await fetchT('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(body) }, 240000);
    const j = await res.json().catch(() => ({}));
    if (res.status === 429 || res.status >= 500) { await sleep(5000 * (a + 1)); continue; }
    if (j.error) throw new Error(`openai: ${j.error.message}`);
    const u = j.usage || {};
    const cost = (u.input_tokens || 0) * PRICE.openai.in + (u.output_tokens || 0) * PRICE.openai.out;
    spend.usd += cost; spend.openai += cost;
    return (j.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []).map((c) => c.text || '').join('');
  }
  throw new Error('openai: retries exhausted');
}
function parseJson(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(text) || [null, text];
  const s = m[1]; const i = s.search(/[{[]/); if (i < 0) return null;
  for (let e = s.length; e > i; e--) { try { return JSON.parse(s.slice(i, e)); } catch (_) { /* shrink */ } }
  return null;
}

// ---------- page fetch (text kept in memory only) ----------
const pageCache = new Map();
// Blocked pages (403, paywalls) go through the repo's provider chain; billed at ~$0.003/page, counted in spend.
const CHAIN_USD = 0.003; let chainPages = 0;
async function viaChain(url) {
  if (arg('no-chain') || spend.usd >= Number(arg('max-usd', 1e9))) return null;
  try {
    const { fetchPage: chain } = require('./lib/scraper');
    const r = await chain(url);
    if (!r || !r.content) return null;
    chainPages++; spend.usd += CHAIN_USD; spend.chain = (spend.chain || 0) + CHAIN_USD;
    return String(r.content).slice(0, 3_000_000);
  } catch (_) { return null; }
}
function fetchPage(url) {
  if (!url || !/^https?:\/\//.test(url)) return Promise.resolve({ url, error: 'no-url' });
  if (pageCache.has(url)) return pageCache.get(url);
  const p = (async () => {
    try {
      const res = await fetchT(url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36', accept: 'text/html,*/*' } }, 25000);
      const finalUrl = res.url || url;
      let html;
      if (!res.ok) {
        html = await viaChain(url);
        if (!html) return { url: finalUrl, error: `http-${res.status}` };
      } else html = (await res.text()).slice(0, 3_000_000);
      const meta = [...html.matchAll(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished|og:published_time|author|article:author|og:site_name|date|pubdate)["'][^>]*>/gi)].map((m) => m[0]).join('\n');
      const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].slice(0, 1500)).join('\n');
      const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0?39;|&rsquo;|&#8217;/g, "'").replace(/\s+/g, ' ');
      return { url: finalUrl, text, meta: `${meta}\n${ld}` };
    } catch (e) { return { url, error: e.name === 'AbortError' ? 'timeout' : 'fetch-failed' }; }
  })();
  pageCache.set(url, p);
  return p;
}

// ---------- normalisation ----------
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const host = (u) => { try { const h = new URL(u).hostname.replace(/^www\./, ''); const p = h.split('.'); const sl = /^(co|com|org|net|ac|gov)$/.test(p[p.length - 2] || '') && p[p.length - 1].length === 2; return p.slice(sl ? -3 : -2).join('.'); } catch (_) { return ''; } };
const OUTLET_STOP = new Set(['the', 'new', 'york', 'london', 'uk', 'com', 'online', 'theatre', 'theater', 'review', 'reviews']);
const outletKey = (s) => fold(s).split(' ').filter((w) => !OUTLET_STOP.has(w)).join('');
function sameOutlet(a, b) { const x = outletKey(a) || fold(a).replace(/ /g, ''); const y = outletKey(b) || fold(b).replace(/ /g, ''); return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)))); }
function nameTokens(s) { return fold(s).split(' ').filter((w) => w.length > 1); }
function sameCritic(a, b) {
  const x = nameTokens(a); const y = nameTokens(b); if (!x.length || !y.length) return false;
  const lastX = x[x.length - 1]; const lastY = y[y.length - 1];
  if (lastX === lastY) return x.length < 2 || y.length < 2 || x[0] === y[0] || x[0].startsWith(y[0]) || y[0].startsWith(x[0]); return x.every((t) => y.includes(t)) || y.every((t) => x.includes(t));
}

function wilson(k, n) {
  if (!n) return [0, 0];
  const z = 1.96; const p = k / n; const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d; const m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}
const pct = (k, n) => (n ? `${((100 * k) / n).toFixed(1)}% (${k}/${n}, CI ${wilson(k, n).map((x) => (100 * x).toFixed(0)).join('-')}%)` : 'n/a');

// ---------- data ----------
function reviewsByShow() {
  const m = new Map();
  for (const r of loadJson('data/reviews.json').reviews) (m.get(r.showId) || m.set(r.showId, []).get(r.showId)).push(r);
  return m;
}
const registry = () => { const o = loadJson('data/outlet-registry.json').outlets || {}; return o; };

const rowKey = (r) => (r.key ? `${r.key}|${r.outletId || ''}|${r.ours ?? ''}` : r.id);
function readRows(file) {
  const m = new Map();
  if (!fs.existsSync(file)) return m;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); m.set(rowKey(r), r); } catch (_) { /* torn */ } }
  return m;
}
const outFile = (check, c) => path.join(OUT, `${check}-${c}.jsonl`);

async function pool(items, conc, fn, stop) {
  let i = 0;
  await Promise.all([...Array(conc)].map(async () => { while (i < items.length && !stop()) await fn(items[i++]); }));
}

// ---------- completeness ----------
const OUTLETS = {
  broadway: 'The New York Times, Variety, Vulture / New York Magazine, The Hollywood Reporter, Time Out New York, The New Yorker, The Washington Post, The Wall Street Journal, New York Post, New York Daily News, Newsday, TheaterMania, Associated Press, The Guardian, Entertainment Weekly, Chicago Tribune, Deadline, Theatrely, Broadway News, BroadwayWorld, Talkin\' Broadway, Curtain Up, Theatermania, Backstage',
  'west-end': 'The Guardian, The Telegraph, The Times, The Independent, Evening Standard, The Stage, Financial Times, Time Out London, WhatsOnStage, Daily Mail, The Mirror, The Sunday Times, The Observer, Variety, The Hollywood Reporter, London Theatre, BroadwayWorld UK, Broadway World, The Arts Desk, Culture Whisper, Daily Express, The Upcoming',
};
function completenessPrompt(show) {
  const wePrefix = show.market === 'west-end';
  const where = wePrefix ? 'London (West End / off-West End)' : 'New York';
  return `Use web search. Find the professional critic reviews of this specific production: "${show.title}", ${show.venue ? `at ${show.venue}, ` : ''}${where}${show.openingDate ? `, opened ${show.openingDate}` : ''}${show.season ? `, season ${show.season}` : ''}.
Only reviews of THIS production and run (not a different production or revival of the same title). Look at these outlets first: ${wePrefix ? OUTLETS['west-end'] : OUTLETS.broadway}; also include any review roundup page (Broadway World review roundup, Playbill Verdict, Show-Score, Did He Like It, London Theatre Direct) and any other major outlet you find.
Return ONLY JSON: {"reviews":[{"outlet":"...","critic":"...","url":"https://...","date":"YYYY-MM-DD or null"}],"roundups":[{"name":"...","url":"https://..."}],"note":"..."}. Include a review only if you found its real URL. Do not invent reviews; an empty list is a valid answer.`;
}

async function cmdCompleteness() {
  const c = arg('cohort'); const n = Number(arg('n', 15)); const seed = arg('seed', 5951);
  const maxUsd = Number(arg('max-usd', 8));
  const shows = loadShows(); const rv = reviewsByShow(); const reg = registry();
  const textsDir = ['data/review-texts', '/home/user/broadway-review-texts/data/review-texts', '/home/user/broadway-review-texts'].map((p) => path.isAbsolute(p) ? p : path.join(ROOT, p)).find((p) => fs.existsSync(p));
  const { rows, picked } = drawShows(shows, c, n, seed);
  const file = outFile('completeness', c); fs.mkdirSync(OUT, { recursive: true });
  const done = readRows(file);
  const todo = picked.filter((p) => !done.has(p.show.id));
  console.log(`${c}: population ${rows}, sample ${picked.length}, to check ${todo.length}, cap $${maxUsd}`);
  await pool(todo, Number(arg('concurrency', 4)), async ({ show, stratum: st }) => {
    try {
      const text = await askGemini(completenessPrompt(show), { grounded: true });
      const ans = parseJson(text) || { reviews: [] };
      const ours = rv.get(show.id) || [];
      const excluded = textsDir && fs.existsSync(path.join(textsDir, show.id)) ? fs.readdirSync(path.join(textsDir, show.id)).filter((f) => f.endsWith('.json')) : [];
      const found = [];
      for (const r of (ans.reviews || [])) {
        if (!r || !r.url) continue;
        const have = ours.find((o) => (o.url && host(o.url) === host(r.url) && host(r.url)) || sameOutlet(o.outlet, r.outlet));
        const reg2 = Object.values(reg).find((o) => o.domain && host(`https://${o.domain}`) === host(r.url));
        const row = { outlet: r.outlet, critic: r.critic, url: r.url, date: r.date, inOurs: !!have, tierHint: reg2 ? reg2.tier : null };
        if (!have) {
          const outletSlug = outletKey(r.outlet);
          row.inTextsDir = excluded.some((f) => outletKey(f).includes(outletSlug) && outletSlug.length > 3);
          const pg = await fetchPage(r.url);
          row.fetch = pg.error || 'ok';
          if (!pg.error) {
            const t = fold(pg.text.slice(0, 200000));
            const titleWords = fold(show.title).split(' ').filter((w) => w.length > 2);
            row.titleOnPage = titleWords.length > 0 && titleWords.every((w) => t.includes(w));
            row.venueOnPage = show.venue ? fold(show.venue).split(' ').filter((w) => w.length > 3).some((w) => t.includes(w)) : null;
            const y = String(show.openingDate || '').slice(0, 4);
            row.yearOnPage = y ? t.includes(y) : null;
          }
        }
        found.push(row);
      }
      const rec = { id: show.id, cohort: c, stratum: st, title: show.title, season: show.season || null, ourCount: ours.length, roundups: (ans.roundups || []).slice(0, 6), found, checkedAt: new Date().toISOString() };
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
      console.log(`  ${show.id}: found ${found.length}, ours ${ours.length}, missing ${found.filter((f) => !f.inOurs).length} ($${spend.usd.toFixed(2)})`);
    } catch (e) { console.log(`  ${show.id}: ERROR ${e.message}`); }
  }, () => spend.usd >= maxUsd);
  console.log(`spend $${spend.usd.toFixed(2)} (gemini ${spend.gemini.toFixed(2)})`);
  fs.appendFileSync(path.join(OUT, 'spend.jsonl'), JSON.stringify({ at: new Date().toISOString(), check: 'completeness', cohort: c, usd: +spend.usd.toFixed(4) }) + '\n');
}

// ---------- page metadata + belongs-to-production ----------
function pagePrompt(show, page, url) {
  return `You are auditing a theatre-review database. ${page ? 'Read this web page' : `Open and read this web page: ${url}`} and answer from the page only.
Production we believe it reviews: "${show.title}"${show.venue ? ` at ${show.venue}` : ''}${show.openingDate ? `, opened ${show.openingDate}` : ''}${show.market === 'west-end' ? ' (London)' : ' (New York)'}.
${page ? `Page metadata:
${page.meta.slice(0, 2500)}
Page text (truncated):
${page.text.slice(0, 7000)}
` : ''}
Return ONLY JSON: {"publishDate":"YYYY-MM-DD or null (the article's own publication date, not a date inside the text about the show)","critic":"byline name or null","outlet":"publication name","reviewsProduction":"yes|no|unclear (does the page review the production above: same show, same venue/company, same run/year?)","reviewedYear":"year of the production actually reviewed or null","reason":"max 15 words"}`;
}
async function cmdPages() {
  const c = arg('cohort'); const n = Number(arg('n', 60)); const seed = arg('seed', 5951);
  const maxUsd = Number(arg('max-usd', 4));
  const shows = loadShows(); const rv = reviewsByShow(); const byId = new Map(shows.map((s) => [s.id, s]));
  const { picked } = drawShows(shows, c, 1e9, seed, (s) => rv.has(s.id));
  const pool0 = [];
  for (const { show } of picked) for (const r of rv.get(show.id)) if (/^https?:/.test(r.url || '')) pool0.push({ show, r, key: `${show.id}|${r.url}`, rk: rowKey({ key: `${show.id}|${r.url}`, outletId: r.outletId, ours: r.assignedScore }) });
  pool0.sort((a, b) => h(seed, a.key).localeCompare(h(seed, b.key)));
  const sample = pool0.slice(0, n);
  const file = outFile('pages', c); fs.mkdirSync(OUT, { recursive: true });
  const done = readRows(file);
  const todo = sample.filter((p) => !done.has(p.rk));
  console.log(`${c}: reviews with urls ${pool0.length}, sample ${sample.length}, to check ${todo.length}, cap $${maxUsd}`);
  await pool(todo, Number(arg('concurrency', 4)), async ({ show, r, key }) => {
    try {
      const page = await fetchPage(r.url);
      const rec = { key, id: show.id, cohort: c, url: r.url, ours: { date: r.publishDate, critic: r.criticName, outlet: r.outlet, outletId: r.outletId, flags: r.flags || null } };
      if (page.error) {
        rec.fetch = page.error;
        if (!arg('no-urlctx')) {
          const g = parseJson(await askGemini(pagePrompt(show, null, r.url), { urlctx: true }).catch(() => ''));
          if (g && (g.publishDate || g.critic || g.reviewsProduction === 'yes' || g.reviewsProduction === 'no')) { rec.gemini = g; rec.fetch = `urlctx(${page.error})`; }
        }
      } else {
        rec.fetch = 'ok'; rec.finalHost = host(page.url);
        const prompt = pagePrompt(show, page, r.url);
        const [g, o] = await Promise.all([askGemini(prompt).catch((e) => `ERR ${e.message}`), askOpenAI(prompt).catch((e) => `ERR ${e.message}`)]);
        rec.gemini = parseJson(g); rec.openai = parseJson(o);
      }
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
      console.log(`  ${key.slice(0, 70)}: ${rec.fetch} ($${spend.usd.toFixed(2)})`);
    } catch (e) { console.log(`  ${key}: ERROR ${e.message}`); }
  }, () => spend.usd >= maxUsd);
  console.log(`spend $${spend.usd.toFixed(2)} (gemini ${spend.gemini.toFixed(2)}, openai ${spend.openai.toFixed(2)}, scraper ~${(spend.chain || 0).toFixed(2)}, ${chainPages} chain pages)`);
  fs.appendFileSync(path.join(OUT, 'spend.jsonl'), JSON.stringify({ at: new Date().toISOString(), check: 'pages', cohort: c, usd: +spend.usd.toFixed(4) }) + '\n');
}

/** Verdict for one field from both models: wrong only when BOTH disagree with us (or the only answering model does). */
function judge(rec) {
  const out = {};
  const ms = [rec.gemini, rec.openai].filter(Boolean);
  const vote = (fn, have) => { if (!have) return 'missing'; const v = ms.map(fn).filter((x) => x !== null); if (!v.length) return null; if (v.every((x) => x === false)) return v.length > 1 ? 'wrong' : 'single'; return v.some((x) => x === false) ? 'disputed' : 'ok'; };
  const ym = (d) => String(d || '').slice(0, 7);
  out.date = vote((m) => (m.publishDate ? (String(rec.ours.date).length <= 7 || String(m.publishDate).length <= 7 ? ym(m.publishDate) === ym(rec.ours.date) : Math.abs((Date.parse(m.publishDate) - Date.parse(rec.ours.date)) / 864e5) <= 1) : null), !!rec.ours.date);
  out.critic = vote((m) => (m.critic ? sameCritic(m.critic, rec.ours.critic) : null), !!rec.ours.critic);
  out.outlet = vote((m) => (m.outlet ? sameOutlet(m.outlet, rec.ours.outlet) : null), !!rec.ours.outlet);
  out.belongs = vote((m) => (m.reviewsProduction === 'yes' ? true : m.reviewsProduction === 'no' ? false : null), true);
  return out;
}
let rvCache; function rematch(rows) {
  rvCache = rvCache || reviewsByShow();
  for (const r of rows) { const ours = rvCache.get(r.id) || []; for (const x of r.found) { const have = ours.some((o) => (o.url && host(o.url) === host(x.url) && host(x.url)) || sameOutlet(o.outlet, x.outlet)); if (x.inOurs && !have) { x.inOurs = false; x.rematched = true; } } }
}
/** Fetch pages for completeness rows the old host matcher wrongly marked as ours (no model spend). */
async function cmdReverify() {
  const only = arg('cohort'); const sh = new Map(loadShows().map((x) => [x.id, x]));
  for (const f of fs.readdirSync(OUT).filter((x) => /^completeness-.*\.jsonl$/.test(x))) {
    const cohort = f.slice(13, -6); if (only && cohort !== only) continue;
    const file = path.join(OUT, f); const map = readRows(file); const rows = [...map.values()]; rematch(rows);
    let n = 0;
    for (const r of rows) {
      const show = sh.get(r.id); if (!show) continue;
      for (const x of r.found.filter((y) => y.rematched && !y.fetch)) {
        const pg = await fetchPage(x.url); x.fetch = pg.error || 'ok'; n++;
        if (!pg.error) {
          const t = fold(pg.text.slice(0, 200000)); const tw = fold(show.title).split(' ').filter((w) => w.length > 2);
          x.titleOnPage = tw.length > 0 && tw.every((w) => t.includes(w));
          x.venueOnPage = show.venue ? fold(show.venue).split(' ').filter((w) => w.length > 3).some((w) => t.includes(w)) : null;
          const y = String(show.openingDate || '').slice(0, 4); x.yearOnPage = y ? t.includes(y) : null;
        }
        x.inTextsDir = false; delete x.rematched; x.inOurs = false; x.reverified = true;
      }
    }
    if (n) fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(cohort + ': reverified ' + n);
  }
}
function cmdReport() {
  const only = arg('cohort');
  const files = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((f) => /^(completeness|pages)-.*\.jsonl$/.test(f)) : [];
  const res = {};
  for (const f of files) {
    const [, check, cohort] = /^(\w+?)-(.*)\.jsonl$/.exec(f); if (only && cohort !== only) continue;
    const rows = [...readRows(path.join(OUT, f)).values()]; if (check === 'completeness') rematch(rows); const R = (res[cohort] = res[cohort] || {});
    if (check === 'completeness') {
      const t12 = (x) => x.tierHint === 1 || x.tierHint === 2;
      let shows = 0; let showsMiss = 0; let found = 0; let miss = 0; let missVerified = 0; let missExcluded = 0; let foundT12 = 0; let missT12 = 0; let unfetchable = 0; const list = [];
      for (const r of rows) {
        shows++; const m = r.found.filter((x) => !x.inOurs);
        const ver = m.filter((x) => x.fetch === 'ok' && x.titleOnPage && x.yearOnPage !== false && x.venueOnPage !== false);
        found += r.found.length; miss += m.length; missVerified += ver.length; if (ver.length) showsMiss++;
        missExcluded += m.filter((x) => x.inTextsDir).length; unfetchable += m.filter((x) => x.fetch !== 'ok').length;
        foundT12 += r.found.filter(t12).length; missT12 += ver.filter(t12).length;
        for (const x of ver) list.push({ id: r.id, outlet: x.outlet, url: x.url, tier: x.tierHint, inTextsDir: x.inTextsDir });
      }
      R.completeness = { shows, showsWithVerifiedMiss: pct(showsMiss, shows), modelFoundReviews: found, notInOurs: miss, verifiedMisses: missVerified, unfetchable, ingestedButExcluded: missExcluded, verifiedMissRate: pct(missVerified, found), t1t2MissRate: pct(missT12, foundT12) };
      R.misses = list;
    } else {
      const fields = { date: [0, 0, 0, 0, 0], critic: [0, 0, 0, 0, 0], outlet: [0, 0, 0, 0, 0], belongs: [0, 0, 0, 0, 0] }; let fetchOk = 0; let n = 0; const bad = [];
      for (const r of rows) {
        n++; if (r.fetch !== 'ok' && !String(r.fetch).startsWith('urlctx')) continue; fetchOk++;
        const j = judge(r);
        for (const k of Object.keys(fields)) { if (!j[k]) continue; if (j[k] === 'missing') { fields[k][3]++; continue; } if (j[k] === 'single') fields[k][4]++; fields[k][1]++; if (j[k] === 'wrong') { fields[k][0]++; bad.push({ id: r.id, field: k, url: r.url }); } if (j[k] === 'disputed') fields[k][2]++; }
      }
      R.pages = { reviews: n, fetched: fetchOk, ...Object.fromEntries(Object.entries(fields).map(([k, [w, t, d, ms, sg]]) => [k, `${pct(w, t)} wrong by both models; ${d} disputed; ${sg} wrong by the one model that answered (excluded from rate); ${ms} our field empty (excluded)`])) };
      R.pageErrors = bad;
    }
  }
  if (arg('json')) { console.log(JSON.stringify(res, null, 2)); return; }
  for (const [c, r] of Object.entries(res)) { console.log(`\n## ${c}`); if (r.completeness) console.log('completeness', JSON.stringify(r.completeness, null, 1)); if (r.pages) console.log('pages', JSON.stringify(r.pages, null, 1)); }
}


// ---------- scoring correctness (score only; prose never leaves memory) ----------
const bucketOf = (x) => (x < 31 ? 'Pan' : x < 51 ? 'Negative' : x < 71 ? 'Mixed' : x < 91 ? 'Positive' : 'Rave'); // same bands as scorePrompt
function textsDirOf() {
  return ['data/review-texts', '/home/user/broadway-review-texts/data/review-texts', '/home/user/broadway-review-texts'].map((p) => path.isAbsolute(p) ? p : path.join(ROOT, p)).find((p) => fs.existsSync(p));
}
function loadText(dir, r) {
  const d = path.join(dir, r.showId); if (!fs.existsSync(d)) return null;
  const files = fs.readdirSync(d).filter((f) => f.endsWith('.json'));
  const pre = files.filter((f) => f.startsWith(`${r.outletId}--`));
  for (const f of pre.length ? pre : files) {
    try { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); if ((j.url && j.url === r.url) || (pre.length && sameCritic(j.criticName, r.criticName))) { const t = j.fullText || ''; return t.length > 400 ? t : null; } } catch (_) { /* skip */ }
  }
  return null;
}
function scorePrompt(show, text) {
  return `Score this theatre review of "${show.title}" (${show.market === 'west-end' ? 'London' : 'New York'}) on a 0-100 scale of the critic's overall verdict: 0-30 pan, 31-50 negative, 51-70 mixed or lukewarm, 71-90 positive, 91-100 rave. If the review states a star rating, the score must fall inside that star's band (1/5 0-30, 2/5 31-50, 3/5 51-70, 4/5 71-90, 5/5 91-100). Judge the critic's verdict, not the quality of the play.
Review text:
${text.slice(0, 6000)}

Return ONLY JSON: {"score": <integer 0-100>, "stars": "<rating stated in the text, e.g. 4/5, or null>"}`;
}
async function cmdScore() {
  const c = arg('cohort'); const n = Number(arg('n', 60)); const seed = arg('seed', 5951); const maxUsd = Number(arg('max-usd', 3));
  const dir = textsDirOf(); if (!dir) { console.error('review texts not available'); process.exit(2); }
  const shows = loadShows(); const rv = reviewsByShow();
  const { picked } = drawShows(shows, c, 1e9, seed, (s) => rv.has(s.id));
  const pool0 = [];
  for (const { show } of picked) for (const r of rv.get(show.id)) pool0.push({ show, r, key: `${show.id}|${r.url}` });
  // stratify by scoreSource so llm-v6 does not swamp anchored / human-review rows
  const bySrc = new Map(); for (const p of pool0) (bySrc.get(p.r.scoreSource) || bySrc.set(p.r.scoreSource, []).get(p.r.scoreSource)).push(p);
  const sample = [];
  for (const [, list] of bySrc) { list.sort((a, b) => h(seed, a.key).localeCompare(h(seed, b.key))); sample.push(...list.slice(0, Math.max(2, Math.round((n * list.length) / pool0.length)))); }
  const file = outFile('score', c); fs.mkdirSync(OUT, { recursive: true });
  const done = readRows(file); const todo = sample.filter((p) => !done.has(p.key));
  console.log(`${c}: reviews ${pool0.length}, sample ${sample.length}, to score ${todo.length}, cap $${maxUsd}`);
  await pool(todo, Number(arg('concurrency', 5)), async ({ show, r, key }) => {
    try {
      const text = loadText(dir, r);
      const rec = { key, id: show.id, cohort: c, outletId: r.outletId, scoreSource: r.scoreSource, ours: r.assignedScore, stars: r.originalRating || null };
      if (!text) rec.skip = 'no-text';
      else {
        const prompt = scorePrompt(show, text);
        const [g, o] = await Promise.all([askGemini(prompt).catch(() => ''), askOpenAI(prompt).catch(() => '')]);
        const gj = parseJson(g); const oj = parseJson(o);
        rec.gemini = gj && Number.isFinite(Number(gj.score)) ? Number(gj.score) : null; rec.openai = oj && Number.isFinite(Number(oj.score)) ? Number(oj.score) : null;
      }
      fs.appendFileSync(file, JSON.stringify(rec) + '\n');
      console.log(`  ${key.slice(0, 60)}: ours ${rec.ours} g ${rec.gemini} o ${rec.openai} ($${spend.usd.toFixed(2)})`);
    } catch (e) { console.log(`  ${key}: ERROR ${e.message}`); }
  }, () => spend.usd >= maxUsd);
  console.log(`spend $${spend.usd.toFixed(2)} (gemini ${spend.gemini.toFixed(2)}, openai ${spend.openai.toFixed(2)})`);
  fs.appendFileSync(path.join(OUT, 'spend.jsonl'), JSON.stringify({ at: new Date().toISOString(), check: 'score', cohort: c, usd: +spend.usd.toFixed(4) }) + '\n');
}
function scoreStats(rows) {
  const use = rows.filter((r) => !r.skip && r.gemini != null && r.openai != null);
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const consensus = (r) => (r.gemini + r.openai) / 2;
  const drift = use.map((r) => consensus(r) - r.ours);
  const bucketDis = use.filter((r) => bucketOf(consensus(r)) !== bucketOf(r.ours)).length;
  const bothDis = use.filter((r) => bucketOf(r.gemini) !== bucketOf(r.ours) && bucketOf(r.openai) !== bucketOf(r.ours)).length;
  const outliers = use.filter((r) => Math.abs(r.gemini - r.ours) >= 20 && Math.abs(r.openai - r.ours) >= 20 && Math.sign(r.gemini - r.ours) === Math.sign(r.openai - r.ours));
  return { rows: rows.length, noText: rows.filter((r) => r.skip).length, scored: use.length, meanDrift: +mean(drift).toFixed(2), meanAbsDrift: +mean(drift.map(Math.abs)).toFixed(2), bucketDisagreeConsensus: pct(bucketDis, use.length), bucketDisagreeBothModels: pct(bothDis, use.length), outliers20: outliers.map((r) => ({ id: r.id, outletId: r.outletId, scoreSource: r.scoreSource, ours: r.ours, gemini: r.gemini, openai: r.openai, stars: r.stars })) };
}

function cmdInventory() {
  const shows = loadShows(); const rv = reviewsByShow();
  const cs = ['bw-historical', 'ob-historical', ...[...new Set(shows.filter((s) => String(s.discoverySource || '').startsWith('we-historical')).map((s) => s.season))].sort().map((s) => `we-${s}`)];
  for (const c of cs) { const rows = shows.filter(cohortFilter(c)); const w = rows.filter((s) => rv.has(s.id)); console.log(`${c}\tshows ${rows.length}\twith reviews ${w.length}\treviews ${w.reduce((a, s) => a + rv.get(s.id).length, 0)}`); }
}

(async () => {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 24).join('\n')); return; }
  const cmd = process.argv[2];
  if (['completeness', 'pages', 'score'].includes(cmd)) for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY']) if (!process.env[k]) { console.error(`${k} not set`); process.exit(2); }
  if (cmd === 'completeness') await cmdCompleteness();
  else if (cmd === 'pages') await cmdPages();
  else if (cmd === 'score') await cmdScore();
  else if (cmd === 'reverify') await cmdReverify();
  else if (cmd === 'score-report') { const only = arg('cohort'); const o = {}; for (const f of fs.readdirSync(OUT).filter((x) => /^score-.*\.jsonl$/.test(x))) { const c = f.slice(6, -6); if (only && c !== only) continue; o[c] = scoreStats([...readRows(path.join(OUT, f)).values()]); } console.log(JSON.stringify(o, null, 1)); }
  else if (cmd === 'report') cmdReport();
  else if (cmd === 'inventory') cmdInventory();
  else console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 24).join('\n'));
})();
