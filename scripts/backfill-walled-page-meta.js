#!/usr/bin/env node
/**
 * backfill-walled-page-meta.js — salvage date / critic / standfirst for The
 * Stage review stubs whose pages are registration-walled.
 *
 * The collector records a walled page as garbage and saves nothing, so these
 * reviews went live as a bare star rating: no date, "Unknown" critic, no
 * quote (reader report 2026-09-26). collect-review-texts now salvages the
 * metadata inline (lib/walled-page-meta.js); this script repairs files that
 * were collected before that fix.
 *
 * Candidates: thestage URL, no fullText, not flagged wrongShow/
 * wrongProduction/duplicateOf, and missing at least one of publishDate, a
 * named critic, or outletStandfirst. Gap-fill only (applyWalledPageMeta never
 * overwrites). Pages go through fetchPage() per the scraping rule.
 *
 * Usage:
 *   node scripts/backfill-walled-page-meta.js [--show=ID] [--limit=N] [--dry-run] [--delay-ms=3000]
 *     [--html-cache=DIR] [--list-urls]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-walled-page-meta.js — salvage date/critic/standfirst for walled The Stage stubs.

Usage:
  node scripts/backfill-walled-page-meta.js [--show=ID] [--limit=N] [--dry-run] [--delay-ms=3000]
  node scripts/backfill-walled-page-meta.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const showFilter = getArg('show');
const limit = Number(getArg('limit') || 200);
const delayMs = Number(getArg('delay-ms') || 3000);
const dryRun = args.includes('--dry-run');
const reviewTextsDir = getArg('data-dir') || path.join(__dirname, '..', 'data', 'review-texts');
// --html-cache=DIR: read pages from DIR/<sha1(url)>.html when present (tests,
// or sessions where the scraper chain is unavailable); --list-urls prints
// "<sha1> <url>" for every candidate so a cache can be filled.
const htmlCacheDir = getArg('html-cache');
const listUrls = args.includes('--list-urls');
const cacheKey = (u) => require('crypto').createHash('sha1').update(String(u)).digest('hex');

const { isTheStageUrl, salvageWalledPageMetaToFile } = require('./lib/walled-page-meta');

function isCandidate(d) {
  if (!d || !isTheStageUrl(d.url)) return false;
  if (d.fullText) return false;
  if (d.wrongShow || d.wrongProduction || d.duplicateOf) return false;
  const critic = String(d.criticName || '').trim();
  const needsCritic = !critic || /^(unknown|the stage)$/i.test(critic);
  return !d.publishDate || needsCritic || !d.outletStandfirst;
}

function findCandidates() {
  const out = [];
  const dirs = showFilter ? [showFilter] : fs.readdirSync(reviewTextsDir)
    .filter((n) => !n.startsWith('_') && !n.startsWith('.') && n !== 'aggregator-archive');
  for (const dir of dirs) {
    const full = path.join(reviewTextsDir, dir);
    let files;
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.startsWith('thestage--') || !f.endsWith('.json')) continue;
      const fp = path.join(full, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (isCandidate(d)) out.push({ fp, d });
    }
  }
  return out;
}

async function main() {
  const candidates = findCandidates().slice(0, limit);
  if (listUrls) {
    for (const { d } of candidates) console.log(`${cacheKey(d.url)} ${d.url}`);
    return;
  }
  console.log(`${candidates.length} candidate The Stage stub(s)${dryRun ? ' (dry run)' : ''}`);
  if (!candidates.length) return;
  const { fetchPage } = require('./lib/scraper');
  const showsJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
  const showsById = Object.fromEntries((showsJson.shows || showsJson).map((s) => [s.id, s]));
  const suspects = [];
  let updated = 0, failed = 0;
  for (const [i, { fp, d }] of candidates.entries()) {
    const label = path.relative(reviewTextsDir, fp);
    let html = null;
    const cached = htmlCacheDir && path.join(htmlCacheDir, `${cacheKey(d.url)}.html`);
    if (cached && fs.existsSync(cached)) {
      html = fs.readFileSync(cached, 'utf8');
    } else {
      try {
        const r = await fetchPage(d.url, { renderJs: false });
        html = (r && (r.content || r.html)) || null;
      } catch (e) {
        console.log(`  ✗ ${label}: fetch failed (${String(e.message || e).slice(0, 80)})`);
      }
    }
    if (html) {
      const showTitle = (showsById[d.showId || path.basename(path.dirname(fp))] || {}).title;
      let fresh = null;
      const set = salvageWalledPageMetaToFile(fp, html, { showTitle, dryRun, onApplied: (x) => { fresh = x; } });
      const suspect = set.find((s) => s.endsWith('Suspect'));
      if (suspect) {
        console.log(`  ⚠ ${label}: ${suspect} ("${showTitle}") — not applied`);
        suspects.push(`${suspect} ${label} ${d.url}`);
        failed++;
      } else if (set.length) {
        console.log(`  ✓ ${label}: ${set.map((k) => `${k}=${JSON.stringify(fresh && fresh[k])}`).join(', ')}`);
        updated++;
      } else {
        console.log(`  · ${label}: no metadata found on page`);
        failed++;
      }
    } else {
      failed++;
    }
    if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log(`\nDone: ${updated} updated, ${failed} without metadata${dryRun ? ' (dry run, nothing written)' : ''}`);
  if (suspects.length) {
    console.log(`\n${suspects.length} suspect file(s) (another show, a round-up, or not a review):`);
    for (const s of suspects) console.log(`  ${s}`);
  }
  try { require('./lib/scraper').closeBrowser && await require('./lib/scraper').closeBrowser(); } catch { /* ignore */ }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
