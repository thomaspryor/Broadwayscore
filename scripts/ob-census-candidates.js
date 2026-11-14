#!/usr/bin/env node
'use strict';

/**
 * ob-census-candidates.js (BRO-6496): outlet-first candidate list for an
 * Off-Broadway historical backfill window.
 *
 * READ-ONLY. Reads outlet-census manifests (scripts/outlet-census.js run with
 * --since at or before the window) and counts, for each candidate title, the
 * distinct outlets whose review in the window names it. Notable = 2+ distinct
 * T1/T2 outlets, or 1 T1 plus 2 others (docs/specs/ob-historical-backfill-v2.md,
 * pre-COVID trial). Candidate titles come from theater-scene's Off-Broadway
 * review headlines (title-only) and TheaterMania's OB listings for the window;
 * TheaterMania is a title source only, never the notability evidence.
 *
 * Writes the notable list to --out as the JSON plan-ob-historical-cohort.js
 * --candidates-file reads, ranked by T1/T2 outlet count.
 *
 * Usage:
 *   node scripts/ob-census-candidates.js --from=2018-06-01 --to=2020-03-15 \
 *     --census-dir=data/audit/outlet-census-precovid --out=/tmp/cands.json [--no-tm] [--min-t12=2]
 *   (outlet-census-precovid holds the 2018-06 census manifests, trimmed to the publish window.)
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

const ROOT = path.join(__dirname, '..');
const DAY_MS = 86400 * 1000;
const USAGE = 'Usage: node scripts/ob-census-candidates.js --from=YYYY-MM-DD --to=YYYY-MM-DD --out=PATH [--census-dir=DIR] [--no-tm] [--min-t12=2]';

const titleKey = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const slugText = (u) => {
  let p = String(u || '').replace(/^https?:\/\/[^/]+/, '').replace(/_\d+\/?$/, '');
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  return titleKey(p.replace(/[-/]/g, ' '));
};
/** Display title: drop wrapping quotes and a trailing market tag. */
const cleanTitle = (t) => String(t || '').replace(/\s*\((?:off-broadway|broadway)\)\s*$/i, '').trim().replace(/^["“'‘](.*)["”'’]$/, '$1').trim();

/**
 * Does this census item name the title? A one-word title, or an article plus one
 * word ("The Light"), reads as a plain phrase inside other headlines, so it must be
 * the whole headline or sit next to "review" in the headline or slug.
 */
function itemNames(item, key) {
  const words = key.split(' ');
  const generic = words.length === 1 || (words.length === 2 && ['the', 'a', 'an'].includes(words[0]));
  const hk = titleKey(item.headline);
  const sk = slugText(item.url);
  if (generic) {
    const near = (t) => t === key || t === `review ${key}` || t.startsWith(`${key} review`) || t.startsWith(`review ${key} `) || t.endsWith(` ${key} review`);
    return near(hk) || near(sk) || ` ${sk} `.includes(` ${key} review `);
  }
  return ` ${hk} `.includes(` ${key} `) || ` ${sk} `.includes(` ${key} `);
}

// Census buckets that do not count: held*, misfile (URLs we already hold for a
// cataloged show). out-of-window counts: it is an earlier run of a cataloged title.
// theater-scene's reviews all land in not-review (the census cannot read its review
// markers), so for that one outlet not-review still counts.
const SKIP_BUCKETS = new Set(['held', 'held-alt-url', 'held-other-market', 'held-unmatched', 'misfile']);
const countsAsReview = (outletId, bucket) => !SKIP_BUCKETS.has(bucket) && (bucket !== 'not-review' || outletId === 'theater-scene');

/** Notability from per-outlet tiers (one entry per distinct outlet). */
function notability(tiers) {
  const t1 = tiers.filter((t) => t === 1).length;
  const t12 = tiers.filter((t) => t <= 2).length;
  return { t1, t12, notable: t12 >= 2 || (t1 >= 1 && tiers.length - t1 >= 2) };
}

function arg(name) {
  const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return 0; }
  const fromIso = arg('from'); const toIso = arg('to'); const out = arg('out');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso || '') || !/^\d{4}-\d{2}-\d{2}$/.test(toIso || '') || !out) { console.error(USAGE); return 2; }
  const dir = path.resolve(arg('census-dir') || path.join(ROOT, 'data', 'audit', 'outlet-census'));
  const minT12 = Number(arg('min-t12')) || 2;
  // Reviews trail a run's start; allow a month before and three after the window.
  const pubFrom = new Date(Date.parse(fromIso) - 31 * DAY_MS).toISOString().slice(0, 10);
  const pubTo = new Date(Date.parse(toIso) + 92 * DAY_MS).toISOString().slice(0, 10);

  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'outlet-registry.json'), 'utf8'));
  const outlets = reg.outlets || reg;
  const tierOf = (id) => { const o = Array.isArray(outlets) ? outlets.find((x) => x.id === id) : outlets[id]; return o ? Number(o.tier) || 9 : 9; };

  const items = [];
  const used = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.manifest.json'))) {
    const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!m.since || m.since > fromIso) continue; // enumerated too late to cover the window
    used.push(m.outletId);
    for (const i of m.items) {
      if (!i.publishDate || i.publishDate < pubFrom || i.publishDate > pubTo) continue;
      if (!countsAsReview(m.outletId, i.bucket)) continue;
      items.push({ outlet: m.outletId, tier: tierOf(m.outletId), date: i.publishDate, url: i.url, headline: i.headline || '' });
    }
  }
  if (!used.length) { console.error(`no census manifest in ${dir} starts on or before ${fromIso}; run outlet-census.js --since=${fromIso}`); return 1; }

  const cands = new Map();
  const add = (title, src) => { const t = cleanTitle(title); const k = titleKey(t); if (k && !cands.has(k)) cands.set(k, { title: t, key: k, src }); };
  for (const i of items) if (i.outlet === 'theater-scene' && /\/(?:offbway|off-broadway)|\/solo-plays\//.test(i.url)) add(i.headline, 'theater-scene');
  if (!process.argv.includes('--no-tm')) {
    const { fetchTmOffBroadway, isTmRowInWindow, parseTmOffBroadwayRow } = require('./lib/theatermania-ob');
    const feed = await fetchTmOffBroadway({ maxPages: 120, rowFilter: (r) => isTmRowInWindow(r, { fromIso, toIso }), stopWhenPageEmpty: false, orderby: 'id' });
    for (const row of feed.rows) { const r = parseTmOffBroadwayRow(row, { venuesById: feed.venuesById, genresById: feed.genresById }); if (!r.skip) add(r.candidate.title, 'theatermania'); }
  }

  const rows = [];
  for (const c of cands.values()) {
    const byOutlet = new Map();
    for (const i of items) if (!byOutlet.has(i.outlet) && itemNames(i, c.key)) byOutlet.set(i.outlet, i);
    const hits = [...byOutlet.values()].sort((a, b) => a.date.localeCompare(b.date));
    const n = notability(hits.map((h) => h.tier));
    if (!n.notable || n.t12 < minT12) continue;
    // Earliest in-window review: the planner's claimed opening (Playbill dates win, 30-day tolerance).
    const first = hits.find((h) => h.date >= fromIso && h.date <= toIso) || hits[0];
    rows.push({ title: c.title, openingDate: first.date, titleSource: c.src, t1: n.t1, t12: n.t12, outlets: hits.map((h) => h.outlet), evidenceUrls: hits.map((h) => h.url) });
  }
  rows.sort((a, b) => b.t12 - a.t12 || b.t1 - a.t1 || a.title.localeCompare(b.title));
  fs.writeFileSync(out, JSON.stringify(rows, null, 1) + '\n');
  const dist = {};
  for (const r of rows) dist[r.t12] = (dist[r.t12] || 0) + 1;
  console.log(`census outlets: ${used.join(',')}`);
  console.log(`items in publish window ${pubFrom}..${pubTo}: ${items.length}; candidate titles ${cands.size}; notable ${rows.length}`);
  console.log(`by T1/T2 outlet count: ${JSON.stringify(dist)}`);
  console.log(`wrote ${out}`);
  return 0;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });

module.exports = { titleKey, cleanTitle, itemNames, notability, countsAsReview };
