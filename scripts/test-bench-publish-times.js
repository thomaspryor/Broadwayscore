#!/usr/bin/env node
'use strict';
/**
 * BRO-7167 test bench, step 1: collect exact publish times for a past opening
 * night's reviews and work out its real embargo (scripts/lib/observed-embargo.js).
 *
 * $0: plain fetches of each review page (no scraper APIs, no paid tiers). Only
 * page metadata is read; no page text is stored. Output (public fields only):
 *   data/audit/test-bench/publish-times/<show>.json  per-review {outlet, url, publishedTime, precision, source, status}
 *   data/audit/test-bench/nights.json                one row per night: estimate, observed embargo, shift
 *
 * Usage:
 *   node scripts/test-bench-publish-times.js --show=a-few-good-men-2026 [--data-dir=PATH] [--out-dir=PATH]
 *   node scripts/test-bench-publish-times.js --shows=a,b,c
 *   node scripts/test-bench-publish-times.js --show=ID --from-file=rows.json   (no network; rows already collected)
 *   node scripts/test-bench-publish-times.js --shows=a,b --from-file=DIR/publish-times/{id}.json   (re-derive nights from a past run)
 * Exit 0 on success, 1 on bad input, 2 if every fetch failed.
 */
const fs = require('fs');
const path = require('path');
const { parsePrecisePublishTime } = require('./lib/time-to-publish-sla');
const { estimateEmbargoMs, pickPressNight } = require('./lib/opening-grade');
const { observedEmbargo } = require('./lib/observed-embargo');

const ROOT = path.join(__dirname, '..');
const UA = 'Mozilla/5.0 (compatible; BroadwayScorecardBot/1.0; +https://broadwayscorecard.com)';
const MAX_URLS = 80;
const GAP_MS = 400;
const TIMEOUT_MS = 20000;

function arg(name, def = null) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
}

