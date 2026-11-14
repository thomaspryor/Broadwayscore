#!/usr/bin/env node
/**
 * BRO-6155: recover missing major-outlet reviews for West End historical shows
 * (seasons 2016-17..2020-21). Subcommands:
 *
 *   report                       per-season averages + missing slots (reads data/)
 *   wos --out=FILE               free WhatsOnStage WP-API match for missing WoS slots
 *   guardian --out=FILE          Guardian Content API match for missing guardian slots (needs GUARDIAN_API_KEY)
 *   sitemap --out=FILE           Evening Standard monthly sitemaps match for missing standard slots (free)
 *   run  [flags]                 recover slots (CI: needs scraper keys + review-texts)
 *
 * run flags:
 *   --candidates=FILE            wos/guardian output; those URLs are ingested with no search
 *   --serp                       search the remaining slots (site: scoped SERP)
 *   --debug                      log every SERP query/verdict and skip the Google date filter
 *   --max-usd=N                  hard cap on scraper + projected scoring dollars (default 45)
 *   --reserve-usd=N              held back for scoring of files already written by earlier runs
 *   --seasons=2016..2020         start years
 *   --slots=a,b                  only these outlet slots
 *   --shows=id1,id2              only these shows
 *   --max-calls=N                at most N SERP searches
 *   --out=FILE                   per-slot outcomes + tally (JSON)
 *   --dry-run                    list the queue, spend nothing
 *
 * Every ingest goes through ingest-review-from-url.js with --date-window (the
 * rebuild date guard's window) and --require-publish-date; a written file whose
 * body never names the show is removed (wrong show).
 */
'use strict';

require('./lib/cli-help').exitOnHelp(module);
// Labels every ingest-review-from-url.js run this script starts (BRO-6588).
process.env.INGEST_CALLER = process.env.INGEST_CALLER || 'we-major-recovery';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./lib/we-major-recovery.js');
const { pageMentionsShowTitle } = require('./lib/submission-show-match');

const ROOT = path.join(__dirname, '..');
const arg = n => process.argv.slice(3).find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = n => process.argv.slice(3).includes(`--${n}`);
const rd = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function seasonRange() {
  const m = String(arg('seasons') || '2016..2020').match(/^(\d{4})(?:\.\.(\d{4}))?$/);
  return m ? [+m[1], +(m[2] || m[1])] : [2016, 2020];
}

function loadRows() {
  const [from, to] = seasonRange();
  let rows = lib.buildSlots(rd('data/shows.json').shows, rd('data/reviews.json').reviews, from, to);
  const only = arg('shows');
  if (only) { const s = new Set(only.split(',')); rows = rows.filter(r => s.has(r.id)); }
  return rows;
}

async function cmdReport() {
  const rows = loadRows();
  console.log(JSON.stringify(lib.summarize(rows), null, 1));
  console.log('shows', rows.length, 'missing slots', rows.reduce((a, r) => a + r.missing.length, 0));
  if (arg('json')) fs.writeFileSync(arg('json'), JSON.stringify(rows));
}

async function cmdWos() {
  const { fetchWosReviews } = require('./lib/wos-rest-listings.js');
  const rows = loadRows();
  const [from, to] = seasonRange();
  const posts = await fetchWosReviews({ after: `${from}-09-01`, before: `${to + 1}-10-01` });
  const hits = lib.matchWosPosts(rows, rd('data/shows.json').shows, posts);
  const missing = rows.filter(r => r.missing.includes('whatsonstage')).length;
  console.log(`WOS review posts ${posts.length}; shows missing WOS ${missing}; with a matching post ${hits.length}`);
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(hits, null, 1));
}


