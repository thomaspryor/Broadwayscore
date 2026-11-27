#!/usr/bin/env node
'use strict';
/**
 * BRO-8087 (test bench step 4): the owner's pacing rule for paid sandboxed lane redos, read from the redo spend ledger
 * before every run. Owner Decision 1 on BRO-7167 (2026-11-08): at most 3 redos a day, never within 24 h of an opening,
 * read the ledger before each run, hard stop at $50 total.
 *
 *   node scripts/test-bench-redo-pace.js check [--at=ISO] [--window-min=120] [--markets=broadway,off-broadway,west-end]
 *       prints the ledger reading and the verdict; exit 0 = a redo may start now, 3 = refused (reasons printed)
 *   node scripts/test-bench-redo-pace.js claim --show=ID --night=YYYY-MM-DD [--window-min=120]
 *       runs the check and, when it passes, writes a "started" row at the per-run estimate so a second run started
 *       before this one is recorded still counts it; prints the claim id for record (exit 3 = refused, nothing written)
 *   node scripts/test-bench-redo-pace.js next [--from=ISO] [--window-min=120]
 *       the first start time (30 min steps, up to 30 days) the rule allows
 *   node scripts/test-bench-redo-pace.js record --id=CLAIM --show=ID --night=YYYY-MM-DD --run-id=N --started=ISO --ended=ISO
 *       --scored=N [--status=graded|failed] [--grade=FILE] [--spend-ledger=data/audit/scraper-spend-ledger.jsonl]
 *       appends one row to the redo ledger with its spend, summed from the scraper-spend ledger rows of that show in
 *       that time span (Bright Data per call, Browserbase per row) plus an estimate for ensemble scoring per review
 *
 * "An opening" is any show in the markets the live lane runs on (LANE_ONLY_MARKETS, broadway,off-broadway) or West End,
 * not closed or cancelled. A run is refused when [start, start + window + setup] comes within 24 h of its embargo
 * (show.reviewEmbargoAt, else the market hour: press-night-record.js defaultEmbargoAt). The $50 stop refuses a run
 * whose estimated cost would take the ledger total past $50, so the stop is never crossed, only reached.
 * Ledger: data/audit/test-bench/redo-ledger.jsonl.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

const H = 3600 * 1000;
const MIN = 60 * 1000;
const DEFAULTS = Object.freeze({
  dailyMax: 3,
  capUsd: 50,
  // Plan cost table (docs/bro-7167-opening-night-test-bench.md): $1-3 scraping + about $1 scoring per night.
  estRunUsd: 5,
  gapH: 24,
  windowMin: 120,
  setupMin: 15,
  markets: ['broadway', 'off-broadway', 'west-end'],
});
// Rates: Bright Data $1.50 per 1,000 requests (provider-spend-daily.jsonl, 2026-11-24: $5.43 / 3,622 requests);
// Browserbase about $0.01 per lane session row; ensemble scoring (three models) about $0.05 per review, a deliberate
// overestimate of the plan's 3 cents because scoring cost is not logged per call.
const RATES = Object.freeze({ brightdataPerCall: 0.0015, browserbasePerRow: 0.01, scoringPerReview: 0.05 });

const LEDGER = process.env.TEST_BENCH_REDO_LEDGER || path.join(__dirname, '..', 'data', 'audit', 'test-bench', 'redo-ledger.jsonl');

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** New York calendar date of a time, the day the 3-a-day cap counts in. */
function nyDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** Openings that count for the 24 h rule: {id, category, at (ms)}. */
function openingInstants(shows, { markets = DEFAULTS.markets, embargoAt = null } = {}) {
  const emb = embargoAt || require('./lib/press-night-record').defaultEmbargoAt;
  const set = new Set(markets);
  const out = [];
  for (const s of shows || []) {
    if (!s || !s.openingDate || !set.has(s.category)) continue;
    if (/closed|cancel/i.test(String(s.status || ''))) continue;
    let at = null;
    try { at = Date.parse(emb(s)); } catch { at = null; }
    if (!Number.isFinite(at)) at = Date.parse(`${String(s.openingDate).slice(0, 10)}T02:00:00Z`) + 24 * H; // unknown: NY default, next-day 02:00Z
    out.push({ id: s.id, category: s.category, at });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** One row per run: a later row with the same `id` (record after claim) replaces the earlier one. */
function latestRows(rows) {
  // A settled row replaces its claim whatever the line order, so a reordered merge never puts a reservation back.
  const byId = new Map(); let anon = 0;
  for (const r of rows || []) {
    if (!r) continue;
    const id = r.id || `anon-${anon++}`;
    const prev = byId.get(id);
    if (prev && prev.status !== 'started' && r.status === 'started') continue;
    byId.set(id, r);
  }
  return [...byId.values()];
}

/** Ledger totals: spent (USD, every run; a claimed run counts at its estimate) and runs started on the New York day of `atMs`. */
function ledgerReading(allRows, atMs) {
  const rows = latestRows(allRows);
  const spentUsd = Math.round(rows.reduce((n, r) => n + (Number(r && r.spendUsd && r.spendUsd.total) || 0), 0) * 100) / 100;
  const day = nyDay(atMs);
  const today = rows.filter((r) => r && r.startedAt && nyDay(Date.parse(r.startedAt)) === day);
  return { runs: rows.length, spentUsd, today: today.length, day };
}

/**
 * The owner's rule for one prospective run. Pure.
 * @returns {{ok: boolean, reasons: string[], reading: object, blockingOpenings: object[]}}
 */
function paceCheck({ rows = [], openings = [], atMs, windowMin = DEFAULTS.windowMin, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const reading = ledgerReading(rows, atMs);
  const reasons = [];
  let overBudget = false;
  if (reading.today >= o.dailyMax) reasons.push(`${reading.today} redo(s) already started on ${reading.day} (max ${o.dailyMax} a day)`);
  if (reading.spentUsd + o.estRunUsd > o.capUsd) overBudget = true;
  if (overBudget) reasons.push(`ledger total $${reading.spentUsd.toFixed(2)} + this run's estimate $${o.estRunUsd} would pass the $${o.capUsd} stop`);
  const endMs = atMs + (windowMin + o.setupMin) * MIN;
  const gap = o.gapH * H;
  const blockingOpenings = openings.filter((x) => x.at + gap > atMs && x.at - gap < endMs);
  for (const b of blockingOpenings.slice(0, 5)) reasons.push(`${b.id} (${b.category}) embargo ${new Date(b.at).toISOString()} is within ${o.gapH} h of this run`);
  return { ok: reasons.length === 0, reasons, overBudget, reading, blockingOpenings };
}

/** First start time from `fromMs` (rounded up to 30 min) the rule allows, or null within `days`. */
function nextEligible({ rows = [], openings = [], fromMs, windowMin = DEFAULTS.windowMin, opts = {}, days = 30 }) {
  const step = 30 * MIN;
  let t = Math.ceil(fromMs / step) * step;
  const stop = fromMs + days * 24 * H;
  for (; t <= stop; t += step) {
    const c = paceCheck({ rows, openings, atMs: t, windowMin, opts });
    if (c.ok) return { at: new Date(t).toISOString(), check: c };
    // Out of budget never clears by waiting.
    if (c.overBudget) return null;
  }
  return null;
}

/** Spend of one redo from scraper-spend ledger rows for `showId` in [startMs, endMs]. Pure. */
function redoSpend(spendRows, { showId, startMs, endMs, scored = 0 }) {
  const mine = spendRows.filter((r) => r && r.showId === showId && Number.isFinite(Date.parse(r.ts)) && Date.parse(r.ts) >= startMs && Date.parse(r.ts) <= endMs);
  const count = (p) => mine.filter((r) => r.provider === p).length;
  const calls = { brightdata: count('brightdata'), browserbase: count('browserbase'), scrapingbee: count('scrapingbee'), scrapingdog: count('scrapingdog') };
  const scraping = calls.brightdata * RATES.brightdataPerCall + calls.browserbase * RATES.browserbasePerRow;
  const scoringEst = scored * RATES.scoringPerReview;
  const r2 = (n) => Math.round(n * 100) / 100;
  return { calls, scraping: r2(scraping), scoringEst: r2(scoringEst), total: r2(scraping + scoringEst), basis: 'BD $1.50/1k calls, Browserbase $0.01/row, scoring $0.05/review (estimate); ScrapingBee/ScrapingDog inside flat plans' };
}

function loadShows(repoDir) {
  const j = JSON.parse(fs.readFileSync(path.join(repoDir, 'data', 'shows.json'), 'utf8'));
  return Array.isArray(j) ? j : j.shows || [];
}

function printReading(reading) {
  console.log(`spend ledger (${path.relative(process.cwd(), LEDGER) || LEDGER}): ${reading.runs} redo(s), $${reading.spentUsd.toFixed(2)} of $${DEFAULTS.capUsd} spent, ${reading.today} started on ${reading.day} (max ${DEFAULTS.dailyMax})`);
}

function main(argv) {
  const arg = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  const cmd = argv.find((a) => !a.startsWith('-'));
  const repoDir = path.resolve(__dirname, '..');
  const windowMin = Number(arg('window-min')) > 0 ? Number(arg('window-min')) : DEFAULTS.windowMin;
  const markets = arg('markets') ? arg('markets').split(',').map((s) => s.trim()).filter(Boolean) : DEFAULTS.markets;
  const rows = readJsonl(LEDGER);
  if (cmd === 'claim') {
    if (!arg('show') || !/^\d{4}-\d{2}-\d{2}$/.test(arg('night') || '')) { console.error('claim needs --show and --night=YYYY-MM-DD'); return 2; }
    const atMs = Date.now();
    const c = paceCheck({ rows, openings: openingInstants(loadShows(repoDir), { markets }), atMs, windowMin });
    printReading(c.reading);
    // Serial only (plan Phase 2): an open claim means a run is in flight or was never recorded.
    const open = latestRows(rows).filter((r) => r.status === 'started');
    if (open.length) c.reasons.push(`claim ${open[0].id} is still open: record it (or record it --status=failed) before starting another run`);
    if (c.reasons.length) { console.log('REFUSED:'); for (const r of c.reasons) console.log(`  - ${r}`); return 3; }
    const id = `${arg('show')}@${new Date(atMs).toISOString()}`;
    const row = { id, show: arg('show'), night: arg('night'), startedAt: new Date(atMs).toISOString(), windowMin, status: 'started', spendUsd: { total: DEFAULTS.estRunUsd, basis: 'claim: per-run estimate until recorded' } };
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
    console.log(`CLAIMED ${id}`);
    console.log(`dispatch with window_min=${windowMin} (the CI default is 300; a longer run leaves the checked interval)`);
    return 0;
  }
  if (cmd === 'check' || cmd === 'next') {
    const openings = openingInstants(loadShows(repoDir), { markets });
    const atMs = Date.parse(arg(cmd === 'check' ? 'at' : 'from') || new Date().toISOString());
    if (!Number.isFinite(atMs)) { console.error('bad --at/--from time'); return 2; }
    if (cmd === 'check') {
      const c = paceCheck({ rows, openings, atMs, windowMin });
      printReading(c.reading);
      if (c.ok) { console.log(`OK: a ${windowMin}-min redo may start at ${new Date(atMs).toISOString()}`); return 0; }
      console.log(`REFUSED at ${new Date(atMs).toISOString()} (${windowMin}-min window):`);
      for (const r of c.reasons) console.log(`  - ${r}`);
      const n = nextEligible({ rows, openings, fromMs: atMs, windowMin });
      console.log(n ? `next eligible start: ${n.at}` : 'no eligible start in the next 30 days (or the $50 stop is reached)');
      return 3;
    }
    const n = nextEligible({ rows, openings, fromMs: atMs, windowMin });
    printReading(ledgerReading(rows, atMs));
    console.log(n ? `next eligible start: ${n.at}` : 'no eligible start in the next 30 days (or the $50 stop is reached)');
    return n ? 0 : 3;
  }
  if (cmd === 'record') {
    const need = ['show', 'night', 'run-id', 'started', 'ended', 'scored'];
    const miss = need.filter((k) => arg(k) == null);
    if (miss.length) { console.error(`record needs --${miss.join(', --')}`); return 2; }
    const startMs = Date.parse(arg('started')); const endMs = Date.parse(arg('ended'));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) { console.error('bad --started/--ended'); return 2; }
    const spendRows = readJsonl(arg('spend-ledger') || path.join(repoDir, 'data', 'audit', 'scraper-spend-ledger.jsonl'));
    const spendUsd = redoSpend(spendRows, { showId: arg('show'), startMs, endMs, scored: Number(arg('scored')) || 0 });
    // No spend rows for the run (its CI ledger push failed, or this checkout is stale): keep the reservation, never $0.
    if (Object.values(spendUsd.calls).every((n) => n === 0)) {
      spendUsd.total = Math.max(spendUsd.total, DEFAULTS.estRunUsd);
      spendUsd.basis = `no scraper-spend rows for this run: kept at the $${DEFAULTS.estRunUsd} per-run estimate; ${spendUsd.basis}`;
    }
    const prior = latestRows(rows).find((r) => r.id && r.id === arg('id'));
    const row = { id: arg('id') || `${arg('show')}@${new Date(startMs).toISOString()}`, show: arg('show'), night: arg('night'), runId: arg('run-id'), startedAt: new Date(startMs).toISOString(), endedAt: new Date(endMs).toISOString(), status: arg('status') || 'graded', scored: Number(arg('scored')) || 0, grade: arg('grade') || null, spendUsd, recordedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, `${JSON.stringify(row)}\n`);
    if (arg('id') && !prior) console.error(`note: no claim row with id ${arg('id')}; recording as a new run`);
    printReading(ledgerReading([...rows, row], Date.now()));
    console.log(`recorded ${row.show} ${row.night}: $${spendUsd.total.toFixed(2)} (${JSON.stringify(spendUsd.calls)})`);
    return 0;
  }
  console.error('usage: test-bench-redo-pace.js check|next|record (see --help)');
  return 2;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(fs.readFileSync(__filename, 'utf8').split('/**')[1].split('*/')[0].replace(/^ \* ?/gm, '').trim()); process.exit(0); }
  process.exitCode = main(argv);
}

module.exports = { DEFAULTS, RATES, nyDay, openingInstants, latestRows, ledgerReading, paceCheck, nextEligible, redoSpend };
