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
 *   node scripts/discover-dailymail-urls.js --from-report=r.json [--apply]   apply a saved report, no fetching
 *   node scripts/discover-dailymail-urls.js --cache-dir=/tmp/dm  reuse fetched archives/articles across runs
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

const USAGE = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 18).map(l => l.replace(/^ \* ?/, '')).join('\n');
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts');
const DM = 'https://www.dailymail.co.uk';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
// Mail on Sunday critics (Gore-Langton, Brown) live under their own outlet since BRO-5373.
const OUTLET_PREFIX = /^(daily-mail|mail-on-sunday)--/;
const criticKey = file => file.replace(/\/(daily-mail|mail-on-sunday)--/, '/');
const DAYS_BEFORE = 4; // DM often runs the review the night of press night, before TR's date
const DAYS_AFTER = 3;
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const arg = name => (args.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=') || null;
const APPLY = args.includes('--apply');
const ALL_MARKETS = args.includes('--all-markets');
const ONLY_SHOW = arg('show');
const OUT = arg('out');
// --cache-dir=D keeps day archives (D/arc/YYYYMMDD.html) and parsed articles
// (D/pages/article-N.json) between runs, so a re-run after DM throttles the IP
// only fetches what is new.
const CACHE = arg('cache-dir');

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
  for (const showId of listShowDirs(REVIEW_TEXTS_DIR, { silent: true, skipHolding: true })) {
    if (ONLY_SHOW && showId !== ONLY_SHOW) continue;
    if (!ONLY_SHOW && !ALL_MARKETS && !/west-end|london/.test(showId)) continue;
    const dir = path.join(REVIEW_TEXTS_DIR, showId);
    for (const f of fs.readdirSync(dir)) {
      if (!OUTLET_PREFIX.test(f) || !f.endsWith('.json')) continue;
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

/** Write a matched URL (and the section's own star rating, if parsed) to the review file. */
function applyEntry(t, entry) {
  // Re-read: a long run can outlive CI/other sessions flagging the file or
  // filling its URL, and writing the stale snapshot back would undo that.
  let fresh;
  try { fresh = JSON.parse(fs.readFileSync(t.filePath, 'utf8')); } catch { return false; }
  if (fresh.url || fresh.wrongShow || fresh.wrongProduction || fresh.duplicateOf) {
    console.log(`skip  ${t.file} (changed on disk since it was read)`);
    return false;
  }
  t = { ...t, data: fresh };
  const update = {
    url: entry.url,
    urlDiscoveredBy: 'dailymail-url-discovery',
    urlDiscoveredAt: new Date().toISOString(),
    urlMatchOverlap: entry.textOverlap,
    dailymailPlacement: entry.placement,
  };
  const stars = entry.sectionRating ? Number(entry.sectionRating[0]) : null;
  if (stars && !t.data.originalScore) {
    // Written as originalScore so recollect-for-scores leaves it alone: on a
    // bundled page its page-level extractor would read the lead show's stars.
    Object.assign(update, {
      originalScore: `${stars}/5 stars`,
      originalScoreNormalized: Math.round((stars / 5) * 100),
      originalScoreSource: 'explicit-rating',
      scoreExtractedFrom: 'scraped-html',
      scoreRecoveredAt: new Date().toISOString(),
    });
  }
  safeWriteReview(t.filePath, { ...t.data, ...update });
  return true;
}

/** --from-report: apply a reviewed dry-run report without fetching anything again. */
function applyFromReport(reportPath) {
  const { matches } = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  // Keyed by show + critic, not file name: an outlet rename (daily-mail-- →
  // mail-on-sunday--) between the report and the apply must not lose the match.
  const targets = loadTargets();
  const exact = new Map(targets.map(t => [t.file, t]));
  const byCritic = new Map();
  for (const t of targets) {
    const k = criticKey(t.file);
    byCritic.set(k, byCritic.has(k) ? null : t); // null = ambiguous (both outlet prefixes present)
  }
  resolveSameShowCollisions(matches); // URLs may have landed on sibling files since the report
  let written = 0;
  for (const entry of matches) {
    if (!entry.writeUrl) continue;
    const t = exact.get(entry.file) || byCritic.get(criticKey(entry.file));
    if (!t) { console.log(`skip  ${entry.file} (now has a URL, or no longer a target)`); continue; }
    if (t.data.wrongShow || t.data.wrongProduction || t.data.duplicateOf) { console.log(`skip  ${entry.file} (flagged since the report)`); continue; }
    if (APPLY && !applyEntry(t, entry)) continue;
    if (APPLY) written++;
    console.log(`${APPLY ? 'WROTE' : 'would write'} ${t.file} → ${entry.url}${entry.sectionRating ? ` (${entry.sectionRating})` : ''}`);
  }
  console.log(`\n${written} written${APPLY ? '' : ' (dry run; --apply to write)'}`);
}

/**
 * Two files of the SAME show must not get the same URL: the write guard marks
 * the second as a url-collision duplicate and it drops out of scoring. When
 * two critics' sections share a page (or a sibling file already holds the
 * URL), only the earliest section on the page keeps writeUrl.
 */
function resolveSameShowCollisions(report) {
  const existing = new Map(); // showId -> Set(url) already on disk
  const urlsFor = showId => {
    if (!existing.has(showId)) {
      const set = new Set();
      const dir = path.join(REVIEW_TEXTS_DIR, showId);
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!f.endsWith('.json')) continue;
        try { const u = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).url; if (u) set.add(u.replace(/[?#].*$/, '')); } catch { /* skip */ }
      }
      existing.set(showId, set);
    }
    return existing.get(showId);
  };
  const groups = new Map();
  for (const e of report.filter(r => r.writeUrl)) {
    if (urlsFor(e.showId).has(e.url)) { e.writeUrl = false; e.skipReason = 'another file of this show already has this URL'; continue; }
    const k = `${e.showId}|${e.url}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((x, y) => x.firstMatchParagraph - y.firstMatchParagraph);
    for (const e of g.slice(1)) { e.writeUrl = false; e.skipReason = `shares the page with ${g[0].critic}'s review of the same show (write guard would mark it duplicate)`; }
  }
}

async function main() {
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  if (arg('from-report')) return applyFromReport(arg('from-report'));
  const targets = loadTargets();
  console.log(`${targets.length} URL-less Daily Mail review file(s) with text`);
  if (!targets.length) return;

  const allDays = [...new Set(targets.flatMap(t => windowDays(t.data.publishDate)))];
  const dayLinks = {};
  await pool(allDays, async d => {
    const cached = CACHE && path.join(CACHE, 'arc', `${d}.html`);
    let html = cached && fs.existsSync(cached) && fs.statSync(cached).size > 20000 ? fs.readFileSync(cached, 'utf8') : null;
    if (!html) {
      html = await get(`${DM}/home/sitemaparchive/day_${d}.html`);
      if (html && cached && L.parseDayArchive(html).length) { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, html); }
    }
    dayLinks[d] = html ? L.parseDayArchive(html).filter(L.isCandidatePath) : [];
  });
  const missingDays = allDays.filter(d => !dayLinks[d].length);
  console.log(`${allDays.length} day archive(s) read${missingDays.length ? `, ${missingDays.length} empty/unreachable` : ''}`);
  if (missingDays.length > allDays.length / 2) {
    console.error(`ERROR: ${missingDays.length}/${allDays.length} day archives unreachable; a "0 matched" result would be meaningless.`);
    process.exit(2);
  }

  // Stream: score each article against the reviews whose date window holds it
  // as soon as it arrives, keep only the best match per review. Holding every
  // article in memory OOMs on a full West End run (~4K pages).
  const byPath = new Map(); // path -> targets
  for (const t of targets) {
    for (const p of new Set(windowDays(t.data.publishDate).flatMap(d => dayLinks[d]))) {
      if (!byPath.has(p)) byPath.set(p, []);
      byPath.get(p).push(t);
    }
  }
  const bestByFile = new Map();
  let fetched = 0;
  const score = (p, page) => {
    if (!page.paras.length) return;
    for (const t of byPath.get(p)) {
      const m = L.matchReview(t.data.fullText, page.paras);
      const cur = bestByFile.get(t.file);
      if (m.overlap >= L.MIN_OVERLAP && (!cur || m.overlap > cur.overlap)) bestByFile.set(t.file, { ...m, path: p, page });
    }
  };
  await pool([...byPath.keys()], async p => {
    const id = (p.match(/article-\d+/) || [])[0];
    const cached = CACHE && id && path.join(CACHE, 'pages', `${id}.json`);
    if (cached && fs.existsSync(cached)) {
      try {
        const c = JSON.parse(fs.readFileSync(cached, 'utf8'));
        if (c.paras && c.paras.length) { fetched++; score(p, { ...c, author: c.author || c.auth || null }); return; }
      } catch { /* refetch */ }
    }
    const html = await get(DM + p);
    if (!html) return;
    const page = L.extractArticle(html);
    fetched++;
    if (cached && page.paras.length) { fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, JSON.stringify(page)); }
    score(p, page);
  });
  console.log(`${fetched}/${byPath.size} candidate article(s) read`);

  const report = [];
  let written = 0;
  for (const t of targets) {
    const best = bestByFile.get(t.file);
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
      firstMatchParagraph: best.firstMatch,
      placement,
      sectionRating: sectionRating ? `${sectionRating.stars}/5 stars` : null,
      sectionRatingLine: sectionRating ? sectionRating.line : null,
      writeUrl: !excluded && L.shouldWriteUrl({ overlap: best.overlap, placement, sectionRating }),
      skipReason: excluded ? 'file flagged wrongShow/wrongProduction/duplicateOf'
        : (!L.shouldWriteUrl({ overlap: best.overlap, placement, sectionRating }) ? 'bundled secondary review with no parseable section rating; page-level star extraction would read the lead show' : null),
    };
    report.push(entry);
    entry._t = t;
  }
  resolveSameShowCollisions(report);
  for (const entry of report) {
    const t = entry._t;
    delete entry._t;
    const tag = entry.writeUrl ? 'WRITE' : 'skip ';
    console.log(`${tag} ${entry.textOverlap.toFixed(2)} ${entry.placement.padEnd(9)} ${(entry.sectionRating || '-').padEnd(9)} ${t.file}\n        ${entry.url}`);
    if (APPLY && entry.writeUrl && applyEntry(t, entry)) written++;
  }
  console.log(`\n${report.length} matched, ${report.filter(r => r.writeUrl).length} writable${APPLY ? `, ${written} written` : ' (dry run; --apply to write)'}`);
  if (OUT) {
    fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), searched: targets.length, matches: report }, null, 2) + '\n');
    console.log(`report → ${OUT}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