// Guardian Content API (key in CI only): one search per missing guardian slot over the
// show's opening window. Output has the same shape as `wos`, so `run --candidates` ingests
// through the same date-window and wrong-show guards. API calls are free (no scraper spend).
async function cmdGuardian() {
  const key = process.env.GUARDIAN_API_KEY;
  if (!key) { console.error('GUARDIAN_API_KEY not set'); process.exit(2); }
  const rows = loadRows().filter(r => r.missing.includes('guardian'));
  const shows = new Map(rd('data/shows.json').shows.map(s => [s.id, s]));
  const out = [];
  let asked = 0, failed = 0;
  for (const r of rows) {
    const s = shows.get(r.id);
    if (!s || !s.openingDate) continue;
    const q = new URLSearchParams({ section: 'stage', 'from-date': lib.addDays(s.openingDate, -14), 'to-date': lib.addDays(s.openingDate, 60),
      q: `"${s.title}"`, 'show-fields': 'headline,standfirst,trailText,publication,bodyText,starRating', 'show-tags': 'tone', type: 'article', 'page-size': '50', 'api-key': key });
    asked++;
    try {
      const res = await fetch(`https://content.guardianapis.com/search?${q}`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { failed++; console.log(`${r.id}: HTTP ${res.status}`); continue; }
      const results = (await res.json()).response?.results || [];
      const posts = lib.matchGuardianResults(s, results);
      if (posts.length) out.push({ showId: r.id, slot: 'guardian', posts });
    } catch (e) { failed++; console.log(`${r.id}: ${e.message}`); }
    await sleep(150);
  }
  console.log(`GUARDIAN shows missing ${rows.length}; searched ${asked}; failed ${failed}; with candidates ${out.length}`);
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  if (asked && failed === asked) { console.error('GUARDIAN: every API call failed (bad key or rate limit)'); process.exit(1); }
}


// BRO-6487: Evening Standard monthly article sitemaps (free, no scraper spend). One fetch per month
// the shows' windows touch; slugs matched on title + venue (lib/we-sitemap-candidates.js). Output has
// the same shape as `wos`, so `run --candidates` ingests through the same date-window and wrong-show guards.
async function cmdSitemap() {
  const sm = require('./lib/we-sitemap-candidates.js');
  const rows = loadRows().filter(r => r.missing.includes('standard'));
  const shows = new Map(rd('data/shows.json').shows.map(s => [s.id, s]));
  const monthUrls = new Map();
  let fetched = 0;
  const getMonth = async (ym) => {
    if (monthUrls.has(ym)) return monthUrls.get(ym);
    let urls = [];
    const url = `https://www.standard.co.uk/sitemaps/sitemap-articles-${ym}.xml`;
    // Node's fetch is 403'd by the host's TLS check where curl is not. Free path only: no scraper fallback, so a
    // sitemap pass can never spend outside the campaign cap (a failed month is counted and reported below).
    const res = spawnSync('curl', ['-sS', '-m', '90', '-A', 'Mozilla/5.0', '-f', url], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const xml = res.stdout || '';
    if (xml.includes('<urlset')) { urls = sm.standardReviewUrls(xml); fetched++; } else console.log(`${ym}: sitemap not fetched (curl exit ${res.status}: ${String(res.stderr || '').trim().slice(0, 100)})`);
    monthUrls.set(ym, urls);
    return urls;
  };
  const out = [];
  for (const r of rows) {
    const s = shows.get(r.id);
    const w = s && sm.candidateWindow(s);
    if (!w) continue;
    const urls = [];
    for (const ym of sm.monthsBetween(w.lo, w.hi)) urls.push(...await getMonth(ym));
    const hits = sm.matchStandardSlugs(s, urls);
    if (hits.length) out.push({ showId: r.id, slot: 'standard', posts: hits.map(url => ({ url })) });
  }
  console.log(`STANDARD SITEMAP shows missing ${rows.length}; months fetched ${fetched}/${monthUrls.size}; with candidates ${out.length}`);
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1));
  if (monthUrls.size && !fetched) { console.error('STANDARD SITEMAP: every month failed to fetch (host blocked?)'); process.exit(1); }
}

// ---- run -------------------------------------------------------------------

const LEDGER = path.join(ROOT, 'data', 'audit', 'scraper-spend-ledger.jsonl');
// Rows at or after sinceIso. The ledger is append-ordered with a few out-of-order rows, so scan
// from the end and stop after a long run of older rows instead of parsing all 70k+ lines.
function ledgerRows(sinceIso) {
  let lines;
  try { lines = fs.readFileSync(LEDGER, 'utf8').split('\n'); } catch { return []; }
  const out = [];
  let older = 0;
  for (let i = lines.length - 1; i >= 0 && older < 500; i--) {
    if (!lines[i]) continue;
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r.ts >= sinceIso) { out.push(r); older = 0; } else older++;
  }
  return out;
}
// Campaign spend across runs (the $45 cap is for the whole campaign, not one run).
const STATE = path.join(ROOT, 'data', 'audit', 'we-major-recovery-state.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return { scraperUsd: 0, written: 0, runs: 0 };
    throw new Error(`campaign state unreadable, refusing to reset spend to $0: ${e.message}`); // a corrupt file must not turn the cap off
  }
}
function numArg(name, dflt) {
  const raw = arg(name);
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) { console.error(`--${name} must be a non-negative number, got "${raw}"`); process.exit(2); }
  return n;
}

