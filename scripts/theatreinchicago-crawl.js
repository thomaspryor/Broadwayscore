#!/usr/bin/env node
/**
 * Crawl theatreinchicago.com review pages by numeric id (BRO-6518).
 *
 *   node scripts/theatreinchicago-crawl.js --from=13599 --to=12300 [--delay=2500] [--cache=<dir>]
 *   node scripts/theatreinchicago-crawl.js --list           # current /reviewlistings.php ids
 *
 * Everything goes through fetchPage() with skipVerify (the site 301s any slug
 * to the canonical one, which the url_mismatch guard would reject). Parsed
 * pages are cached one JSON per id under --cache (full excerpts stay in the
 * cache only, they are third-party text); the committed index
 * data/theatreinchicago-index.json holds ids, titles, venues, outlets,
 * verdicts and review urls, no excerpts.
 *
 * Resumable: ids already in the cache are skipped. Checkpoints every 20 ids.
 */

require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const tic = require('./lib/theatreinchicago');

const INDEX_PATH = path.join(__dirname, '..', 'data', 'theatreinchicago-index.json');

function arg(name, def) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
const flag = (name) => process.argv.includes(`--${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); } catch { return { updatedAt: null, shows: {}, empty: [] }; }
}

/** Compact, excerpt-free row for the committed index. */
function indexRow(page) {
  return {
    t: page.title,
    s: page.slug,
    v: page.venue,
    c: page.closingDate,
    p: page.poster,
    r: page.reviews.map((r) => ({ o: r.outlet, a: r.critic, v: r.verdict, u: r.url })),
  };
}

function saveIndex(index) {
  index.updatedAt = new Date().toISOString();
  index.empty = [...new Set(index.empty)].sort((a, b) => a - b);
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index) + '\n');
}

async function fetchOne(id, cacheDir) {
  const file = path.join(cacheDir, `${id}.json`);
  if (fs.existsSync(file)) return { cached: true, page: JSON.parse(fs.readFileSync(file, 'utf8')) };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchPage(tic.reviewsUrl(id), { skipVerify: true });
      const page = tic.parseReviewsPage(r.content, id);
      fs.writeFileSync(file, JSON.stringify(page));
      return { cached: false, page };
    } catch (e) {
      lastErr = e;
      await sleep(5000);
    }
  }
  return { error: lastErr && lastErr.message };
}

async function main() {
  if (flag('list')) {
    const r = await fetchPage(`${tic.BASE}/reviewlistings.php`);
    const rows = tic.parseListing(r.content);
    console.log(JSON.stringify(rows.map((x) => x.id)));
    await cleanup();
    return;
  }
  const from = Number(arg('from'));
  const to = Number(arg('to'));
  if (!from || !to) throw new Error('--from and --to required');
  const delay = Number(arg('delay', 2500));
  const cacheDir = arg('cache', path.join(__dirname, '..', 'data', 'cache', 'theatreinchicago'));
  fs.mkdirSync(cacheDir, { recursive: true });
  const step = from >= to ? -1 : 1;
  const index = loadIndex();
  let n = 0, fetched = 0, errors = 0;
  for (let id = from; step < 0 ? id >= to : id <= to; id += step) {
    const res = await fetchOne(id, cacheDir);
    n++;
    if (res.error) {
      errors++;
      console.log(`id ${id}: ERROR ${res.error}`);
    } else {
      if (!res.cached) fetched++;
      if (res.page.empty) index.empty.push(id);
      else index.shows[id] = indexRow(res.page);
    }
    if (n % 20 === 0) {
      saveIndex(index);
      console.log(`[crawl] ${n} ids (id ${id}) fetched=${fetched} errors=${errors} shows=${Object.keys(index.shows).length}`);
    }
    if (!res.cached) await sleep(delay + Math.floor(Math.random() * 800));
  }
  saveIndex(index);
  console.log(`[crawl] done ${n} ids fetched=${fetched} errors=${errors} shows=${Object.keys(index.shows).length}`);
  await cleanup();
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { indexRow };
