#!/usr/bin/env node
/**
 * One-shot migration: bulk-ingest-historical-recoveries-2026-05
 *
 * Sprint S2-T3. Reads candidate URLs from S2-T2's per-critic historical audit
 * (data/audit/critic-coverage-audit-historical.json) and bulk-ingests
 * qualifying review-text STUBS into data/review-texts/{showSlug}/.
 *
 * The stubs created here are "skeleton" review files — they have a URL,
 * outlet, critic, and inferred publishDate, but fullText is empty. The
 * downstream `collect-review-texts.yml` workflow fills in the body text on
 * its next run, which the rebuild pipeline then scores. This mirrors the
 * S2 sprint plan: T2 surfaces candidates, T3 stages them as ingestable
 * stubs, the existing collect → rebuild → score chain finishes the work.
 *
 * Confidence rule (a candidate qualifies if ALL hold):
 *   1. URL contains the show slug (loose substring sanity check)
 *   2. URL's embedded year matches the show's openingDate year ±1, AND
 *      the URL-derived publishDate falls within (opening - 60d, opening + 30d).
 *   3. Magnitude cap on date shift: if a "current best-known same-show review"
 *      exists in reviews.json, |this.publishDate - that.publishDate| must
 *      be < 180 days. Catches "music-city-2026 wrong production" — different
 *      productions of the same title same year, opening 200+ days apart.
 *
 * Pre-ingest file list capture:
 *   Before any writes, the planned-write list is dumped to
 *   data/audit/bulk-ingest-historical-2026-05-staged-files.txt — one
 *   absolute path per line. Rollback recipe printed at end of dry-run.
 *
 * Usage:
 *   # Default DRY-RUN — prints what would ingest, top 25, rollback recipe.
 *   node scripts/migrations/bulk-ingest-historical-recoveries-2026-05.js
 *
 *   # Apply (NOT to be used in this session).
 *   node scripts/migrations/bulk-ingest-historical-recoveries-2026-05.js \
 *     --apply --confirm-count=N
 *
 *   # Synthetic magnitude-cap regression test.
 *   node scripts/migrations/bulk-ingest-historical-recoveries-2026-05.js \
 *     --test-magnitude-cap
 *
 * Run from main repo root (/Users/tompryor/Broadwayscore) so that
 * data/shows.json + data/reviews.json + data/review-texts/ resolve from cwd.
 * The audit JSON lives in the S2 worktree and is resolved relative to
 * __dirname so the script finds it regardless of cwd.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const CWD = process.cwd();
const AUDIT_FILENAME = 'critic-coverage-audit-historical.json';
const STAGED_FILES_LIST = 'bulk-ingest-historical-2026-05-staged-files.txt';

// Date window: pre-opening previews + early post-opening reviews.
const PRE_OPENING_DAYS = 60;
const POST_OPENING_DAYS = 30;

// Magnitude cap on date shift between this candidate and an existing
// same-show review. Catches same-year cross-production false matches.
const MAGNITUDE_CAP_DAYS = 180;

// Top-N preview before --apply.
const TOP_N = 25;

// Outlet ID inference from URL hostname. Mirrors urlOutletId() in
// scripts/audit-critic-coverage-bucket.js — kept simple here since the
// S2-T2 audit candidates skew to a small US-outlet set.
const HOST_TO_OUTLET = {
  'variety.com': 'variety',
  'newsday.com': 'newsday',
  'nytimes.com': 'nytimes',
  'wsj.com': 'wsj',
  'talkinbroadway.com': 'talkinbroadway',
  'washingtonpost.com': 'washpost',
  'vulture.com': 'vulture',
  'nymag.com': 'vulture',
  'newyorker.com': 'newyorker',
  'hollywoodreporter.com': 'hollywood-reporter',
  'deadline.com': 'deadline',
  'theatermania.com': 'theatermania',
  'nystagereview.com': 'nysr',
  'nypost.com': 'nypost',
  'amny.com': 'amny',
};

// Audit file lives in the S2 worktree. Resolve relative to __dirname so the
// script works regardless of cwd.
const AUDIT_PATH = path.resolve(__dirname, '..', '..', 'data', 'audit', AUDIT_FILENAME);

// ────────────────────────────────────────────────────────────────────────────
// Args
// ────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const TEST_MAGNITUDE_CAP = args.includes('--test-magnitude-cap');
const confirmArg = args.find((a) => a.startsWith('--confirm-count='));
const CONFIRM_COUNT = confirmArg ? Number(confirmArg.split('=')[1]) : null;

if (APPLY && (CONFIRM_COUNT === null || Number.isNaN(CONFIRM_COUNT))) {
  console.error('ERROR: --apply requires --confirm-count=N matching the prior dry-run "would-ingest" count.');
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

function urlHost(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function urlPath(u) {
  try {
    return new URL(u).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function inferOutletIdFromUrl(u) {
  const h = urlHost(u);
  if (!h) return null;
  for (const [d, id] of Object.entries(HOST_TO_OUTLET)) {
    if (h === d || h.endsWith('.' + d)) return id;
  }
  return null;
}

// Extract a publishDate hint from the URL path.
// Returns an object: { date: 'YYYY-MM-DD' | null, precision: 'day' | 'month' | 'year' }
// Variety-style URLs only carry a year segment (e.g., /2022/legit/reviews/...) —
// those resolve as { date: '2022-01-01', precision: 'year' } and Rule 2 then
// does a year-range check against the opening date instead of a strict
// day-window check. NYTimes-style /YYYY/MM/DD/ URLs return day precision.
function extractUrlPublishDateHint(u) {
  if (!u) return { date: null, precision: null };
  const p = urlPath(u);
  const ymd = p.match(/\/(20\d{2})\/(\d{2})\/(\d{2})\//);
  if (ymd) {
    return { date: `${ymd[1]}-${ymd[2]}-${ymd[3]}`, precision: 'day' };
  }
  const ym = p.match(/\/(20\d{2})\/(\d{2})\//);
  if (ym) {
    return { date: `${ym[1]}-${ym[2]}-01`, precision: 'month' };
  }
  const y = p.match(/\/(20\d{2})\//);
  if (y) {
    return { date: `${y[1]}-01-01`, precision: 'year' };
  }
  return { date: null, precision: null };
}

function dayDiff(a, b) {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return Infinity;
  return Math.round(Math.abs(da - db) / 86400000);
}

function dateInWindow(candidateDate, openingDate) {
  if (!candidateDate || !openingDate) return false;
  const cd = new Date(candidateDate + 'T00:00:00Z').getTime();
  const od = new Date(openingDate + 'T00:00:00Z').getTime();
  if (Number.isNaN(cd) || Number.isNaN(od)) return false;
  const deltaDays = (cd - od) / 86400000;
  return deltaDays >= -PRE_OPENING_DAYS && deltaDays <= POST_OPENING_DAYS;
}

// Year-precision Rule 2 check: when the URL only carries a year segment,
// the strict day-window check is meaningless. Instead, require that the
// URL year is the same as (or adjacent to) the show's opening year — which
// is the underlying intent of Rule 2 for year-only URLs. The (opening-60d,
// opening+30d) window can straddle a year boundary only when opening is
// within ~60d of Jan 1, so allowing ±1 year is the conservative read.
function yearInWindow(candidateYear, openingDate) {
  if (!candidateYear || !openingDate) return false;
  const oy = parseInt(openingDate.slice(0, 4), 10);
  if (!oy) return false;
  return Math.abs(candidateYear - oy) <= 1;
}

// Loose substring sanity check: at least one ≥4-char show slug token
// must appear in the URL path. Mirrors urlMatchesShowSlug() in
// scripts/audit-critic-coverage-bucket.js — kept independent so this
// migration has no cross-script dependency.
function urlContainsShowSlug(u, showId) {
  if (!showId) return false;
  const p = urlPath(u);
  const tokens = showId
    .toLowerCase()
    .split('-')
    .filter((t) => t.length >= 4 && !/^\d{4}$/.test(t));
  if (tokens.length === 0) return false;
  return tokens.some((t) => p.includes(t));
}

// Title → show resolution. Reuses the same normTitle/title-map approach as
// audit-critic-coverage-bucket.js. Kept inline so this script doesn't depend
// on that file's module surface (it currently doesn't export).
function normTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(the|a|an|review|broadway|off-broadway|theater|theatre|musical|play)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildTitleMap(showList) {
  const titleMap = new Map();
  for (const s of showList) {
    const cat = s.category || 'broadway';
    const k = normTitle(s.title);
    if (!k) continue;
    if (!titleMap.has(k)) titleMap.set(k, []);
    titleMap.get(k).push({
      id: s.id,
      title: s.title,
      category: cat,
      openingDate: s.openingDate,
    });
  }
  return titleMap;
}

function pickClosestByYear(matches, urlYearHint) {
  // Prefer Broadway/off-Broadway when URL is from a US outlet (default here).
  const broadway = matches.filter((s) => s.category === 'broadway');
  const offBwy = matches.filter((s) => s.category === 'off-broadway');
  let pool = [...broadway, ...offBwy];
  if (pool.length === 0) pool = matches;
  if (urlYearHint) {
    pool = pool.slice().sort((a, b) => {
      const ay = parseInt((a.openingDate || '').slice(0, 4) || '0', 10);
      const by = parseInt((b.openingDate || '').slice(0, 4) || '0', 10);
      return Math.abs(ay - urlYearHint) - Math.abs(by - urlYearHint);
    });
  } else {
    pool = pool.slice().sort((a, b) => (b.openingDate || '').localeCompare(a.openingDate || ''));
  }
  return pool[0] || null;
}

function matchTitleToShow(rawTitle, titleMap, urlYearHint) {
  let t = (rawTitle || '').replace(/[''""']/g, "'");
  let m = t.match(/^['"]?(.+?)['"]?\s+review/i);
  let candidate = m ? m[1] : t.split(/[—–:|,]/)[0];
  candidate = normTitle(candidate);
  if (!candidate) return null;
  let matches = titleMap.get(candidate);
  if (!matches) {
    for (const [k, v] of titleMap) {
      if (k.startsWith(candidate) && candidate.length >= 4) {
        matches = v;
        break;
      }
      if (candidate.startsWith(k) && k.length >= 4) {
        matches = v;
        break;
      }
    }
  }
  if (!matches) return null;
  return pickClosestByYear(matches, urlYearHint);
}

function extractUrlYear(u) {
  const m = (u || '').match(/\/(20\d{2})\//);
  return m ? parseInt(m[1], 10) : null;
}

// Critic-name → file slug. Mirrors normalizeCritic() in
// scripts/lib/review-normalization.js for the common case (lower + hyphen)
// — kept simple here to avoid pulling the full registry resolver.
function criticSlug(name) {
  if (!name) return 'unknown';
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['‘’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Find an existing same-show "best-known" review publishDate from reviews.json.
// Returns the earliest known publishDate or null.
function findExistingShowPublishDate(reviewsIndex, showId) {
  const rows = reviewsIndex.get(showId);
  if (!rows || rows.length === 0) return null;
  // Use the median publishDate as the reference. Median is more robust than
  // earliest (which may be a stray archival re-tag) for the cross-production
  // magnitude cap.
  const dates = rows.map((r) => r.publishDate).filter(Boolean).sort();
  if (dates.length === 0) return null;
  return dates[Math.floor(dates.length / 2)];
}

// ────────────────────────────────────────────────────────────────────────────
// Confidence-rule evaluator (the unit of work this script gates on)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate the three confidence rules. Returns an object describing the
 * outcome; callers route on `verdict`:
 *   'qualify'  → planned write
 *   'reject'   → either confidence-fail or magnitude-cap-fail; `reason` says which
 *   'skip'     → existing-file skip; not a rejection
 */