function reviewDir(showId) { return path.join(require('./lib/review-texts-dir').resolveReviewTextsDir(), showId); }
function heldFiles(showId, outletIds) {
  let names = [];
  try { names = fs.readdirSync(reviewDir(showId)); } catch { return []; }
  return names.filter(n => outletIds.some(id => n.startsWith(`${id}--`)));
}

function ingest(showId, m, url, show) {
  const win = lib.showWindow(show, m.outletId);
  if (!win) return { outcome: 'no-show-window' };
  const before = new Set(heldFiles(showId, m.ids));
  const args = [path.join(__dirname, 'ingest-review-from-url.js'), `--show=${showId}`, `--url=${url}`, `--outlet=${m.outletId}`,
    `--date-window=${win.start},${win.end}`, '--require-publish-date'];
  const r = spawnSync('node', args, { encoding: 'utf8', timeout: 240000, env: process.env });
  const tail = ((r.stdout || '') + (r.stderr || '')).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
  const added = heldFiles(showId, m.ids).filter(n => !before.has(n));
  if (!added.length) {
    const skip = /Skipped: ([^—]+)/.exec(r.stdout || '');
    return { outcome: r.status === 0 ? `skipped:${skip ? skip[1].trim() : 'no-file'}` : `refused:exit${r.status}`, detail: tail };
  }
  // Wrong-show guard: a full-body ingest checks the date window only, so require the show's title in every body written.
  let kept = null, removed = 0, bodyChars = 0;
  for (const name of added) {
    const f = path.join(reviewDir(showId), name);
    let body = '';
    try { body = String(JSON.parse(fs.readFileSync(f, 'utf8')).fullText || ''); } catch { /* unreadable file counts as no body */ }
    if (body.length < 200 || !pageMentionsShowTitle(body, show.title)) { fs.unlinkSync(f); removed++; continue; }
    // BRO-6487: sitemap slugs often carry no venue; a same-title production elsewhere must not pass on the title alone.
    if (/standard/.test(m.outletId) && !require('./lib/we-sitemap-candidates.js').bodyNamesVenue(body, show.venue)) { fs.unlinkSync(f); removed++; continue; }
    kept = kept || name; bodyChars = body.length;
  }
  if (!kept) return { outcome: 'removed:wrong-show', detail: `${removed} file(s)` };
  return { outcome: 'ingested', file: kept, bodyChars };
}

