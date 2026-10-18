#!/usr/bin/env node
/**
 * Find URLs for Daily Mail / Mail on Sunday review files that have text but no
 * URL (Theatre Record imports), by matching the review's own sentences against
 * the articles DM published around the review date. BRO-716.
 *
 * Matching rules, placement and rating parsing: scripts/lib/dailymail-url-discovery.js
 *
 * Usage:
 *   node scripts/discover-dailymail-urls.js                     report only (all West End DM files)
 *   node scripts/discover-dailymail-urls.js --show=ID           one show
 *   node scripts/discover-dailymail-urls.js --apply             also write url (+ section stars) to review files
 *   node scripts/discover-dailymail-urls.js --out=path.json     write the report here
 *   node scripts/discover-dailymail-urls.js --all-markets       not just West End / London shows
 *
 * Fetching: DM article and archive pages normally serve plainly, so this uses
 * fetch() first. A run is ~1-2K page loads; sending all of them through
 * fetchPage() would spend Bright Data credits on pages that never need it.
 * DM does start answering 403 after tens of thousands of loads from one IP, so
 * a 403/429 falls back to fetchPage(), and the run fails loudly (exit 2) when
 * most day archives are unreachable instead of reporting "0 matched".
 */
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { safeWriteReview } = require('./lib/review-write-guard');
const { hasHelpFlag } = require('./lib/cli-help.js');
const L = require('./lib/dailymail-url-discovery');

const USAGE = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 16).map(l => l.replace(/^ \* ?/, '')).join('\n');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const DM = 'https://www.dailymail.co.uk';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const DAYS_BEFORE = 4; // DM often runs the review the night of press night, before TR's date
const DAYS_AFTER = 3;
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const arg = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
const APPLY = args.includes('--apply');
const ALL_MARKETS = args.includes('--all-markets');
const ONLY_SHOW = arg('show');
const OUT = arg('out');

let blockedDirect = false; // once DM 403s this IP, stop knocking and go straight to fetchPage()

async function viaFetchPage(url) {
  try {
    const { fetchPage } = require('./lib/scraper');
    const r = await fetchPage(url);
    return r && r.content ? r.content : null;
  } catch { return null; }
}

async function get(url) {
  if (blockedDirect) return viaFetchPage(url);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(40000) });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
      if (r.status === 403 || r.status === 429) {
        if (!blockedDirect) console.warn(`DM answered ${r.status}; falling back to fetchPage() for the rest of the run`);
        blockedDirect = true;
        return viaFetchPage(url);
      }
    } catch { /* retry */ }
    await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
  }
  return null;
}

async function pool(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

function loadTargets() {
  const out = [];
  for (const showId of listShowDirs(REVIEW_TEXTS_DIR, { silent: true })) {
    if (ONLY_SHOW && showId !== ONLY_SHOW) continue;
    if (!ONLY_SHOW && !ALL_MARKETS && !/west-end|london/.test(showId)) continue;
    const dir = path.join(REVIEW_TEXTS_DIR, showId);
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('daily-mail--') || !f.endsWith('.json')) continue;
      const filePath = path.join(dir, f);
      let j;
      try { j = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      if (j.url || !j.publishDate || !/^\d{4}-\d{2}-\d{2}/.test(j.publishDate)) continue;
      if (L.normWords(j.fullText).length < 40) continue; // too little text to match on
      out.push({ filePath, file: `${showId}/${f}`, data: j });
    }
  }
  return out;
}

function windowDays(isoDate) {
  const t = Date.parse(isoDate.slice(0, 10) + 'T12:00:00Z');
  const days = [];
  for (let k = -DAYS_BEFORE; k <= DAYS_AFTER; k++) days.push(new Date(t + k * 864e5).toISOString().slice(0, 10).replace(/-/g, ''));
  return days;
}