/** First publish-time candidate in page metadata, with where it came from. Pure. */
function extractPublishTime(html) {
  if (!html || typeof html !== 'string') return { value: null, source: null };
  const pats = [
    ['article:published_time', /<meta[^>]+property=["']article:published_time["'][^>]*content=["']([^"']+)/i],
    ['article:published_time', /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i],
    ['json-ld datePublished', /"datePublished"\s*:\s*"([^"]+)"/i],
    ['meta datePublished', /<meta[^>]+itemprop=["']datePublished["'][^>]*content=["']([^"']+)/i],
    ['time datetime', /<time[^>]*datetime=["']([^"']+)/i],
  ];
  for (const [source, re] of pats) {
    const m = html.match(re);
    if (m && m[1].trim()) return { value: m[1].trim(), source };
  }
  return { value: null, source: null };
}

/** exact (clock time + zone), assumed-zone (clock time, no zone), date, or null. Pure. */
function precisionOf(value) {
  if (!value) return null;
  const p = parsePrecisePublishTime(value);
  if (!p) return /^\d{4}-\d{2}-\d{2}/.test(value) ? 'date' : null;
  return p.assumedZone ? 'assumed-zone' : 'exact';
}

async function fetchOne(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html' } });
    const html = res.ok ? (await res.text()).slice(0, 600000) : '';
    return { status: res.status, ...extractPublishTime(html) };
  } catch (e) {
    return { status: e.name === 'AbortError' ? 'timeout' : 'error', value: null, source: null };
  } finally { clearTimeout(timer); }
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function pressNightFor(dataDir, show) {
  const dir = path.join(dataDir, 'audit', 'press-night');
  const recs = [];
  for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])) {
    if (f.startsWith(`${show.id}-`) && f.endsWith('.json')) { const r = readJson(path.join(dir, f), null); if (r) recs.push(r); }
  }
  return recs.length ? pickPressNight(recs, show) : null;
}

/** A re-run where no page loaded must not overwrite a night collected earlier. Pure. */
function keepPrevious(prev, rows) {
  return Boolean(prev && prev.observed) && !rows.some((r) => r.status === 200);
}

/** The night row for nights.json. Pure apart from its inputs. */
function nightRow({ show, pressNight, rows, collectedAt }) {
  const recorded = pressNight && Date.parse(pressNight.embargoAt);
  const estimateMs = Number.isFinite(recorded) ? recorded : estimateEmbargoMs(show.openingDate, show.category);
  const obs = observedEmbargo({ estimateMs, publishTimes: rows });
  const count = (p) => rows.filter((r) => r.precision === p).length;
  return {
    showId: show.id, title: show.title || show.id, category: show.category, openingDate: show.openingDate,
    estimate: { at: estimateMs == null ? null : new Date(estimateMs).toISOString(), from: Number.isFinite(recorded) ? 'press-night record' : '22:00 local estimate' },
    observed: { at: obs.at, source: obs.source, clusterSize: obs.n, shiftMin: obs.shiftMin, clusterOutlets: obs.outlets },
    embargoCorrected: obs.source === 'observed-cluster' && obs.shiftMin !== 0,
    reviews: rows.length, exact: count('exact'), assumedZone: count('assumed-zone'), dateOnly: count('date'),
    fetchFailed: rows.filter((r) => typeof r.status !== 'number' || r.status >= 400).length,
    collectedAt,
  };
}

async function main() {
  const dataDir = path.resolve(arg('data-dir', path.join(ROOT, 'data')));
  const outDir = path.resolve(arg('out-dir', path.join(ROOT, 'data', 'audit', 'test-bench')));
  const ids = (arg('shows') || arg('show') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length) { console.error('need --show=ID or --shows=a,b'); process.exit(1); }
  const shows = readJson(path.join(dataDir, 'shows.json'), null);
  const reviewsRaw = readJson(path.join(dataDir, 'reviews.json'), null);
  if (!shows || !reviewsRaw) { console.error(`shows.json / reviews.json not found under ${dataDir}`); process.exit(1); }
  const showList = Array.isArray(shows) ? shows : shows.shows || [];
  const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : reviewsRaw.reviews || [];

  fs.mkdirSync(path.join(outDir, 'publish-times'), { recursive: true });
  const nightsPath = path.join(outDir, 'nights.json');
  const nights = readJson(nightsPath, {});
  if (!nights.nights || typeof nights.nights !== 'object') nights.nights = {};
  let anyOk = false;

  for (const id of ids) {
    const show = showList.find((s) => s.id === id);
    if (!show) { console.error(`unknown show ${id}`); process.exit(1); }
    const collectedAt = new Date().toISOString();
    let rows;
    const fromFile = arg('from-file');
    if (fromFile) {
      const src = readJson(path.resolve(fromFile.replace('{id}', id)), []);
      rows = (Array.isArray(src) ? src : src.rows || []).map((r) => ({ outlet: r.outlet, url: r.url || null, publishedTime: r.publishedTime || null, precision: precisionOf(r.publishedTime), source: r.source || 'from-file', status: r.status ?? 200 }));
    } else {
      const seen = new Set();
      const targets = reviews.filter((r) => r.showId === id && r.url && !seen.has(r.url) && seen.add(r.url)).slice(0, MAX_URLS);
      rows = [];
      for (const r of targets) {
        const got = await fetchOne(r.url);
        rows.push({ outlet: r.outlet || r.outletId || null, url: r.url, publishedTime: got.value, precision: precisionOf(got.value), source: got.source, status: got.status });
        await new Promise((ok) => setTimeout(ok, GAP_MS));
      }
    }
    if (rows.some((r) => r.status === 200)) anyOk = true;
    if (keepPrevious(nights.nights[id], rows)) {
      console.error(`${id}: no page fetched this run; kept the previous row (${nights.nights[id].observed.source})`);
      continue;
    }
    fs.writeFileSync(path.join(outDir, 'publish-times', `${id}.json`), JSON.stringify({ showId: id, openingDate: show.openingDate, collectedAt, rows }, null, 1) + '\n');
    const row = nightRow({ show, pressNight: pressNightFor(dataDir, show), rows, collectedAt });
    nights.nights[id] = row;
    console.log(`${id}: ${row.reviews} reviews, ${row.exact} exact; estimate ${row.estimate.at} (${row.estimate.from}) -> observed ${row.observed.at} (${row.observed.source}, n=${row.observed.clusterSize}, shift ${row.observed.shiftMin} min)`);
  }
  nights.updatedAt = new Date().toISOString();
  nights.method = 'scripts/lib/observed-embargo.js: earliest 5-min window with 3+ outlets publishing at an exact time, within 6h of the estimate, snapped to the quarter hour';
  fs.writeFileSync(nightsPath, JSON.stringify(nights, null, 1) + '\n');
  if (!anyOk && !arg('from-file')) process.exit(2);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { extractPublishTime, precisionOf, nightRow, keepPrevious };