async function cmdRun() {
  const capUsd = numArg('max-usd', 45);
  const state0 = readState();
  const tally = new lib.CostTally({ capUsd, reserveUsd: numArg('reserve-usd', 0), priorScraperUsd: state0.scraperUsd, priorWritten: state0.written });
  const pricing = require('./config/provider-pricing.json');
  const shows = new Map(rd('data/shows.json').shows.map(s => [s.id, s]));
  const rows = loadRows();
  const slotFilter = arg('slots') ? new Set(arg('slots').split(',')) : null;
  const queue = lib.orderQueue(rows, { slots: slotFilter });
  const cands = new Map();
  if (arg('candidates')) for (const c of JSON.parse(fs.readFileSync(arg('candidates'), 'utf8'))) cands.set(`${c.showId}|${c.slot}`, c.posts.map(p => p.url));
  const maxCalls = numArg('max-calls', Infinity);
  const dry = flag('dry-run');
  const serp = flag('serp');
  const debug = flag('debug'); // print every SERP query and verdict; also skips Google's date filter (unreliable for 2016-2020 articles)
  const startIso = new Date().toISOString();
  const results = [];
  let calls = 0;
  const saveState = () => dry || fs.writeFileSync(STATE, JSON.stringify({ scraperUsd: +tally.scraperUsd.toFixed(4), written: tally.priorWritten + tally.written, runs: (state0.runs || 0) + 1, updated: new Date().toISOString() }, null, 1));
  const refresh = () => { if (dry) return; tally.setScraperUsd(lib.ledgerUsd(ledgerRows(startIso), pricing, startIso).usd); saveState(); };

  console.log(`queue ${queue.length} slots (${cands.size} with a free candidate), cap $${capUsd}, serp=${serp}, dry=${dry}`);
  let stopped = null;
  for (const q of queue) {
    const m = lib.BY_SLOT.get(q.slot);
    const show = shows.get(q.showId);
    const rec = { showId: q.showId, season: q.season, slot: q.slot };
    if (heldFiles(q.showId, m.ids).length) { results.push({ ...rec, outcome: 'file-exists-unscored' }); continue; }
    const urls = cands.get(`${q.showId}|${q.slot}`);
    if (!urls && (!serp || m.serp === false)) { results.push({ ...rec, outcome: 'not-attempted' }); continue; }
    refresh();
    if (tally.wouldExceed(0.01)) { stopped = `cap: ${tally.line()}`; results.push({ ...rec, outcome: 'capped' }); continue; }
    if (dry) { results.push({ ...rec, outcome: urls ? 'would-ingest' : 'would-search' }); continue; }

    let found = urls || [];
    if (!urls) {
      if (calls >= maxCalls) { stopped = stopped || `max-calls ${maxCalls}`; results.push({ ...rec, outcome: 'capped:max-calls' }); continue; }
      calls++;
      const { discoverCorrectUrl } = require('./lib/url-discovery');
      const { looksLikeReview } = require('./collect-outlet-reviews.js');
      try {
        const res = await discoverCorrectUrl({ showId: q.showId, outletId: m.outletId, outlet: m.slot, criticName: null, url: null },
          process.env.SCRAPINGBEE_API_KEY || '', { brightDataKey: process.env.BRIGHTDATA_TOKEN || '', dateRange: null, forceHistorical: debug, domainOverride: m.domain, returnMetadata: true, log: debug ? console.log : () => {} });
        if (res === '__SERP_UNAVAILABLE__') { stopped = 'serp-unavailable'; results.push({ ...rec, outcome: 'serp-unavailable' }); break; }
        if (!res || typeof res !== 'object') { results.push({ ...rec, outcome: 'no-serp-hit' }); refresh(); await sleep(800); continue; }
        const host = new URL(res.url).hostname.replace(/^www\./, '');
        if (!lib.hostMatchesSlot(m, host)) { results.push({ ...rec, outcome: 'wrong-domain', url: res.url }); continue; }
        if (!looksLikeReview(res.url, res.serpTitle)) { results.push({ ...rec, outcome: 'not-a-review', url: res.url }); continue; }
        found = [res.url];
      } catch (e) { results.push({ ...rec, outcome: `serp-error:${String(e.message).slice(0, 80)}` }); continue; }
    }
    let done = null;
    for (const url of found) {
      refresh();
      if (tally.wouldExceed(0.01)) { stopped = `cap: ${tally.line()}`; break; }
      const r = ingest(q.showId, m, url, show);
      done = { ...rec, url, ...r };
      if (r.outcome === 'ingested') { tally.recordWritten(1); break; }
    }
    if (!done) { results.push({ ...rec, outcome: 'capped' }); continue; }
    results.push(done);
    refresh();
    console.log(`${q.showId} [${q.slot}] ${done.outcome} ${done.url || ''}`);
    if (results.length % 25 === 0) console.log(tally.line());
    await sleep(500);
  }
  refresh();
  console.log(tally.line());
  const by = {};
  for (const r of results) by[r.outcome.split(':')[0]] = (by[r.outcome.split(':')[0]] || 0) + 1;
  console.log('OUTCOMES', JSON.stringify(by), 'serpCalls', calls, stopped ? `STOPPED ${stopped}` : '');
  const summary = { capUsd, scraperUsd: +tally.scraperUsd.toFixed(4), ingested: tally.written, projectedScoringUsd: +tally.projectedScoringUsd.toFixed(4),
    projectedTotalUsd: +tally.projectedTotalUsd.toFixed(4), serpCalls: calls, stopped, outcomes: by };
  if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify({ summary, results }, null, 1));
  saveState();
}

const cmd = process.argv[2];
const table = { report: cmdReport, wos: cmdWos, guardian: cmdGuardian, sitemap: cmdSitemap, run: cmdRun };
if (require.main === module) {
  if (!table[cmd]) { console.error('Usage: node scripts/we-major-recovery.js <report|wos|guardian|sitemap|run> [flags] (see header)'); process.exit(2); }
  table[cmd]().catch(e => { console.error(e); process.exit(1); });
}