function evaluateCandidate({ url, title, show, publishDate, datePrecision, openingDate, existingShowDate }) {
  // Rule 1: URL contains show slug
  if (!urlContainsShowSlug(url, show.id)) {
    return { verdict: 'reject', class: 'confidence', reason: 'url-missing-show-slug' };
  }

  // Rule 2: publishDate within window
  if (!publishDate) {
    return { verdict: 'reject', class: 'confidence', reason: 'no-publish-date' };
  }
  if (!openingDate) {
    return { verdict: 'reject', class: 'confidence', reason: 'show-missing-opening-date' };
  }
  if (datePrecision === 'year') {
    // Year-only URL (e.g., variety.com/2022/legit/reviews/...) — check
    // URL year vs opening year rather than enforcing the strict day window.
    const candYear = parseInt(publishDate.slice(0, 4), 10);
    if (!yearInWindow(candYear, openingDate)) {
      return {
        verdict: 'reject',
        class: 'confidence',
        reason: `url-year ${candYear} > 1yr from opening ${openingDate}`,
      };
    }
  } else if (!dateInWindow(publishDate, openingDate)) {
    return {
      verdict: 'reject',
      class: 'confidence',
      reason: `out-of-window (publish=${publishDate}, opening=${openingDate})`,
    };
  }

  // Rule 3: magnitude cap on date-shift vs existing same-show review.
  // For year-precision URLs, compare years instead of days to avoid spurious
  // shifts from the synthetic Jan-1 fallback.
  if (existingShowDate) {
    if (datePrecision === 'year') {
      const candYear = parseInt(publishDate.slice(0, 4), 10);
      const exYear = parseInt(existingShowDate.slice(0, 4), 10);
      // 180d cap → strict-day equivalent is a year mismatch of more than 0
      // (Math.abs >= 1 year ≈ 365d ≫ 180d). One-year difference would already
      // be ~365d shift, which exceeds the 180d cap.
      if (candYear && exYear && Math.abs(candYear - exYear) >= 1) {
        return {
          verdict: 'reject',
          class: 'magnitude',
          reason: `url-year ${candYear} vs existing-year ${exYear} >= 1yr shift (180d cap)`,
        };
      }
    } else {
      const shift = dayDiff(publishDate, existingShowDate);
      if (shift >= MAGNITUDE_CAP_DAYS) {
        return {
          verdict: 'reject',
          class: 'magnitude',
          reason: `shift ${shift}d >= ${MAGNITUDE_CAP_DAYS}d cap (existing=${existingShowDate}, this=${publishDate})`,
        };
      }
    }
  }

  return { verdict: 'qualify' };
}

