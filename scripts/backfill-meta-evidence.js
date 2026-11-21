#!/usr/bin/env node
/**
 * backfill-meta-evidence.js (BRO-5794) — count a real review whose full text
 * can't be fetched, using the headline + standfirst the page publishes.
 *
 * Candidates are review-text files the rebuild drops ONLY for having no text
 * signal (review-guards verdict 'noTextOrScoreSignal': every wrong-show,
 * wrong-production, non-review, listing, roundup and date guard already
 * passed). Each page is fetched through fetchPage() and must itself pass the
 * review / right-show / in-window checks in lib/page-meta-evidence.js before
 * anything is written, so features, interviews, listings and wrong-production
 * pages stay out. Gap-fill only; the evidence lands in `metaExcerpt`.
 *
 * Usage:
 *   node scripts/backfill-meta-evidence.js [--show=ID] [--limit=N] [--dry-run]
 *     [--delay-ms=3000] [--recheck-days=14] [--time-budget-min=N]
 *     [--html-cache=DIR] [--list-urls]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `backfill-meta-evidence.js — page-metadata evidence for real reviews with no fetchable text.

Usage:
  node scripts/backfill-meta-evidence.js [--show=ID] [--limit=N] [--dry-run] [--delay-ms=3000]
  node scripts/backfill-meta-evidence.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

const args = process.argv.slice(2);
const getArg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const showFilter = getArg('show');
const limit = Number(getArg('limit') || 40);
const delayMs = Number(getArg('delay-ms') || 3000);
const recheckDays = Number(getArg('recheck-days') || 14);
const dryRun = args.includes('--dry-run');
const listUrls = args.includes('--list-urls');
const htmlCacheDir = getArg('html-cache');
const reviewTextsDir = getArg('data-dir') || path.join(__dirname, '..', 'data', 'review-texts');
const cacheKey = (u) => crypto.createHash('sha1').update(String(u)).digest('hex');

const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const budget = createRunBudget(parseTimeBudgetMin(args));
const { explainExclusion, isReviewWithinOwnProductionWindow } = require('./lib/review-guards');
const { isMetaEvidenceCandidate, extractPageMeta, evaluatePageMeta, applyMetaEvidence, RULES_VERSION, stampIsCurrent, missingHtmlStamp } = require('./lib/page-meta-evidence');
const { listShowDirs } = require('./lib/list-show-dirs');

const showsJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));
const showsById = Object.fromEntries((showsJson.shows || showsJson).map((s) => [s.id, s]));

function recentlyChecked(d) {
  const t = Date.parse(d.metaEvidenceCheckedAt || '');
  return !!(t && Date.now() - t < recheckDays * 86400000 && stampIsCurrent(d));
}

function findCandidates() {
  const out = [];
  const dirs = showFilter ? [showFilter] : listShowDirs(reviewTextsDir);
  for (const dir of dirs) {
    const show = showsById[dir];
    if (!show) continue;
    const full = path.join(reviewTextsDir, dir);
    let files;
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(full, f);
      let d;
      try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!d || typeof d !== 'object' || recentlyChecked(d)) continue;
      let verdict;
      try { verdict = explainExclusion(d, show, fp); } catch { continue; }
      if (isMetaEvidenceCandidate(d, verdict).ok) out.push({ fp, d, show });
    }
  }
  // Newest productions first so --limit is spent on shows that are live now.
  const recency = ({ show }) => String(show.openingDate || show.previewsStartDate || '');
  return out.sort((a, b) => recency(b).localeCompare(recency(a)));
}

function stampChecked(fp, url, reason) {
  const { safeWriteReview } = require('./lib/review-write-guard');
  const { normalizeUrl } = require('./lib/review-normalization');
  const cur = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (normalizeUrl(cur.url || '') !== normalizeUrl(url || '')) return;
  cur.metaEvidenceCheckedAt = new Date().toISOString();
  cur.metaEvidenceCheckResult = reason;
  cur.metaEvidenceRulesVersion = RULES_VERSION;
  safeWriteReview(fp, cur);
}

async function main() {
  const candidates = findCandidates().slice(0, limit);
  if (listUrls) {
    for (const { d } of candidates) console.log(`${cacheKey(d.url)} ${d.url}`);
    return;
  }
  console.log(`${candidates.length} candidate stub(s)${dryRun ? ' (dry run)' : ''}`);
  if (!candidates.length) return;
  const { fetchPage } = require('./lib/scraper');
  const { safeWriteReview } = require('./lib/review-write-guard');
  let updated = 0, rejected = 0, unreachable = 0;
  for (const [i, { fp, d, show }] of candidates.entries()) {
    if (budget.exceeded()) { console.log(`  time budget reached, ${candidates.length - i} left for the next run`); break; }
    const label = path.relative(reviewTextsDir, fp);
    let html = null;
    let fetchThrew = false;
    const cached = htmlCacheDir && path.join(htmlCacheDir, `${cacheKey(d.url)}.html`);
    const fromCache = !!(cached && fs.existsSync(cached));
    if (fromCache) html = fs.readFileSync(cached, 'utf8');
    else {
      try {
        const r = await fetchPage(d.url, { renderJs: false });
        html = (r && (r.content || r.html)) || null;
      } catch (e) { fetchThrew = true; console.log(`  x ${label}: fetch failed (${String(e.message || e).slice(0, 80)})`); }
    }
    if (!html) {
      unreachable++;
      // Stamp so a permanently walled URL doesn't take a slot in every weekly run.
      // A throw ("all scraping methods failed": walled pages, the target population) is stamped too,
      // else the newest-first sort re-spends the whole paid fetch chain on the same URLs every week.
      if (!dryRun && !fromCache) { try { stampChecked(fp, d.url, missingHtmlStamp(fetchThrew)); } catch { /* best effort */ } }
      continue;
    }
    const evidence = evaluatePageMeta({
      data: d, show, meta: extractPageMeta(html),
      inWindow: (s, date) => isReviewWithinOwnProductionWindow(s, date),
    });
    if (!evidence.ok) {
      console.log(`  - ${label}: rejected (${evidence.reason})`);
      rejected++;
      if (!dryRun && !fromCache) { try { stampChecked(fp, d.url, evidence.reason); } catch { /* attempt stamp is best effort */ } }
    } else {
      const fresh = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const { normalizeUrl } = require('./lib/review-normalization');
      if (normalizeUrl(fresh.url || '') !== normalizeUrl(d.url || '') || fresh.metaExcerpt || (fresh.fullText && String(fresh.fullText).trim())) {
        console.log(`  - ${label}: changed since scan, skipped`);
        continue;
      }
      const set = applyMetaEvidence(fresh, evidence);
      console.log(`  + ${label}: ${set.join(', ')} | ${evidence.excerpt.slice(0, 110)}`);
      if (!dryRun) safeWriteReview(fp, fresh);
      updated++;
    }
    if (i < candidates.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log(`\nDone: ${updated} updated, ${rejected} rejected, ${unreachable} unreachable${dryRun ? ' (dry run, nothing written)' : ''}`);
  try { const s = require('./lib/scraper'); if (s.closeBrowser) await s.closeBrowser(); } catch { /* ignore */ }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
