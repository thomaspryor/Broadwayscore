#!/usr/bin/env node
'use strict';
/**
 * Seat notes (BRO-8057): short, sourced tips tied to seat locations, typed
 * watch-out / value / note. Writes structuredTips.seating.seatNotes.
 *
 *   node scripts/seat-notes.js seed   --theaters="A,B"|--all --out=FILE   candidate pages per theater (no notes yet)
 *   node scripts/seat-notes.js fetch  --candidates=FILE           fetch every cited page (cached)
 *   node scripts/seat-notes.js excerpt --candidates=FILE --theater=NAME   seating sentences from the cached pages
 *   node scripts/seat-notes.js ground --candidates=FILE            check quotes, print what would publish
 *   node scripts/seat-notes.js apply  --candidates=FILE [--write] [--allow-shrink="reason"]
 *
 * FILE (private, keep it under .cache/ or outside the repo: it holds verbatim quotes):
 *   { "theaters": { "Al Hirschfeld Theatre": [ { type, hazard?, level, side?, rows?, claim,
 *       evidence: [ { url, quote, rowsInQuote? } ] } ] },
 *     "pages": { "Al Hirschfeld Theatre": [ url, ... ] } }   optional: extra pages fetch reads (seed writes these)
 *
 * A note publishes only when at least one of its quotes is found word-for-word (word boundaries)
 * on a fetched page that names the theater, and the quote itself mentions the note's level or
 * rows. Page text and quotes stay in .cache/seat-notes/ (gitignored); the repo gets the claim in
 * our own words plus {url, quoteHash, fetchedAt}. A failed fetch is UNKNOWN, never "unsupported":
 * apply refuses to run while any cited page is missing, so a flaky source cannot delete notes.
 * apply touches only the theaters in FILE and refuses a >20% drop in a theater's notes or
 * watch-outs unless --allow-shrink says why.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { foldDiacritics } = require('./lib/title-match.js');
const A = require('./lib/seat-adjudication');
const { validateSeatNotes } = require('./lib/seat-notes-validators');
const { publishableSeatNotes } = require('./lib/seat-notes-publish');

const ROOT = path.join(__dirname, '..');
const PAGES = path.join(ROOT, '.cache', 'seat-notes', 'pages');
const META = path.join(ROOT, 'data', 'theater-metadata.json');
const AUDIT = path.join(ROOT, 'data', 'seat-research-eval', 'audits', 'seat-notes.json');
// Pages older than this are fetched again before they can support a note.
const MAX_PAGE_AGE_DAYS = 30;
// aviewfrommyseat.com robots.txt asks for a 10s crawl delay; honour it for every host.
const HOST_SPACING_MS = 11000;
// Hosts behind a browser check: fall back to one Browserbase page read.
const BROWSER_HOSTS = new Set(['aviewfrommyseat.com']);

/** One page through Browserbase, waiting out a Cloudflare check. Returns {content, source} or {error}. */
async function fetchWithBrowser(url) {
  const { chromium } = require('playwright');
  const { createBbSession } = require('./lib/browserbase-session');
  const { readBrowserPage } = require('./lib/browser-read-page');
  let browser;
  try {
    const s = await createBbSession({
      caller: 'seat-notes.js', purpose: 'seat guide venue page (BRO-8057)', host: new URL(url).hostname.replace(/^www\./, ''),
      category: 'discovery', body: { browserSettings: { solveCaptchas: true } },
    });
    browser = await chromium.connectOverCDP(s.connectUrl);
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = ctx.pages()[0] || await ctx.newPage();
    const r = await readBrowserPage(page, url, { timeoutMs: 60000, waits: 12, waitMs: 3000 });
    if (r.challenge) return { error: new Error('browser check not passed') };
    return { content: r.html, source: 'browserbase' };
  } catch (e) {
    return { error: e };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
const SHRINK_LIMIT = 0.2;

function arg(name, dflt) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

function loadCandidateFile() {
  const f = arg('candidates');
  if (!f) throw new Error('--candidates=FILE is required');
  const c = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!c || typeof c.theaters !== 'object') throw new Error('candidates file needs a "theaters" object');
  return c;
}
const loadCandidates = () => loadCandidateFile().theaters;

// Level pages SeatPlan publishes for most houses. A page that does not exist
// comes back as a not-found page and is recorded as such (fetch never retries it).
const SEATPLAN_LEVELS = ['', 'seating-plan/', 'orchestra/', 'mezzanine/', 'front-mezzanine/', 'rear-mezzanine/', 'balcony/'];
const SEED_HOSTS = /^https:\/\/(www\.)?(seatplan\.com|tickpick\.com|headout\.com|rateyourseats\.com)\//;

// Houses whose SeatPlan slug is not their slugified name (a wrong slug makes
// every level page a not-found page, so the theater gets no notes).
const SEATPLAN_SLUGS = { 'Helen Hayes Theater': 'hayes-theater', 'Studio 54': 'studio-54-theatre' };

/** SeatPlan's slug: the one already cited for this theater, else a known override, else slugified name. */
function seatplanSlug(theater, urls) {
  for (const u of urls) {
    const m = u.match(/^https:\/\/(?:www\.)?seatplan\.com\/new-york\/([a-z0-9-]+)\//);
    if (m) return m[1];
  }
  if (SEATPLAN_SLUGS[theater]) return SEATPLAN_SLUGS[theater];
  return foldDiacritics(theater).toLowerCase().replace(/['\u2018\u2019.]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Candidate pages for each theater: every seat-guide URL already cited
 * anywhere in its metadata, plus SeatPlan's level pages. Pure; exported.
 */
function seedPages(theater, entry) {
  const cited = [...new Set((JSON.stringify(entry || {}).match(/https:\/\/[^"\s\\]+/g) || [])
    .map((u) => u.replace(/[#?].*$/, '').replace(/[).,;:]+$/, ''))
    .filter((u) => SEED_HOSTS.test(u)))];
  const slug = seatplanSlug(theater, cited);
  const sp = SEATPLAN_LEVELS.map((l) => `https://seatplan.com/new-york/${slug}/${l}`);
  return [...new Set([...sp, ...cited])];
}

function cmdSeed() {
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  const names = arg('all') ? Object.keys(meta).filter((k) => !k.startsWith('_'))
    : String(arg('theaters', '')).split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('--theaters="A,B" or --all');
  const out = arg('out');
  if (!out) throw new Error('--out=FILE is required (keep it under .cache/)');
  const file = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { theaters: {}, pages: {} };
  file.pages = file.pages || {};
  for (const t of names) {
    if (!meta[t]) throw new Error(`${t}: not in theater-metadata.json`);
    file.theaters[t] = file.theaters[t] || [];
    file.pages[t] = seedPages(t, meta[t]);
    console.log(`${t}: ${file.pages[t].length} pages`);
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
}

const SEAT_WORDS = /\b(orchestra|mezz(anine)?|balcony|box(es)?|row|rows|seats?|aisle|overhang|pillar|column|obstruct\w*|restricted|partial|legroom|leg room|rake|steep|cheap\w*|value|budget|price\w*|sightlines?)\b/i;

/** Seating sentences from one theater's cached pages, numbered per page, for writing candidates. */
function cmdExcerpt() {
  const c = loadCandidateFile();
  const theater = arg('theater');
  if (!theater) throw new Error('--theater=NAME is required');
  const urls = [...new Set([...(c.pages?.[theater] || []), ...(c.theaters[theater] || []).flatMap((n) => (n.evidence || []).map((e) => e.url))])];
  const max = Number(arg('max', 60));
  for (const url of urls) {
    const p = readPage(url);
    if (!p || !p.ok) { console.log(`\n## ${url} (${p ? p.error : 'not fetched'})`); continue; }
    const names = A.pageNamesTheater(p.text, theater);
    const sentences = p.text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim())
      .filter((x) => x.length >= 30 && x.length <= 400 && SEAT_WORDS.test(x));
    const seen = new Set();
    const keep = sentences.filter((x) => (seen.has(x) ? false : seen.add(x)));
    console.log(`\n## ${url}${names ? '' : ' (PAGE DOES NOT NAME THE THEATER)'} [${keep.length} sentences]`);
    keep.slice(0, max).forEach((x, i) => console.log(`${i + 1}. ${x}`));
  }
}

const pageFile = (url) => path.join(PAGES, `${sha(url)}.json`);
function readPage(url) {
  try { return JSON.parse(fs.readFileSync(pageFile(url), 'utf8')); } catch { return null; }
}
function pageFresh(p) {
  return p && p.ok && (Date.now() - Date.parse(p.fetchedAt)) / 86400000 <= MAX_PAGE_AGE_DAYS;
}

/** Word-boundary match only (the shared quoteInText also accepts a bare substring). */
function quoteOnPage(quote, text) {
  const q = A.normalizeText(quote);
  if (q.length < 12) return false;
  return ` ${A.normalizeText(text)} `.includes(` ${q} `);
}

const LEVEL_WORDS = {
  orchestra: ['orchestra', 'orch', 'stalls'],
  mezzanine: ['mezzanine', 'mezz'],
  'front-mezzanine': ['mezzanine', 'mezz'],
  'rear-mezzanine': ['mezzanine', 'mezz'],
  balcony: ['balcony'],
  box: ['box', 'boxes'],
};
/** Level words (from LEVEL_WORDS) in a short normalized snippet. */
function levelWordsIn(snippet) {
  const q = ` ${A.normalizeText(snippet)} `.replace(/ box like /g, ' ');
  return [...new Set(Object.values(LEVEL_WORDS).flat())].filter((w) => q.includes(` ${w} `));
}

/**
 * Row mentions in a quote: "row F", "Rows AA and BB", "rows E-L", "rows Q to
 * Z". Each gets the level words right next to it ("Orchestra row F", "Front
 * Mezzanine Row A", "row F in the Orchestra"), empty when the quote does not
 * tie that mention to a level.
 */
function rowMentions(quote) {
  const out = [];
  const re = /\b[Rr]ows?\s+([A-Z]{1,3})(?:\s*(-|\u2013|\u2014|to|through|and|&)\s*([A-Z]{1,3}))?\b/g;
  for (const m of String(quote).matchAll(re)) {
    const range = m[3] && !/and|&/.test(m[2]);
    const rows = new Set([...(A.rowSet(range ? `${m[1]}-${m[3]}` : m[1]) || []), ...(m[3] && !range ? A.rowSet(m[3]) || [] : [])]);
    if (!rows.size) continue;
    const before = String(quote).slice(0, m.index).trim().split(/\s+/).slice(-2).join(' ');
    const afterM = String(quote).slice(m.index + m[0].length).match(/^\s*(?:in|on|of)\s+(?:the\s+)?((?:\w+\s+){0,1}\w+)/i);
    out.push({ rows, levelWords: levelWordsIn(`${before} ${afterM ? afterM[1] : ''}`) });
  }
  return out;
}

/**
 * The quote has to be about this place. With rows on the note: a row the quote
 * puts on this level (or on no level) must overlap the note's rows, or the
 * quote names the level and mentions no rows there. Without rows: the quote
 * names the level. Front and rear mezzanine notes refuse a quote that names
 * only the other half.
 */
function quoteMatchesLocation(quote, note) {
  const own = new Set(LEVEL_WORDS[note.level] || []);
  const named = levelWordsIn(quote).some((w) => own.has(w));
  const q = ` ${A.normalizeText(quote)} `;
  const half = { 'front-mezzanine': ['front', 'rear'], 'rear-mezzanine': ['rear', 'front'] }[note.level];
  if (half && !q.includes(` ${half[0]} mezz`) && q.includes(` ${half[1]} mezz`)) return false;
  const rows = note.rows ? A.rowSet(note.rows) : null;
  if (!rows) return named;
  const here = rowMentions(quote).filter((m) => !m.levelWords.length || m.levelWords.some((w) => own.has(w)));
  if (here.some((m) => [...m.rows].some((i) => rows.has(i)))) return true;
  return named && here.length === 0;
}

/**
 * Whether fetch should (re)download a cached page record. A failure is
 * retried only with --retry-failed, and never a not-found page: that answer
 * does not change on a retry and each retry is a paid call. Pure; exported.
 */
function needsFetch(rec, retryFailed = false) {
  if (!rec) return true;
  if (pageFresh(rec)) return false;
  if (rec.ok) return true;
  return retryFailed && rec.error !== 'not-found page';
}

async function cmdFetch() {
  const { fetchPage } = require('./lib/scraper');
  const theaters = loadCandidates();
  fs.mkdirSync(PAGES, { recursive: true });
  const pages = loadCandidateFile().pages || {};
  const urls = [...new Set([...Object.values(pages).flat(),
    ...Object.values(theaters).flat().flatMap((n) => (n.evidence || []).map((e) => e.url))])];
  const todo = urls.filter((u) => needsFetch(readPage(u), !!arg('retry-failed')));
  const cited = new Set(Object.values(theaters).flat().flatMap((n) => (n.evidence || []).map((e) => e.url)));
  console.log(`fetch: ${urls.length} cited pages, ${todo.length} to fetch`);
  const lastHit = {};
  let skipped = 0;
  for (const url of todo) {
    const host = new URL(url).hostname;
    // A SeatPlan level page that almost surely does not exist costs a paid
    // fallback for nothing (see seatplanLevelLinked).
    if (!cited.has(url) && !seatplanLevelLinked(url)) { skipped++; continue; }
    const wait = (lastHit[host] || 0) + HOST_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit[host] = Date.now();
    let rec;
    try {
      let r = await fetchPage(url, {}).catch((e) => ({ error: e }));
      // A View From My Seat sits behind a Cloudflare check the API scrapers
      // mostly fail on; a Browserbase browser that waits it out gets through.
      // Its robots.txt allows /venue/ pages for general crawlers.
      if (!(r && (r.content || r.html)) && BROWSER_HOSTS.has(host.replace(/^www\./, ''))) r = await fetchWithBrowser(url);
      if (r && r.error && !(r.content || r.html)) throw r.error;
      const raw = String(r.content || r.html || '');
      const text = /<html|<body|<div/i.test(raw) ? A.htmlToText(raw) : raw;
      const notFound = /\b404\b[\s\S]{0,40}not found|page (not found|can.t be found)/i.test(text.slice(0, 800));
      rec = { url, ok: text.length > 200 && !notFound, text, source: r.source, fetchedAt: new Date().toISOString() };
      if (/^https:\/\/seatplan\.com\/new-york\/[a-z0-9-]+\/$/.test(url)) rec.links = seatplanLinks(raw);
      if (!rec.ok) rec.error = notFound ? 'not-found page' : 'page text under 200 chars';
    } catch (e) {
      rec = { url, ok: false, error: String(e.message || e).slice(0, 200), fetchedAt: new Date().toISOString() };
    }
    fs.writeFileSync(pageFile(url), JSON.stringify(rec));
    console.log(`  ${rec.ok ? 'ok  ' : 'FAIL'} ${url}${rec.ok ? '' : ` (${rec.error})`}`);
  }
  if (skipped) console.log(`  skipped ${skipped} SeatPlan level pages that look missing`);
}

/** SeatPlan venue sub-pages linked from a page's HTML: absolute https URLs ending in '/'. */
function seatplanLinks(html) {
  const out = new Set();
  for (const m of String(html).matchAll(/href=["'](?:https?:\/\/(?:www\.)?seatplan\.com)?(\/new-york\/[a-z0-9-]+\/[a-z0-9-]+)\/?(?:[?#][^"']*)?["']/gi)) {
    out.add(`https://seatplan.com${m[1].toLowerCase()}/`);
  }
  return [...out];
}

/**
 * False when a SeatPlan level page is almost surely a not-found page, so
 * fetching it would only buy a paid fallback:
 *   - the venue page came back as a not-found page (wrong slug: every level
 *     page 404s too). Any other failure is unknown, so level pages are fetched, or
 *   - the seating-plan page was fetched and never names the level ("Front
 *     Mezzanine", "Balcony"). The venue page does not link every level page
 *     (Walter Kerr links only /orchestra/), so its links are not used.
 */
function seatplanLevelLinked(url, read = readPage) {
  const m = url.match(/^(https:\/\/seatplan\.com\/new-york\/[a-z0-9-]+\/)([a-z0-9-]+)\/$/);
  if (!m) return true;
  const main = read(m[1]);
  if (main && !main.ok && main.error === 'not-found page') return false;
  if (!['front-mezzanine', 'rear-mezzanine', 'balcony'].includes(m[2])) return true;
  const plan = read(m[1] + 'seating-plan/');
  if (!plan || !plan.ok) return true;
  const words = m[2].split('-').join('[\\s\\u00a0-]+');
  return new RegExp(`\\b${words}\\b`, 'i').test(String(plan.text || ''));
}

/**
 * Ground one theater's candidates. Returns { notes, dropped, unknown }:
 * notes are publishable seatNotes; unknown lists pages not fetched yet.
 */
function groundTheater(theater, candidates) {
  const notes = [], dropped = [], unknown = [];
  for (const c of candidates) {
    const evidence = [];
    const why = [];
    for (const e of c.evidence || []) {
      const p = readPage(e.url);
      if (!p || !p.ok) { unknown.push(e.url); why.push(`${e.url}: page not fetched`); continue; }
      if (!A.pageNamesTheater(p.text, theater)) { why.push(`${e.url}: page does not name ${theater}`); continue; }
      if (!quoteOnPage(e.quote, p.text)) { why.push(`${e.url}: quote not on page`); continue; }
      if (!quoteMatchesLocation(e.quote, c)) { why.push(`${e.url}: quote does not mention the level or rows`); continue; }
      evidence.push({ url: e.url, quoteHash: A.quoteHash(e.quote), fetchedAt: p.fetchedAt.slice(0, 10) });
    }
    const { evidence: _drop, ...rest } = c;
    if (evidence.length) notes.push({ ...rest, evidence, verifiedAt: today() });
    else dropped.push({ claim: c.claim, why });
  }
  return { notes, dropped, unknown: [...new Set(unknown)] };
}

/**
 * Titles of the shows that have played this house. A house note may name none
 * of them. Only this house's titles: checking every title flagged ordinary
 * words ("still") that happen to be a show somewhere else.
 */
function houseTitles(shows, theater) {
  return [...new Set(shows
    .filter((s) => s && s.title && s.venue && A.pageNamesTheater(s.venue, theater))
    .map((s) => s.title))].filter((t) => A.normalizeText(t).length >= 4);
}

function loadShows() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
    return Array.isArray(j) ? j : j.shows;
  } catch {
    throw new Error('shows.json not found (run scripts/setup-local-data.sh --link-only)');
  }
}

/** Per-theater shrink check against what is stored now. Exported for the test. */
function shrinkProblems(theater, before, after) {
  const count = (ns, t) => (ns || []).filter((n) => !t || n.type === t).length;
  const p = [];
  for (const [label, t] of [['notes', null], ['watch-outs', 'watch-out']]) {
    const b = count(before, t), a = count(after, t);
    if (b > 0 && a < b * (1 - SHRINK_LIMIT)) p.push(`${theater}: ${label} would drop ${b} -> ${a}`);
  }
  return p;
}

function cmdGround({ quiet = false } = {}) {
  const theaters = loadCandidates();
  const shows = loadShows();
  const out = {};
  for (const [theater, cands] of Object.entries(theaters)) {
    const g = groundTheater(theater, cands);
    const problems = validateSeatNotes(theater, g.notes, { showTitles: houseTitles(shows, theater) });
    out[theater] = { ...g, problems };
    if (quiet) continue;
    console.log(`\n${theater}: ${g.notes.length} grounded, ${g.dropped.length} dropped, ${g.unknown.length} pages not fetched`);
    for (const n of g.notes) console.log(`  + [${n.type}] ${n.level}${n.side ? '/' + n.side : ''}${n.rows ? ' ' + n.rows : ''}: ${n.claim} (${n.evidence.length} source${n.evidence.length > 1 ? 's' : ''})`);
    for (const d of g.dropped) console.log(`  - ${d.claim}\n      ${d.why.join('\n      ')}`);
    for (const p of problems) console.log(`  ! ${p}`);
    console.log(`  renders: ${publishableSeatNotes(g.notes).length ? 'yes' : 'NO (does not clear the bar)'}`);
  }
  return out;
}

function cmdApply() {
  const results = cmdGround({ quiet: true });
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  const blockers = [];
  for (const [theater, r] of Object.entries(results)) {
    if (!meta[theater]) blockers.push(`${theater}: not in theater-metadata.json`);
    if (r.unknown.length) blockers.push(`${theater}: ${r.unknown.length} cited pages not fetched (run fetch)`);
    blockers.push(...r.problems);
    const before = meta[theater]?.structuredTips?.seating?.seatNotes;
    r.shrink = shrinkProblems(theater, before, r.notes);
    if (!arg('allow-shrink')) blockers.push(...r.shrink);
  }
  if (blockers.length) {
    console.error(`apply refused:\n  ${blockers.join('\n  ')}`);
    process.exit(1);
  }
  const audit = fs.existsSync(AUDIT) ? JSON.parse(fs.readFileSync(AUDIT, 'utf8')) : { theaters: {} };
  for (const [theater, r] of Object.entries(results)) {
    const st = meta[theater].structuredTips || (meta[theater].structuredTips = { lastUpdated: new Date().toISOString() });
    st.seating = st.seating || {};
    if (r.notes.length) st.seating.seatNotes = r.notes;
    else delete st.seating.seatNotes;
    audit.theaters[theater] = {
      appliedAt: new Date().toISOString(),
      published: r.notes.map((n) => ({ type: n.type, level: n.level, evidence: n.evidence })),
      dropped: r.dropped.length,
      ...(arg('allow-shrink') && r.shrink.length ? { allowShrink: String(arg('allow-shrink')) } : {}),
    };
    console.log(`${theater}: ${r.notes.length} seat notes`);
  }
  if (!arg('write')) { console.log('\n(dry run; add --write to save)'); return; }
  fs.writeFileSync(META, `${JSON.stringify(meta, null, 2)}\n`);
  fs.mkdirSync(path.dirname(AUDIT), { recursive: true });
  fs.writeFileSync(AUDIT, `${JSON.stringify(audit, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, META)} and ${path.relative(ROOT, AUDIT)}`);
}

if (require.main === module) {
  const { hasHelpFlag } = require('./lib/cli-help.js');
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('usage: seat-notes.js seed|fetch|excerpt|ground|apply --candidates=FILE [--write] [--allow-shrink="reason"] [--retry-failed]');
    process.exit(0);
  }
  const cmd = process.argv[2];
  const run = { seed: cmdSeed, fetch: cmdFetch, excerpt: cmdExcerpt, ground: () => cmdGround(), apply: cmdApply }[cmd];
  if (!run) { console.error('usage: seat-notes.js seed|fetch|excerpt|ground|apply --candidates=FILE'); process.exit(2); }
  Promise.resolve(run()).catch((e) => { console.error(e.message || e); process.exit(1); });
}

module.exports = { SHRINK_LIMIT, needsFetch, rowMentions, seatplanLevelLinked, seedPages, seatplanSlug, seatplanLinks, quoteOnPage, quoteMatchesLocation, groundTheater, shrinkProblems, houseTitles };