// ────────────────────────────────────────────────────────────────────────────
// Synthetic magnitude-cap test (acceptance criterion #4)
// ────────────────────────────────────────────────────────────────────────────

function runMagnitudeCapTest() {
  // Synthetic fixture: a Variety URL for a hypothetical "music-city-revival-tour"
  // production claiming an October 2026 publish date, while the canonical
  // music-city-2026 Broadway production opened on April 1, 2026 with an existing
  // review dated April 5, 2026. Shift is ~193d → must reject via magnitude cap.
  const fixtureShow = {
    id: 'music-city-2026',
    title: 'Music City',
    openingDate: '2026-04-01',
    category: 'broadway',
  };
  const fixtureCandidate = {
    url: 'https://variety.com/2026/legit/reviews/music-city-revival-tour-review-1235999999/',
    title: '‘Music City’ Review: A Touring Revival',
    publishDate: '2026-10-15', // 197 days after opening — out of (opening-60, opening+30) window AND >180d from existing
  };
  const existingReviewDate = '2026-04-05'; // 4 days post-opening — believable canonical review

  const result = evaluateCandidate({
    url: fixtureCandidate.url,
    title: fixtureCandidate.title,
    show: fixtureShow,
    publishDate: fixtureCandidate.publishDate,
    datePrecision: 'day',
    openingDate: fixtureShow.openingDate,
    existingShowDate: existingReviewDate,
  });

  // Expect either out-of-window (Rule 2) OR magnitude-cap (Rule 3) — both are
  // valid rejection paths for a 200d cross-production shift. To prove the
  // cap itself works, re-run with a wider window (publishDate just outside
  // the window but well inside Rule 2 would mean Rule 2 caught it — we want
  // Rule 3 to fire).
  console.log('=== Synthetic magnitude-cap test ===');
  console.log('Fixture: show=' + fixtureShow.id + ' opening=' + fixtureShow.openingDate);
  console.log('         candidate publish=' + fixtureCandidate.publishDate + ' url=' + fixtureCandidate.url);
  console.log('         existing same-show review date=' + existingReviewDate);
  console.log('Result:  verdict=' + result.verdict + ' class=' + (result.class || '-') + ' reason=' + (result.reason || '-'));

  if (result.verdict !== 'reject') {
    console.error('FAIL: expected reject, got ' + result.verdict);
    process.exit(2);
  }

  // Additionally: probe the magnitude rule in isolation by re-running with
  // a publishDate inside the date window but >180d from existing.
  const directProbe = evaluateCandidate({
    url: 'https://variety.com/2026/legit/reviews/music-city-revival-tour-review-1235999999/',
    title: 'probe',
    show: { id: 'music-city-2026', title: 'Music City', openingDate: '2026-04-01' },
    publishDate: '2026-04-10', // inside the (opening-60, opening+30) window
    datePrecision: 'day',
    openingDate: '2026-04-01',
    existingShowDate: '2025-09-01', // 221 days earlier
  });
  console.log('Direct probe (in-window, but 221d from existing):');
  console.log('         verdict=' + directProbe.verdict + ' class=' + (directProbe.class || '-') + ' reason=' + (directProbe.reason || '-'));
  if (directProbe.verdict !== 'reject' || directProbe.class !== 'magnitude') {
    console.error('FAIL: expected magnitude-class rejection, got ' + directProbe.verdict + '/' + directProbe.class);
    process.exit(2);
  }

  console.log('PASS: magnitude cap correctly rejects the music-city-revival-tour fixture.');
  process.exit(0);
}

