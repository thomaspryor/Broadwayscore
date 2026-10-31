#!/usr/bin/env node
/**
 * Stage Chicago productions from the theatreinchicago crawl cache (BRO-6518).
 *
 *   node scripts/tic-stage-shows.js --cache=<dir> --out=<manifest.json> [--limit=N] [--ids=1,2,3]
 *
 * For each cached reviews page that passes the prefilter: fetch the detail page
 * (show type, theater, address, dates) and the first two reviews on free outlets
 * (publish dates -> openingDate proxy), then emit a manifest of
 * { show, reviewUrls } ready for add-show plans and ingest-urls. Resumable via
 * the manifest file (ids already staged or rejected are skipped).
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const { extractPublishDate } = require('./lib/article-extractor');
const tic = require('./lib/theatreinchicago');
const stage = require('./lib/tic-stage');

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Outlets that are paywalled or JS-walled: skip when picking date samples.
const PAYWALLED = /tribune|sun-times|suntimes|wsj|nytimes|new york times/i;

async function openingDateFor(page) {
  const picks = stage.linkedReviews(page).filter((r) => !PAYWALLED.test(r.outlet) && !PAYWALLED.test(r.url)).slice(0, 3);
  const dates = [];
  for (const r of picks) {
    try {
      const res = await fetchPage(r.url, { skipVerify: true });
      const d = extractPublishDate(res.content, r.url);
      if (d) dates.push(String(d).slice(0, 10));
    } catch { /* try next */ }
    await sleep(800);
    if (dates.length >= 2) break;
  }
  dates.sort();
  return dates.length ? { openingDate: dates[0], samples: dates } : null;
}

async function main() {
  const cacheDir = arg('cache');
  const out = arg('out');
  if (!cacheDir || !out) throw new Error('--cache and --out required');
  const limit = Number(arg('limit', 100000));
  const only = arg('ids') ? new Set(arg('ids').split(',').map(Number)) : null;
  const manifest = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { staged: {}, rejected: {} };
  const shows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const existing = shows.shows || shows;
  const today = new Date().toISOString().slice(0, 10);

  const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).sort((a, b) => parseInt(b) - parseInt(a));
  let done = 0;
  for (const f of files) {
    const id = parseInt(f, 10);
    if (only && !only.has(id)) continue;
    if (manifest.staged[id] || manifest.rejected[id]) continue;
    const page = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8'));
    const pre = stage.prefilter(page);
    if (!pre.ok) { manifest.rejected[id] = pre.reason; continue; }
    if (done >= limit) break;
    done++;
    try {
      const dres = await fetchPage(tic.detailUrl(page.id, page.slug), { skipVerify: true });
      const detail = tic.parseDetailPage(dres.content);
      const df = stage.detailFilter(detail);
      if (!df.ok) { manifest.rejected[id] = df.reason; continue; }
      const dates = await openingDateFor(page);
      if (!dates) { manifest.rejected[id] = 'no-publish-date'; continue; }
      const entry = stage.buildShowEntry({ page, detail, dates, discoveredAt: today });
      const dupe = stage.findDuplicate(entry, [...existing, ...Object.values(manifest.staged).map((r) => r.show)]);
      if (dupe) { manifest.rejected[id] = `duplicate:${dupe.id}`; continue; }
      stage.dedupeId(entry, page, new Set([...existing.map((x) => x.id), ...Object.values(manifest.staged).map((r) => r.show.id)]));
      manifest.staged[id] = {
        show: entry,
        poster: page.poster || detail.poster || null,
        reviews: stage.linkedReviews(page).map((r) => ({ outlet: r.outlet, critic: r.critic, url: r.url, verdict: r.verdict })),
      };
      console.log(`staged ${id} ${entry.id} (${entry.venue}) reviews=${manifest.staged[id].reviews.length}`);
    } catch (e) {
      console.log(`id ${id}: ERROR ${e.message}`);
      continue;
    }
    if (done % 10 === 0) fs.writeFileSync(out, JSON.stringify(manifest));
    await sleep(800);
  }
  fs.writeFileSync(out, JSON.stringify(manifest));
  const rej = {};
  for (const v of Object.values(manifest.rejected)) { const k = String(v).split(':')[0]; rej[k] = (rej[k] || 0) + 1; }
  console.log(`[stage] staged=${Object.keys(manifest.staged).length} rejected=`, rej);
  await cleanup();
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { openingDateFor };