async function main() {
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const targets = loadTargets();
  console.log(`${targets.length} URL-less Daily Mail review file(s) with text`);
  if (!targets.length) return;

  const allDays = [...new Set(targets.flatMap(t => windowDays(t.data.publishDate)))];
  const dayLinks = {};
  await pool(allDays, async d => {
    const html = await get(`${DM}/home/sitemaparchive/day_${d}.html`);
    dayLinks[d] = html ? L.parseDayArchive(html).filter(L.isCandidatePath) : [];
  });
  const missingDays = allDays.filter(d => !dayLinks[d].length);
  console.log(`${allDays.length} day archive(s) read${missingDays.length ? `, ${missingDays.length} empty/unreachable` : ''}`);
  if (missingDays.length > allDays.length / 2) {
    console.error(`ERROR: ${missingDays.length}/${allDays.length} day archives unreachable; a "0 matched" result would be meaningless.`);
    process.exit(2);
  }

  const candidates = new Map(); // file -> Set(paths)
  for (const t of targets) candidates.set(t.file, new Set(windowDays(t.data.publishDate).flatMap(d => dayLinks[d])));
  const pages = new Map();
  const allPaths = [...new Set([...candidates.values()].flatMap(s => [...s]))];
  await pool(allPaths, async p => {
    const html = await get(DM + p);
    if (html) pages.set(p, L.extractArticle(html));
  });
  console.log(`${pages.size}/${allPaths.length} candidate article(s) fetched`);

  const report = [];
  let written = 0;
  for (const t of targets) {
    let best = null;
    for (const p of candidates.get(t.file)) {
      const page = pages.get(p);
      if (!page || !page.paras.length) continue;
      const m = L.matchReview(t.data.fullText, page.paras);
      if (m.overlap >= L.MIN_OVERLAP && (!best || m.overlap > best.overlap)) best = { ...m, path: p, page };
    }
    if (!best) continue;
    const placement = L.classifyPlacement(best.page.paras, best.firstMatch, best.page.title, t.data.showTitle);
    const sectionRating = L.parseSectionRating(best.page.paras, best.firstMatch);
    const url = DM + best.path;
    const excluded = !!(t.data.wrongShow || t.data.wrongProduction || t.data.duplicateOf);
    const entry = {
      file: t.file,
      showId: t.data.showId,
      showTitle: t.data.showTitle,
      critic: t.data.criticName,
      outlet: t.data.outlet,
      theatreRecordDate: t.data.publishDate,
      url,
      pageTitle: best.page.title,
      pageByline: best.page.author,
      pagePublished: best.page.datePublished,
      textOverlap: Number(best.overlap.toFixed(2)),
      placement,
      sectionRating: sectionRating ? `${sectionRating.stars}/5 stars` : null,
      sectionRatingLine: sectionRating ? sectionRating.line : null,
      writeUrl: !excluded && L.shouldWriteUrl({ overlap: best.overlap, placement, sectionRating }),
      skipReason: excluded ? 'file flagged wrongShow/wrongProduction/duplicateOf'
        : (!L.shouldWriteUrl({ overlap: best.overlap, placement, sectionRating }) ? 'bundled secondary review with no parseable section rating; page-level star extraction would read the lead show' : null),
    };
    report.push(entry);
    const tag = entry.writeUrl ? 'WRITE' : 'skip ';
    console.log(`${tag} ${entry.textOverlap.toFixed(2)} ${placement.padEnd(9)} ${(entry.sectionRating || '-').padEnd(9)} ${t.file}\n        ${url}`);

    if (APPLY && entry.writeUrl) {
      const update = {
        url,
        urlDiscoveredBy: 'dailymail-url-discovery',
        urlDiscoveredAt: new Date().toISOString(),
        urlMatchOverlap: entry.textOverlap,
        dailymailPlacement: placement,
      };
      if (sectionRating && !t.data.originalScore) {
        Object.assign(update, {
          originalScore: `${sectionRating.stars}/5 stars`,
          originalScoreNormalized: Math.round((sectionRating.stars / 5) * 100),
          originalScoreSource: 'explicit-rating',
          scoreExtractedFrom: 'scraped-html',
          scoreRecoveredAt: new Date().toISOString(),
        });
      }
      safeWriteReview(t.filePath, { ...t.data, ...update });
      written++;
    }
  }
  console.log(`\n${report.length} matched, ${report.filter(r => r.writeUrl).length} writable${APPLY ? `, ${written} written` : ' (dry run; --apply to write)'}`);
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), searched: targets.length, matches: report }, null, 2) + '\n');
    console.log(`report → ${OUT}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