if (TEST_MAGNITUDE_CAP) {
  runMagnitudeCapTest();
}

// ────────────────────────────────────────────────────────────────────────────
// Main: load inputs
// ────────────────────────────────────────────────────────────────────────────

const audit = readJson(AUDIT_PATH);
if (!audit || !Array.isArray(audit)) {
  console.error('ERROR: could not read audit JSON at ' + AUDIT_PATH);
  process.exit(1);
}

const showsJsonPath = path.resolve(CWD, 'data', 'shows.json');
const showsData = readJson(showsJsonPath);
if (!showsData) {
  console.error('ERROR: could not read shows.json at ' + showsJsonPath);
  console.error('Run this script from the main repo root (/Users/tompryor/Broadwayscore).');
  process.exit(1);
}
const showList = showsData.shows || showsData;
const showById = new Map(showList.map((s) => [s.id, s]));
const titleMap = buildTitleMap(showList);

const reviewsJsonPath = path.resolve(CWD, 'data', 'reviews.json');
const reviewsData = readJson(reviewsJsonPath);
const reviewsIndex = new Map(); // showId -> [{publishDate, ...}]
if (reviewsData && Array.isArray(reviewsData.reviews)) {
  for (const r of reviewsData.reviews) {
    if (!r.showId) continue;
    if (!reviewsIndex.has(r.showId)) reviewsIndex.set(r.showId, []);
    reviewsIndex.get(r.showId).push({ publishDate: r.publishDate, url: r.url });
  }
}

