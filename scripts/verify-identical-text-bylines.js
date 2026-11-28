#!/usr/bin/env node
/**
 * verify-identical-text-bylines.js — evidence for BRO-5321 (read-only).
 *
 * For each group from audit-identical-text-across-critics.js (one text stored
 * under 2+ critics on a show), fetch every distinct url the copies hold (live,
 * then the closest Wayback snapshot, then the paid fetchPage() chain with
 * --scrape) and print one JSON line per group: the copies' metadata, and per
 * url the page's author signals and the share of the stored text found on the
 * page. Never prints review text, so it is safe to run through
 * cloud-run-script.js --review-texts (CI logs are public).
 *
 * Usage:
 *   node scripts/verify-identical-text-bylines.js [--shard=i/n] [--show=a,b] [--scrape]
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help');
const { identicalTextGroups, loadRows } = require('./audit-identical-text-across-critics');
const { isExcludedRow } = require('./lib/variety-promo-bleed');
const { extractAuthorSignals, waybackTimestamp } = require('./lib/byline-evidence');
const { textOverlap, canonUrl, structuredAuthors } = require('./lib/identical-text-verdict');
const { get, wayback } = require('./check-byline-evidence');

const USAGE = 'Usage: node scripts/verify-identical-text-bylines.js [--shard=i/n] [--show=a,b] [--scrape]';
const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

// A scraper call that never settles leaves nothing on the event loop, so Node
// exits 0 mid-run and the output just stops (BRO-5321: 3 of 4 cloud batches
// ended at 8-63 of ~100 groups). The ref'd timer keeps the process alive and
// turns the hang into the best partial evidence. Only the paid fetch is
// bounded: get() and wayback() settle on their own socket timeouts, and their
// results are kept when the fetch times out.
const { withDeadline } = require('./lib/cron-deadline');
const envDeadline = Number(process.env.VERIFY_FETCH_DEADLINE_MS);
const FETCH_DEADLINE_MS = Number.isFinite(envDeadline) && envDeadline >= 1000 ? envDeadline : 120000;
let fetchTimeouts = 0;

/** Fetch candidates in order; stop at the first that names an author and carries the text. */
async function evidence(url, text, scrape) {
  const tried = [];
  const consider = (via, body, snapshot) => {
    if (!body || body.length < 2000) return null;
    const authors = extractAuthorSignals(body);
    const r = { url, via, snapshot: snapshot || null, authors, overlap: textOverlap(text, body) };
    tried.push(r);
    return structuredAuthors(authors).length && r.overlap !== null && r.overlap >= 0.6 ? r : null;
  };
  const live = await get(url);
  let ok = live.status === 200 ? consider('live', live.body) : null;
  if (!ok) {
    const wb = await wayback(url, waybackTimestamp(url));
    if (wb) ok = consider('wayback', wb.body, wb.snapshot);
  }
  if (!ok && scrape && !tried.some((t) => structuredAuthors(t.authors).length)) {
    const { fetchPage, cleanup } = require('./lib/scraper.js');
    try {
      const r = await withDeadline(() => fetchPage(url), FETCH_DEADLINE_MS, url);
      const body = (r && (r.content || r.html || r.text)) || '';
      ok = consider(`fetchPage:${r && r.source ? r.source : '?'}`, body);
    } catch (e) {
      // A timed-out fetch keeps running; reset the shared browser so the next
      // url does not share a page with it. Otherwise falls through to the best
      // partial below.
      if (/wall-clock timeout/.test(String(e && e.message))) {
        fetchTimeouts++;
        if (typeof cleanup === 'function') await cleanup().catch(() => {});
      }
    }
  }
  if (ok) return ok;
  // Best partial: most text overlap, then any structured author.
  tried.sort((a, b) => (b.overlap || 0) - (a.overlap || 0) || structuredAuthors(b.authors).length - structuredAuthors(a.authors).length);
  return tried[0] || { url, via: 'none', snapshot: null, authors: [], overlap: null, statusLive: live.status };
}

async function main() {
  if (hasHelpFlag(process.argv)) { console.log(USAGE); return 0; }
  const shows = arg('show');
  const shard = arg('shard');
  const [si, sn] = shard ? shard.split('/').map(Number) : [0, 1];
  const scrape = process.argv.includes('--scrape');
  const groups = identicalTextGroups(loadRows(shows ? new Set(shows.split(',')) : null))
    .sort((a, b) => a[0].rel.localeCompare(b[0].rel))
    .filter((_, i) => i % sn === si);
  console.error(`[verify-identical] ${groups.length} groups (shard ${si}/${sn})`);
  let done = 0;
  for (const g of groups) {
    const text = g[0].d.fullText;
    const byCanon = new Map();
    for (const m of g) if (m.d.url && !byCanon.has(canonUrl(m.d.url))) byCanon.set(canonUrl(m.d.url), m.d.url);
    const pages = [];
    for (const url of byCanon.values()) {
      try { pages.push(await evidence(url, text, scrape)); } catch (e) { pages.push({ url, via: 'error', authors: [], overlap: null, error: String(e.message || e).slice(0, 80) }); }
      await new Promise((r) => setTimeout(r, 1200));
    }
    console.log(JSON.stringify({
      showId: g[0].showId,
      members: g.map((m) => ({ file: m.file, critic: m.d.criticName || null, url: m.d.url || null, excluded: isExcludedRow(m.d) })),
      pages,
    }));
    if (++done % 25 === 0) console.error(`[verify-identical] ${done}/${groups.length}`);
  }
  console.error(`[verify-identical] done ${done}/${groups.length} (${fetchTimeouts} paid fetches timed out)`);
  return 0;
}

if (require.main === module) {
  // Belt and braces for the hang above: a drained event loop before main()
  // settles is an incomplete run, never a success.
  let settled = false;
  process.on('beforeExit', () => {
    if (!settled) { console.error('[verify-identical] event loop drained before the run finished; output is incomplete'); process.exit(1); }
  });
  const { runMain } = require('./lib/run-main');
  // Teardown closes the scraper's browser and prints its cost summary.
  const scraperCleanup = () => {
    const mod = require.cache[require.resolve('./lib/scraper.js')];
    return mod && typeof mod.exports.cleanup === 'function' ? mod.exports.cleanup() : undefined;
  };
  runMain(() => main().finally(() => { settled = true; }), { teardown: [scraperCleanup] });
}
