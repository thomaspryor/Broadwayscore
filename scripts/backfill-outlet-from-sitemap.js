#!/usr/bin/env node
/**
 * backfill-outlet-from-sitemap.js
 *
 * Backfill historical reviews for a single outlet by:
 *   1) fetching its Yoast/WP sitemap_index.xml
 *   2) enumerating all post URLs across child sitemaps
 *   3) slug-matching each URL path to shows.json titles
 *   4) writing stub review files (URL only) for high-confidence matches
 *
 * Designed for outlets where per-show SERP would be wasteful (T3 with light coverage).
 * Stub files get fullText via collect-review-texts and scoring via score-reviews-llm
 * downstream.
 *
 * Usage:
 *   node scripts/backfill-outlet-from-sitemap.js \
 *     --outlet=the-komisar-scoop \
 *     --critic="Lucy Komisar" \
 *     --sitemap=https://www.thekomisarscoop.com/sitemap_index.xml \
 *     [--max-matches=10] [--dry-run] [--write] [--require-year-match]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { slugify, normalizeOutlet } = require('./lib/review-normalization');

// ── arg parsing ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opts = {
  outlet: null,
  critic: null,
  sitemap: null,
  maxMatches: Infinity,
  dryRun: true,                  // safe by default
  requireYearMatch: false,       // when URL has /YYYY/ segment, require year ±1 of show open year
  outputJson: null,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--outlet=')) opts.outlet = a.split('=')[1];
  else if (a.startsWith('--critic=')) opts.critic = a.split('=')[1];
  else if (a.startsWith('--sitemap=')) opts.sitemap = a.split('=')[1];
  else if (a.startsWith('--max-matches=')) opts.maxMatches = parseInt(a.split('=')[1], 10);
  else if (a === '--write') opts.dryRun = false;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--require-year-match') opts.requireYearMatch = true;
  else if (a.startsWith('--output-json=')) opts.outputJson = a.split('=')[1];
}

if (!opts.outlet || !opts.sitemap) {
  console.error('Usage: --outlet=<id> --critic=<name> --sitemap=<url> [--write] [--require-year-match]');
  process.exit(1);
}

// ── sitemap fetch ────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'BroadwayScorecard-Backfill/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

function extractLocs(xml) {
  const locs = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(m[1].trim());
  return locs;
}

// Extract <url><loc>+<lastmod> pairs (post-sitemap entries have both).
function extractUrlsWithLastmod(xml) {
  const out = [];
  const re = /<url>\s*<loc>([^<]+)<\/loc>(?:[\s\S]*?<lastmod>([^<]+)<\/lastmod>)?[\s\S]*?<\/url>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({ url: m[1].trim(), lastmod: m[2] ? m[2].trim() : null });
  }
  return out;
}

async function getAllPostUrls(sitemapIndexUrl) {
  const indexXml = await fetchUrl(sitemapIndexUrl);
  const childSitemaps = extractLocs(indexXml).filter(u => /post-sitemap\d*\.xml/.test(u));
  if (childSitemaps.length === 0) {
    // single-tier sitemap (no index)
    return extractUrlsWithLastmod(indexXml);
  }
  const all = [];
  for (const child of childSitemaps) {
    try {
      const xml = await fetchUrl(child);
      all.push(...extractUrlsWithLastmod(xml));
    } catch (e) {
      console.warn(`  ⚠ child sitemap ${child} failed: ${e.message}`);
    }
  }
  return all;
}

// URL slugs that clearly identify NON-theater-review posts. We reject these
// before slug-matching to avoid sending TV/film/awards posts downstream.
const NON_THEATER_SLUG_PATTERNS = [
  /\bdocumentary-review\b/,
  /\bvenice-film-festival\b/,
  /\bcannes\b/,
  /\bsundance\b/,
  /\btoronto-film-festival\b/,
  /\btiff\b/,
  /\boscar(s|-legends|-nominations|-best)\b/,
  /\bemmys?\b/,
  /\bgolden-globe/,
  /\bseason-\d+\b/,
  /\bseason-(one|two|three|four|five|six|seven|eight|nine|ten)\b/,
  /\bpremiere-photos\b/,
  /\bnetflix-releases\b/,
  /-trailer\b/,
  /\btrailer-/,
  /\bteaser-/,
  /\bfirst-look\b/,
  /\bbehind-the-scenes\b/,
  /\b(ranked|ranking|listicle)\b/,
  /\bexplained\b/,
  /\bmovie-analysis\b/,
  /\bma-interview\b/,
  /-interview-?$/,
  /-interview-/,
  /\b(she|he|we|i|the)-(was|is|got|will|need|want)-/,
  /\binstagram-/,
  /\btiktok-/,
  /-podcast(-|$)/,
  /-comic-(con|book)\b/,
  /\b(video|reaction)-only\b/,
  /\bnaacp-image-awards\b/,
  /\b(outer-critics-circle|drama-desk|critics-choice)-?(nominations|nominee|awards?)/,
  /-drama-desks?\b/,
  /\bbox-office\b/,
  /-photos-?$/,
  /\bmcu(s|s-last)\b/,
  /\b(dorian|tony|tonys|olivier|grammy|sag-aftra)-(theater-)?awards?\b/,
  /\bperforming-on-the-tonys\b/,
  /\btonys-?(next|with|preview|red-carpet)\b/,
  /\b(4k-blu|blu-ray|criterion|streaming-on)\b/,
  /\b(hamptons|telluride|berlinale)-(international-)?film-festival\b/,
  /\bproduction-design\b/,
  /\bnbr-proclaims\b/,
  /\bbest-(picture|director|actor|actress|film)\b/,
  /\b(naacp|spirit-awards)\b/,
  /\b(season|series)-finale\b/,
  /\bclos(es|ing)-\d{4}-/,
  /-discusses-/,
  /-talks-about-/,
  /-on-set-/,
  /-set-photos\b/,
  /\bemmy-/,
  /-music-video\b/,
  /\boscar-?(nominations|winners|hopefuls|race)\b/,
];

function looksNonTheater(slug) {
  for (const re of NON_THEATER_SLUG_PATTERNS) {
    if (re.test(slug)) return re.source;
  }
  return null;
}

// ── url → slug + year ────────────────────────────────────────────────────────
function parseUrl(url, lastmod) {
  try {
    const u = new URL(url);
    const segs = u.pathname.replace(/^\/|\/$/g, '').split('/');
    if (segs.length === 0 || !segs[segs.length - 1]) return null;
    const slug = segs[segs.length - 1];
    let year = null, yearSource = null;
    for (const s of segs) {
      if (/^\d{4}$/.test(s)) {
        const y = parseInt(s, 10);
        if (y >= 1995 && y <= 2030) { year = y; yearSource = 'url-segment'; break; }
      }
    }
    // Fallback to sitemap lastmod for outlets that don't put year in URL path
    if (year == null && lastmod) {
      const m = String(lastmod).match(/^(\d{4})/);
      if (m) { year = parseInt(m[1], 10); yearSource = 'sitemap-lastmod'; }
    }
    return { slug, year, yearSource, pathDepth: segs.length };
  } catch { return null; }
}

// ── show match ───────────────────────────────────────────────────────────────
// Confidence levels:
//   strong  — slug starts with title-slug AND (title >= 3 words OR title >= 14 chars)
//             AND (no year requirement OR year matches show open ±1)
//   medium  — slug starts with title-slug AND title 2 words OR 10-13 chars
//   weak    — slug contains title-slug as a token boundary (rejected by default)
function buildShowIndex(shows) {
  const idx = [];
  for (const s of shows) {
    if (!s.title || !s.id) continue;
    const titleSlug = slugify(s.title);
    if (!titleSlug || titleSlug.length < 3) continue;
    const wordCount = titleSlug.split('-').filter(w => w.length > 1).length;
    let openYear = null;
    if (s.openingNight) openYear = parseInt(String(s.openingNight).slice(0, 4), 10);
    else if (s.openingDate) openYear = parseInt(String(s.openingDate).slice(0, 4), 10);
    else if (s.firstPerformance) openYear = parseInt(String(s.firstPerformance).slice(0, 4), 10);
    else if (/-(\d{4})$/.test(s.id)) openYear = parseInt(s.id.match(/-(\d{4})$/)[1], 10);
    idx.push({
      id: s.id,
      title: s.title,
      titleSlug,
      titleSlugLen: titleSlug.length,
      titleWords: wordCount,
      category: s.category || null,
      status: s.status || null,
      openYear,
    });
  }
  // sort longest title first so multi-word titles win over short prefixes
  idx.sort((a, b) => b.titleSlug.length - a.titleSlug.length);
  return idx;
}

function matchUrlToShow(urlSlug, urlYear, showIndex, opts) {
  // Find ALL shows whose title-slug is a prefix of url-slug. If multiple match,
  // pick the longest title-slug (most specific) AND/OR closest year.
  const candidates = [];
  for (const sh of showIndex) {
    if (urlSlug === sh.titleSlug ||
        urlSlug.startsWith(sh.titleSlug + '-') ||
        urlSlug.startsWith(sh.titleSlug + '_')) {
      candidates.push(sh);
    }
  }
  if (candidates.length === 0) return null;

  // Trim to candidates with the maximum title-slug length (specificity).
  // "the-mother-of-all-lies-documentary-review" should NOT match "the-mother-..."
  // even if both prefixes exist; longest wins.
  const maxLen = Math.max(...candidates.map(c => c.titleSlug.length));
  const longest = candidates.filter(c => c.titleSlug.length === maxLen);

  // Among same-title candidates, pick by year proximity to URL.
  let chosen = longest[0];
  let chosenDiff = Infinity;
  if (urlYear) {
    for (const c of longest) {
      if (!c.openYear) continue;
      const d = Math.abs(urlYear - c.openYear);
      if (d < chosenDiff) { chosen = c; chosenDiff = d; }
    }
  } else {
    // No URL year — prefer the OLDEST production (sitemap likely covers historical reviews,
    // and the older production is the more likely match for an undated post). Override only if
    // there's a clearly active/open recent show.
    for (const c of longest) {
      if (!c.openYear) continue;
      if (chosen.openYear == null || c.openYear < chosen.openYear) chosen = c;
    }
  }

  const sh = chosen;
  const strong = sh.titleWords >= 3 || sh.titleSlugLen >= 14;
  const medium = sh.titleWords === 2 || (sh.titleSlugLen >= 10 && sh.titleSlugLen < 14);

  let yearOk = true;
  let yearReason = '—';
  if (urlYear && sh.openYear) {
    const diff = Math.abs(urlYear - sh.openYear);
    yearOk = diff <= 1;
    yearReason = `urlY=${urlYear} showY=${sh.openYear} Δ=${diff}` + (longest.length > 1 ? ` (best of ${longest.length})` : '');
  } else if (urlYear) {
    yearReason = `urlY=${urlYear} showY=null`;
  } else if (sh.openYear) {
    yearReason = `urlY=null showY=${sh.openYear}`;
  }

  let confidence;
  if (strong && yearOk) confidence = 'strong';
  else if (strong && !yearOk) confidence = 'year-mismatch';
  else if (medium && yearOk) confidence = 'medium';
  else if (medium && !yearOk) confidence = 'medium-year-mismatch';
  else confidence = 'weak';

  return { show: sh, confidence, yearReason, candidateCount: longest.length };
}

// ── existing files (avoid re-creating) ───────────────────────────────────────
function loadExistingForOutlet(outletId, reviewTextsRoot) {
  const existing = new Map(); // showId → { file, url }
  if (!fs.existsSync(reviewTextsRoot)) return existing;
  const showDirs = fs.readdirSync(reviewTextsRoot).filter(d => {
    const p = path.join(reviewTextsRoot, d);
    return fs.statSync(p).isDirectory() && !d.startsWith('_');
  });
  for (const sd of showDirs) {
    const files = fs.readdirSync(path.join(reviewTextsRoot, sd));
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      // outlet-id is everything before --
      const m = f.match(/^([^-].*?)--/);
      if (!m) continue;
      const fileOutletId = m[1];
      if (fileOutletId !== outletId) continue;
      const fp = path.join(reviewTextsRoot, sd, f);
      try {
        const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
        existing.set(sd, { file: f, url: d.url || null, criticName: d.criticName || null });
      } catch {}
    }
  }
  return existing;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`=== Backfill ${opts.outlet} from sitemap ===`);
  console.log(`Sitemap: ${opts.sitemap}`);
  console.log(`Mode:    ${opts.dryRun ? 'DRY RUN' : 'WRITE'}`);
  if (opts.requireYearMatch) console.log(`Year:    REQUIRED (drop weak/year-mismatch matches)`);

  console.log(`\n[1/4] Fetching sitemap...`);
  const allUrls = await getAllPostUrls(opts.sitemap);
  console.log(`  → ${allUrls.length} URLs total`);

  console.log(`\n[2/4] Loading shows.json + existing reviews for outlet...`);
  const shows = require('../data/shows.json');
  const showList = shows.shows || shows;
  const showIndex = buildShowIndex(showList);
  console.log(`  → ${showIndex.length} indexable shows`);
  const reviewTextsRoot = path.join(__dirname, '..', 'data', 'review-texts');
  const existingForOutlet = loadExistingForOutlet(opts.outlet, reviewTextsRoot);
  console.log(`  → ${existingForOutlet.size} existing files for ${opts.outlet}`);

  console.log(`\n[3/4] Matching URLs to shows...`);
  const matches = [];
  const stats = { total: 0, parsed: 0, nonTheaterFiltered: 0, matched: 0, byConfidence: {}, alreadyHave: 0 };
  for (const item of allUrls) {
    const url = typeof item === 'string' ? item : item.url;
    const lastmod = typeof item === 'string' ? null : item.lastmod;
    stats.total++;
    const parsed = parseUrl(url, lastmod);
    if (!parsed) continue;
    stats.parsed++;
    const nonTheaterReason = looksNonTheater(parsed.slug);
    if (nonTheaterReason) {
      stats.nonTheaterFiltered++;
      continue;
    }
    const m = matchUrlToShow(parsed.slug, parsed.year, showIndex, opts);
    if (!m) continue;
    stats.matched++;
    stats.byConfidence[m.confidence] = (stats.byConfidence[m.confidence] || 0) + 1;
    const existing = existingForOutlet.get(m.show.id);
    if (existing) {
      stats.alreadyHave++;
      if (existing.url && existing.url.replace(/\/$/, '') === url.replace(/\/$/, '')) continue;
    }
    matches.push({
      url,
      urlSlug: parsed.slug,
      urlYear: parsed.year,
      yearSource: parsed.yearSource,
      lastmod,
      showId: m.show.id,
      showTitle: m.show.title,
      showOpenYear: m.show.openYear,
      confidence: m.confidence,
      yearReason: m.yearReason,
      existingFile: existing ? existing.file : null,
    });
  }

  // Filter by confidence
  const strongMatches = matches.filter(m => m.confidence === 'strong');
  const mediumMatches = matches.filter(m => m.confidence === 'medium');
  const yearMismatch = matches.filter(m => m.confidence.includes('year-mismatch'));
  const weakMatches = matches.filter(m => m.confidence === 'weak');

  console.log(`\n=== Stats ===`);
  console.log(`  URLs total:           ${stats.total}`);
  console.log(`  Parseable:            ${stats.parsed}`);
  console.log(`  Non-theater filtered: ${stats.nonTheaterFiltered}`);
  console.log(`  Slug-matched a show:  ${stats.matched}`);
  console.log(`  Already have outlet:  ${stats.alreadyHave}`);
  console.log(`  --- by confidence ---`);
  for (const [k, v] of Object.entries(stats.byConfidence)) console.log(`  ${k.padEnd(22)}${v}`);
  console.log(`\n  → strong:               ${strongMatches.length} (NEW URLs)`);
  console.log(`  → medium:               ${mediumMatches.length}`);
  console.log(`  → year-mismatch:        ${yearMismatch.length}`);
  console.log(`  → weak:                 ${weakMatches.length}`);

  // Output sample
  console.log(`\n=== Sample (first 12 strong) ===`);
  strongMatches.slice(0, 12).forEach(m => {
    console.log(`  [${m.confidence}] ${m.showId} ← ${m.url}  (${m.yearReason})`);
  });
  if (mediumMatches.length > 0) {
    console.log(`\n=== Sample (first 6 medium) ===`);
    mediumMatches.slice(0, 6).forEach(m => {
      console.log(`  [${m.confidence}] ${m.showId} ← ${m.url}  (${m.yearReason})`);
    });
  }
  if (yearMismatch.length > 0) {
    console.log(`\n=== Sample (first 6 year-mismatch) ===`);
    yearMismatch.slice(0, 6).forEach(m => {
      console.log(`  [${m.confidence}] ${m.showId} ← ${m.url}  (${m.yearReason})`);
    });
  }

  if (opts.outputJson) {
    fs.writeFileSync(opts.outputJson, JSON.stringify({ stats, strongMatches, mediumMatches, yearMismatch, weakMatches }, null, 2));
    console.log(`\nFull match list written to: ${opts.outputJson}`);
  }

  // Write stubs (only strong by default; medium opt-in)
  const toWrite = opts.requireYearMatch
    ? strongMatches
    : strongMatches.concat(mediumMatches);
  const capped = toWrite.slice(0, opts.maxMatches);

  console.log(`\n[4/4] ${opts.dryRun ? 'Would write' : 'Writing'} ${capped.length} stub file(s)`);
  if (opts.dryRun) {
    console.log(`  (dry run — pass --write to actually create files)`);
    return;
  }

  let written = 0, skipped = 0;
  for (const m of capped) {
    const showDir = path.join(reviewTextsRoot, m.showId);
    if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });
    const criticSlug = opts.critic ? slugify(opts.critic) : 'unknown';
    const fileName = `${opts.outlet}--${criticSlug}.json`;
    const filePath = path.join(showDir, fileName);
    if (fs.existsSync(filePath)) {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (existing.url && existing.url.replace(/\/$/, '') === m.url.replace(/\/$/, '')) {
        skipped++;
        continue;
      }
      // Different URL — append a hash suffix so we don't clobber
      const urlHash = require('crypto').createHash('sha1').update(m.url).digest('hex').slice(0, 6);
      const altFile = `${opts.outlet}--${criticSlug}--${urlHash}.json`;
      const altPath = path.join(showDir, altFile);
      const stub = {
        showId: m.showId,
        outletId: opts.outlet,
        criticName: opts.critic || 'Unknown',
        url: m.url,
        textFetched: false,
        contentTier: 'stub',
        ingestSource: 'backfill-outlet-from-sitemap',
        ingestedAt: new Date().toISOString(),
        backfillCandidateConfidence: m.confidence,
        backfillUrlYear: m.urlYear,
        humanReviewedWrongProduction: false,
        humanReviewedWrongArticle: false,
        wrongProductionManualClear: true,
        wrongShowManualClear: true,
        wrongArticleManualClear: true,
        allowEarlyDate: true,
        allowLateDate: true,
        protectedFields: [
          'humanReviewedWrongProduction',
          'humanReviewedWrongArticle',
          'wrongProductionManualClear',
          'wrongShowManualClear',
          'wrongArticleManualClear',
          'allowEarlyDate',
          'allowLateDate',
          'ingestSource',
          'backfillCandidateConfidence',
        ],
      };
      fs.writeFileSync(altPath, JSON.stringify(stub, null, 2) + '\n');
      written++;
      continue;
    }
    const stub = {
      showId: m.showId,
      outletId: opts.outlet,
      criticName: opts.critic || 'Unknown',
      url: m.url,
      textFetched: false,
      contentTier: 'stub',
      ingestSource: 'backfill-outlet-from-sitemap',
      ingestedAt: new Date().toISOString(),
      backfillCandidateConfidence: m.confidence,
      backfillUrlYear: m.urlYear,
      // The slug+year match IS the human verification. Pre-clear the LLM-verifier
      // hallucinations that fire on historical pre-2020 reviews ("future date",
      // "wrong venue", "different production") — see feedback_historical_review_recovery.md.
      humanReviewedWrongProduction: false,
      humanReviewedWrongArticle: false,
      wrongProductionManualClear: true,
      wrongShowManualClear: true,
      wrongArticleManualClear: true,
      allowEarlyDate: true,
      allowLateDate: true,
      protectedFields: [
        'humanReviewedWrongProduction',
        'humanReviewedWrongArticle',
        'wrongProductionManualClear',
        'wrongShowManualClear',
        'wrongArticleManualClear',
        'allowEarlyDate',
        'allowLateDate',
        'ingestSource',
        'backfillCandidateConfidence',
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(stub, null, 2) + '\n');
    written++;
  }
  console.log(`  Wrote: ${written}, Skipped (URL match): ${skipped}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