const reviewTextsRoot = path.resolve(CWD, 'data', 'review-texts');
const stagedListPath = path.resolve(CWD, 'data', 'audit', STAGED_FILES_LIST);

// ────────────────────────────────────────────────────────────────────────────
// Main: walk audit, evaluate, classify
// ────────────────────────────────────────────────────────────────────────────

let scanned = 0;
let existingSkip = 0;
let confidenceRejected = 0;
let magnitudeRejected = 0;
let outletInferFailed = 0;
let titleMatchFailed = 0;
const plannedWrites = []; // { filepath, candidate, show, payload }

for (const criticBlock of audit) {
  const criticName = (criticBlock.name || '').replace(/\.+$/, '').trim();
  const items = Array.isArray(criticBlock.missing) ? criticBlock.missing : [];
  for (const m of items) {
    scanned += 1;

    const url = m.url;
    const title = m.title || '';

    // Infer outlet from URL host. We do NOT trust the audit block's `outlet`
    // (that's the critic's home outlet, not necessarily the URL's domain —
    // some candidates surface from muckrack syndication paths).
    const outletId = inferOutletIdFromUrl(url);
    if (!outletId) {
      outletInferFailed += 1;
      continue;
    }

    const yearHint = extractUrlYear(url);
    const show = matchTitleToShow(title, titleMap, yearHint);
    if (!show) {
      titleMatchFailed += 1;
      continue;
    }
    const fullShow = showById.get(show.id);
    if (!fullShow) {
      titleMatchFailed += 1;
      continue;
    }

    const { date: publishDate, precision: datePrecision } = extractUrlPublishDateHint(url);
    const existingShowDate = findExistingShowPublishDate(reviewsIndex, show.id);

    const verdict = evaluateCandidate({
      url,
      title,
      show: fullShow,
      publishDate,
      datePrecision,
      openingDate: fullShow.openingDate,
      existingShowDate,
    });

    if (verdict.verdict === 'reject') {
      if (verdict.class === 'magnitude') magnitudeRejected += 1;
      else confidenceRejected += 1;
      continue;
    }

    // Existing-file check — skip if a file already lives at the target path.
    const filename = `${outletId}--${criticSlug(criticName)}.json`;
    const filepath = path.join(reviewTextsRoot, show.id, filename);
    if (fs.existsSync(filepath)) {
      existingSkip += 1;
      continue;
    }

    // Build the minimal stub payload. Mirrors ingest-manual-review.js field
    // shape but writes ONLY the protection fields appropriate for stubs:
    //  - empty fullText (no manualContentTier=complete → rebuild can fill it)
    //  - contentTier='stub' + incompleteReason='awaiting-text-collection'
    //  - no humanReviewScore (LLM will score once text lands)
    //  - audit provenance fields for traceability/rollback
    // For year-precision URLs the URL-derived date is a coarse Jan-1 placeholder.
    // Use the show's openingDate as the best estimate so downstream date guards
    // don't trip on a stub claiming Jan-1 for a fall-opening show. The
    // collect-review-texts run will overwrite publishDate once it scrapes the
    // article and finds the real date.
    const storedPublishDate =
      datePrecision === 'day' ? publishDate
      : datePrecision === 'month' ? publishDate
      : fullShow.openingDate || publishDate;

    const payload = {
      showId: show.id,
      outletId,
      criticName,
      url,
      publishDate: storedPublishDate,
      publishDatePrecision: datePrecision,
      publishDateUrlDerived: publishDate,
      fullText: '',
      contentTier: 'stub',
      incompleteReason: 'awaiting-text-collection',
      scoreSource: null,
      source: 'bulk-ingest-historical-recoveries-2026-05',
      sources: ['bulk-ingest-historical-recoveries-2026-05'],
      ingestSource: 'bulk-ingest-historical-recoveries-2026-05',
      ingestDate: new Date().toISOString(),
      auditOrigin: {
        criticSlug: criticBlock.slug || null,
        criticOutlet: criticBlock.outlet || null,
        candidateSourceFeeds: m.sources || (m.source ? [m.source] : []),
        auditTitle: m.title || null,
      },
    };

    plannedWrites.push({
      filepath,
      payload,
      show,
      criticName,
      outletId,
      publishDate: storedPublishDate,
      datePrecision,
      url,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pre-write file list capture + summary
// ────────────────────────────────────────────────────────────────────────────

const wouldIngest = plannedWrites.length;

// Always write the staged-files list — this is the rollback ledger.
try {
  fs.mkdirSync(path.dirname(stagedListPath), { recursive: true });
  fs.writeFileSync(stagedListPath, plannedWrites.map((p) => p.filepath).join('\n') + (plannedWrites.length ? '\n' : ''));
} catch (e) {
  console.error('WARNING: could not write staged-files list to ' + stagedListPath + ' :: ' + (e && e.message));
}

console.log('=== bulk-ingest-historical-recoveries-2026-05 ===');
console.log('Mode:                 ' + (APPLY ? 'APPLY' : 'DRY-RUN'));
console.log('Audit source:         ' + AUDIT_PATH);
console.log('Scanned candidates:   ' + scanned);
console.log('Would-ingest:         ' + wouldIngest);
console.log('Existing-file skip:   ' + existingSkip);
console.log('Magnitude rejected:   ' + magnitudeRejected);
console.log('Confidence rejected:  ' + confidenceRejected);
console.log('Outlet-infer failed:  ' + outletInferFailed);
console.log('Title-match failed:   ' + titleMatchFailed);
console.log('Staged-files list:    ' + stagedListPath);
console.log('');

// ────────────────────────────────────────────────────────────────────────────
// Top-N preview
// ────────────────────────────────────────────────────────────────────────────

const topN = plannedWrites.slice(0, TOP_N);
console.log('Top ' + topN.length + ' planned writes (eyeball before --apply):');
console.log('------------------------------------------------------------');
topN.forEach((p, i) => {
  const idx = String(i + 1).padStart(2, ' ');
  console.log(
    idx +
      '. show=' +
      p.show.id +
      '  outlet=' +
      p.outletId +
      '  critic=' +
      p.criticName +
      '  publish=' +
      (p.publishDate || '?') +
      ' (precision=' +
      (p.datePrecision || '-') +
      ')'
  );
  console.log('    url: ' + p.url);
  console.log('    file: ' + p.filepath);
});
console.log('');

// ────────────────────────────────────────────────────────────────────────────
// Dry-run end: print rollback recipe
// ────────────────────────────────────────────────────────────────────────────

if (!APPLY) {
  console.log('Rollback recipe (after a future --apply):');
  console.log('  xargs git rm < ' + stagedListPath);
  console.log('  git commit -m "rollback: bulk ingest of historical recoveries"');
  console.log('');
  console.log('DRY-RUN: would ingest ' + wouldIngest + '. To apply later:');
  console.log('  node scripts/migrations/bulk-ingest-historical-recoveries-2026-05.js --apply --confirm-count=' + wouldIngest);
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────────────────
// Apply
// ────────────────────────────────────────────────────────────────────────────

if (CONFIRM_COUNT !== wouldIngest) {
  console.error(
    'ABORT: --confirm-count=' +
      CONFIRM_COUNT +
      ' does not match live would-ingest count ' +
      wouldIngest +
      '. Re-run dry-run, then pass the matching number.'
  );
  process.exit(1);
}

let written = 0;
const errors = [];

for (const p of plannedWrites) {
  // Race-guard: re-check existing-file state immediately before write.
  if (fs.existsSync(p.filepath)) {
    errors.push({ file: p.filepath, err: 'file appeared between dry-run and apply — skipped' });
    continue;
  }
  try {
    fs.mkdirSync(path.dirname(p.filepath), { recursive: true });
    fs.writeFileSync(p.filepath, JSON.stringify(p.payload, null, 2) + '\n');
    written += 1;
  } catch (e) {
    errors.push({ file: p.filepath, err: (e && e.message) || String(e) });
  }
}

console.log('APPLIED: wrote ' + written + ' of ' + wouldIngest + ' files.');
if (errors.length) {
  console.error('WRITE ERRORS (' + errors.length + '):');
  for (const e of errors) console.error('  ' + e.file + ' :: ' + e.err);
  process.exit(2);
}
process.exit(0);
