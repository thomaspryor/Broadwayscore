#!/usr/bin/env node
'use strict';
/**
 * Harvest announced closing dates for city-hub regional shows from their own review articles (BRO-7239).
 *   node scripts/harvest-hub-run-dates.js [--out=data/audit/hub-run-dates.json] [--max=6]
 * For each local show on a launched hub: fetch up to --max review URLs via fetchPage(), pull "through <date>"
 * language (scripts/lib/run-end-from-text.js), and record the best date with the article URL as the source.
 */
const fs = require('fs');
require('./lib/cli-help').exitOnHelp(module);
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const { runEndCandidates, pickRunEnd } = require('./lib/run-end-from-text');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const strip = (h) => String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&#8211;|&ndash;/g, '-').replace(/&amp;/g, '&').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ');

(async () => {
  const hubs = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/city-hubs.json'), 'utf8')).hubs;
  const slugs = Object.entries(hubs).filter(([, h]) => h.finder && h.launched).map(([k]) => k);
  const sj = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const shows = (Array.isArray(sj) ? sj : sj.shows).filter((s) => slugs.includes(s.city));
  const rj = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/reviews.json'), 'utf8'));
  const reviews = Array.isArray(rj) ? rj : (rj.reviews || Object.values(rj));
  const max = Number(arg('max', 6));
  const outFile = path.join(ROOT, arg('out', 'data/audit/hub-run-dates.json'));
  let out = {};
  try { out = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* fresh */ }
  for (const s of shows) {
    if (out[s.id] && out[s.id].done) continue;
    const urls = [...new Set([...(s.evidenceUrls || []), ...reviews.filter((r) => r.showId === s.id).map((r) => r.url)])].filter((u) => /^https?:/.test(u) && !/sandiegostory\.com/.test(u)).slice(0, max);
    const found = [];
    for (const url of urls) {
      let p = null;
      try { p = await fetchPage(url, { skipVerify: true }); } catch { /* skip */ }
      if (!p || !p.content) continue;
      const text = strip(p.content);
      const dm = /datePublished"\s*:\s*"(20\d\d-\d\d-\d\d)/.exec(p.content) || /\/(20\d\d)\/(\d\d)\/(\d\d)\//.exec(url);
      const articleDate = dm ? (dm.length === 2 ? dm[1] : `${dm[1]}-${dm[2]}-${dm[3]}`) : null;
      for (const c of runEndCandidates(text, { opening: s.openingDate, articleDate })) found.push({ ...c, url });
    }
    out[s.id] = { done: true, title: s.title, opening: s.openingDate, best: pickRunEnd(found), candidates: found.slice(0, 8) };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
    console.error(`${s.id.slice(0, 50).padEnd(50)} ${out[s.id].best || '-'} (${found.length} hits / ${urls.length} urls)`);
  }
  await cleanup();
})().catch((e) => { console.error(e); process.exit(1); });
