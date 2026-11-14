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
 * Candidates: thestage URL, not flagged wrongShow/wrongProduction/
 * duplicateOf, and either (no fullText and missing at least one of
 * publishDate, a named critic, outletStandfirst, or a star rating) or
 * (fullText but no publishDate: date only, BRO-4428). Gap-fill only
 * (applyWalledPageMeta never overwrites). Pages go through fetchPage() per
 * the scraping rule.
 *
 * Usage:
 *   node scripts/backfill-walled-page-meta.js [--show=ID] [--limit=N] [--dry-run] [--delay-ms=3000] [--recheck-days=14] [--time-budget-min=N]
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
const RECHECK_DAYS = Number(getArg('recheck-days') || 14);
// Wall-clock budget so a scheduled run exits cleanly before its step
// timeout instead of being killed mid-write (scripts/lib/run-budget.js).
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const budget = createRunBudget(parseTimeBudgetMin(args));

// Stamp an attempt on the file (url unchanged since the candidate scan).
function stampChecked(fp, url) {
  const { safeWriteReview } = require('./lib/review-write-guard');
  const { normalizeUrl } = require('./lib/review-normalization');
  const cur = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (normalizeUrl(cur.url || '') !== normalizeUrl(url || '')) return;
  cur.walledPageMetaCheckedAt = new Date().toISOString();
  safeWriteReview(fp, cur);
}

function isCandidate(d) {
  if (!d || !isTheStageUrl(d.url)) return false;
  if (d.wrongShow || d.wrongProduction || d.duplicateOf) return false;
  // Full-text reviews are live already; the page only adds a missing date
  // (reader report 2026-09-25: Stage reviews showing no date). Their score
  // stays with the full-text scoring (applyWalledPageMeta skips fullText).
  if (d.fullText) {
    if (d.publishDate) return false;
    const checkedFt = Date.parse(d.walledPageMetaCheckedAt || '');
    return !(checkedFt && Date.now() - checkedFt < RECHECK_DAYS * 86400000);
  }
  const critic = String(d.criticName || '').trim();
  const needsCritic = !critic || /^(unknown|the stage)$/i.test(critic);
  // Files already scoring from aggregator stars keep that score (the rebuild
  // skips an originalScore next to an aggregator scoreSource anyway).
  const needsScore = !d.originalScore && d.originalScoreNormalized == null && d.originalScoreCleared !== true
    && d.aggregatorStars == null && d.aggregatorStarsNormalized == null;
  if (!(!d.publishDate || needsCritic || !d.outletStandfirst || needsScore)) return false;
  // Every attempt is stamped (below), so a page that yields nothing new is
  // re-fetched every RECHECK_DAYS, not on every scheduled run.
  const checked = Date.parse(d.walledPageMetaCheckedAt || '');
  return !(checked && Date.now() - checked < RECHECK_DAYS * 86400000);
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
  // Newest productions first: --limit used to be spent in directory order,
  // so 2018 Broadway files took the slots while open West End shows later
  // in the alphabet (Thelma & Louise, The Standard of Living) waited a cycle.
  let showsById = {};
  try {
    const sj = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
    showsById = Object.fromEntries((sj.shows || sj).map((s) => [s.id, s]));
  } catch { /* no shows.json: keep directory order */ }
  const recency = ({ fp }) => {
    const s = showsById[path.basename(path.dirname(fp))] || {};
    return String(s.openingDate || s.previewsStartDate || s.closingDate || '');
  };
  return out.sort((a, b) => recency(b).localeCompare(recency(a)));
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
    if (budget.exceeded()) {
      console.log(`  ⏱ time budget reached — ${candidates.length - i} candidate(s) left for the next run`);
      break;
    }
    const label = path.relative(reviewTextsDir, fp);
    let html = null;
    const cached = htmlCacheDir && path.join(htmlCacheDir, `${cacheKey(d.url)}.html`);
    const fromCache = !!(cached && fs.existsSync(cached));
    if (fromCache) {
      html = fs.readFileSync(cached, 'utf8');
    } else {
      try {
        const r = await fetchPage(d.url, { renderJs: false });
        html = (r && (r.content || r.html)) || null;
      } catch (e) {
        console.log(`  ✗ ${label}: fetch failed (${String(e.message || e).slice(0, 80)})`);
      }
    }
    // The directory is authoritative: a moved file can carry a stale showId.
    const show = showsById[path.basename(path.dirname(fp))] || showsById[d.showId];
    if (html) {
      const showTitle = (show || {}).title;
      let fresh = null;
      let set;
      try {
        set = salvageWalledPageMetaToFile(fp, html, { showTitle, show, dryRun, onApplied: (x) => { fresh = x; } });
      } catch (e) {
        // One file edited or corrupted mid-run must not abort the rest.
        console.log(`  ✗ ${label}: salvage failed (${String(e.message || e).slice(0, 80)})`);
        set = null;
      }
      const suspect = set && set.find((s) => s.endsWith('Suspect'));
      if (!set) {
        failed++;
      } else if (suspect) {
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
    // Stamp only a page that actually loaded: an outage or exhausted scraper
    // credits must not park every candidate for RECHECK_DAYS.
    if (!dryRun && !fromCache && html) {
      try { stampChecked(fp, d.url); } catch (e) { console.log(`  ⚠ ${label}: attempt stamp failed (${String(e.message || e).slice(0, 80)})`); }
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
