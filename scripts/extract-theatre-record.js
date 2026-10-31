#!/usr/bin/env node
/**
 * Extract reviews from Theatre Record (theatrerecord.com)
 *
 * Logs in with subscriber credentials, searches for shows, extracts
 * full review text from HTML production pages (post-2022 content).
 *
 * Usage:
 *   node scripts/extract-theatre-record.js --show=les-miserables-west-end-2021
 *   node scripts/extract-theatre-record.js --open-we          # All open WE shows
 *   node scripts/extract-theatre-record.js --open-we --dry-run
 *   node scripts/extract-theatre-record.js --long-running      # Open WE, opened before 2025
 *   node scripts/extract-theatre-record.js --browse-we         # Browse /listings/current-west-end (preferred for WE)
 *   node scripts/extract-theatre-record.js --browse-london     # Browse /listings/current-london (Off-WE)
 */

const fs = require('fs');
const { redactEmails } = require('./lib/pii-scan.js');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require('playwright');
const { isLikelyWrongProduction, isLikelyTourReview } = require('./lib/review-guards');
const { isWithinPriorRun, isWithinTourLeg } = require('./lib/wrong-production-autoclear');
const { isLateTheatreRecordReviewOfBroadwayShow } = require('./lib/tr-late-review-guard');
const { normalizeOutlet, normalizeCritic, generateReviewFilename, findExistingReviewFile, getOutletDisplayName: getRegistryDisplayName } = require('./lib/review-normalization');
const { splitOutletForLabel } = require('./lib/outlet-mismatch-heal');
const { safeWriteReview } = require('./lib/review-write-guard');
const { checkWrongShowMentionGuard, checkFilmTvGuard, isCorroboratedByRoundup } = require('./lib/tr-wrongshow-guard');
const { pickTrProduction, trTitleMatches } = require('./lib/tr-production-pick');
const { pdfUrlVariants, nonPdfHead } = require('./lib/tr-pdf-url');
const { discoverWetRoundupRows } = require('./lib/wet-roundup-discover');
const { resolveTheatreRecordWriteTarget, mergeTheatreRecordIntoExisting, isTrNoRecordCandidate, shouldSweepNoRecord } = require('./lib/review-text-identity');

const { DATE_SHORT, parseShortDate, parsePdfReviews, parseRawPdfReviews, parseDefaultPdfReviews, mergeDefaultReviews, maskPdfText, skeletonKeepLines, locateReviews, productionRuns } = require('./lib/tr-pdf-parse');
const { foldDiacritics } = require('./lib/title-match');

// BRO-6097 coverage probe: per-show outcome (counts and reasons only, never
// review text) written to --probe-out, merged into what an earlier run wrote.
// --skeleton-dir saves masked layout skeletons of the PDF issues (see
// maskPdfText) so parser fixtures come from real issues.
// venue-write-guard-ok: probe notes record TR venue text in a data/audit report only; nothing here writes shows.json
const PROBE = (() => {
  const f = process.argv.slice(2).find(a => a.startsWith('--probe-out='))?.split('=')[1];
  try { return f ? JSON.parse(fs.readFileSync(f, 'utf8')).shows || {} : {}; } catch (_) { return {}; }
})();
// Flushed on every note so a login failure or a throw keeps what was learned.
const probeNote = (showId, o) => { PROBE[showId] = Object.assign(PROBE[showId] || {}, o); writeProbe(); };
function writeProbe() {
  if (!probeOut) return;
  fs.mkdirSync(path.dirname(probeOut), { recursive: true });
  // Publisher contact lines in PDF front matter are email-shaped even letter-masked; the
  // committed-PII lint (BRO-6520) counts each one, so redact at write time instead of
  // raising its allowlist baseline every time a new show's PDF is probed.
  // Redact per string value (not the serialized text): the address matcher would swallow the
  // letter after a JSON escape backslash ("\\njane@x.com" -> "\\redacted@x.com").
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), shows: PROBE }, (k, v) => (typeof v === 'string' ? redactEmails(v) : v), 2);
  fs.writeFileSync(probeOut, json);
}

async function extractReviewsFromPDF(page, context, pdfUrl, show) {
  // Get session cookie from Playwright context
  const cookies = await context.cookies();
  const phpSession = cookies.find(c => c.name === 'PHPSESSID');
  if (!phpSession) {
    console.log('  No PHPSESSID cookie — cannot download PDF');
    probeNote(show.id, { pdf: { failed: 'no-session' } });
    return [];
  }

  // Download PDF to temp file. A link the server will not route (2:22's
  // colon slug) comes back as HTML, so each variant of the link is tried.
  const tmpFile = path.join('/tmp', `tr-${show.id}.pdf`);
  let notPdf = null;
  let gotPdf = false;
  const pdfUrls = pdfUrlVariants(pdfUrl);
  const lastUrl = pdfUrls[pdfUrls.length - 1];
  for (const url of pdfUrls) {
    try {
      // Resolve any redirects first — /archive/volume/ redirects to /archive/issue/
      execSync(`curl -s -L -o "${tmpFile}" -b "PHPSESSID=${phpSession.value}" "${url}"`, { timeout: 30000 });
    } catch (e) {
      console.log(`  PDF download failed: ${e.message}`);
      if (url !== lastUrl) continue;
      probeNote(show.id, { pdf: { failed: 'download' } });
      return [];
    }
    const fileType = execSync(`file "${tmpFile}"`).toString();
    if (fileType.includes('PDF')) { gotPdf = true; break; }
    console.log(`  Downloaded file is not a PDF (${url}): ${fileType.trim()}`);
    notPdf = { url, head: nonPdfHead(fs.readFileSync(tmpFile, 'utf8').slice(0, 4000)) };
  }
  if (!gotPdf) {
    fs.unlinkSync(tmpFile);
    probeNote(show.id, { pdf: { failed: 'not-a-pdf', ...notPdf } });
    return [];
  }

  // Try -layout first (works for 2019+ single-column PDFs with indentation boundaries)
  let text;
  try {
    text = execSync(`pdftotext -layout "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e) {
    console.log(`  pdftotext failed: ${e.message}`);
    fs.unlinkSync(tmpFile);
    probeNote(show.id, { pdf: { failed: 'pdftotext' } });
    return [];
  }

  const text0 = text;
  const layoutStats = {};
  let reviews = parsePdfReviews(text, show.title, layoutStats);
  const layoutCount = reviews.length;
  probeNote(show.id, { pdf: { layout: layoutStats, layoutReviews: layoutCount, layoutChars: text.length } });
  dumpPdfText(show.id, 'layout', text, show.title);
  if (reviews.length > 0) {
    console.log(`  Extracted ${reviews.length} reviews (-layout mode)`);
    // Don't return yet — also try raw mode as it may find more reviews
    // (layout mode can grab wrong articles from multi-column PDFs)
  }

  // Also try -raw mode — may find additional reviews via title filtering
  // Raw mode can't reliably detect production boundaries, so we extract ALL
  // outlet+date+critic+text blocks and filter to reviews that mention our show
  try {
    text = execSync(`pdftotext -raw "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString();
  } catch (e) {
    console.log(`  pdftotext -raw failed: ${e.message}`);
    fs.unlinkSync(tmpFile);
    return [];
  }

  const rawText = text;
  const rawReviews = parseRawPdfReviews(text, show.title, show.venue);
  try { dumpPdfText(show.id, 'raw', text, show.title); } catch (_) {}
  // Plain column-order mode (BRO-6097): recovers the pre-2020 reviews that
  // neither -layout nor -raw can pair into outlet + date + critic.
  let defaultText = '';
  try { defaultText = execSync(`pdftotext "${tmpFile}" -`, { maxBuffer: 10 * 1024 * 1024 }).toString(); } catch (e) {
    console.log(`  pdftotext (default) failed: ${e.message}`);
  }
  // Kill switch: TR_DEFAULT_MODE_DISABLED=true restores the layout + raw behaviour.
  const defaultReviews = process.env.TR_DEFAULT_MODE_DISABLED === 'true' ? [] : parseDefaultPdfReviews(defaultText, show.title, show.venue);
  if (dumpDir && defaultText) { try { dumpPdfText(show.id, 'default', defaultText, show.title); } catch (_) {} }
  probeNote(show.id, { pdf: Object.assign(PROBE[show.id].pdf, { defaultReviews: defaultReviews.length }) });
  probeNote(show.id, { pdf: Object.assign(PROBE[show.id].pdf, { rawReviews: rawReviews.length }) });
  if (process.argv.some(a => a.startsWith('--probe-out='))) {
    // BRO-6154: where in the issue each mode's reviews sit (no prose).
    const diag = {
      layout: locateReviews(text0, reviews.slice(0, layoutCount), show.title),
      raw: locateReviews(rawText, rawReviews, show.title),
      default: locateReviews(defaultText, defaultReviews, show.title),
      runs: { raw: productionRuns(rawText.split('\n')), default: productionRuns(defaultText.split('\n')) },
    };
    probeNote(show.id, { pdf: Object.assign(PROBE[show.id].pdf, { sections: diag }) });
  }
  if (rawReviews.length > 0) {
    console.log(`  Extracted ${rawReviews.length} reviews (-raw mode, title-matched)`);
    // Merge with layout reviews, avoiding duplicates (same outlet+critic)
    const seen = new Set(reviews.map(r => `${r.outlet}|${r.critic}`));
    for (const r of rawReviews) {
      if (!seen.has(`${r.outlet}|${r.critic}`)) {
        reviews.push(r);
        seen.add(`${r.outlet}|${r.critic}`);
      }
    }
  }

  if (defaultReviews.length > 0) {
    console.log(`  Extracted ${defaultReviews.length} reviews (default mode, title-matched)`);
    reviews = mergeDefaultReviews(reviews, defaultReviews);
  }

  probeNote(show.id, { pdf: Object.assign(PROBE[show.id].pdf, { merged: reviews.length }) });
  fs.unlinkSync(tmpFile);
  // BRO-6365: downloaded and parsed (as opposed to every `return []` failure above).
  // Default mode recovers the pre-2020 reviews, so a run without it proves nothing.
  reviews.parsedOk = !!defaultText && process.env.TR_DEFAULT_MODE_DISABLED !== 'true';
  return reviews;
}

const ROOT = path.resolve(__dirname, '..');
const SHOWS_FILE = path.join(ROOT, 'data', 'shows.json');
const REVIEWS_FILE = path.join(ROOT, 'data', 'reviews.json');
const REVIEW_TEXTS_DIR = path.join(ROOT, 'data', 'review-texts');
// outlet-registry.json is now loaded via shared normalizeOutlet() from review-normalization.js

// CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const openWE = args.includes('--open-we');
const longRunning = args.includes('--long-running');
const browseWE = args.includes('--browse-we');
const browseLondon = args.includes('--browse-london');
const limit = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10) || 0;
const noSkipExisting = args.includes('--no-skip-existing');
const showsFilter = (args.find(a => a.startsWith('--shows='))?.split('=')[1] || '').split(',').filter(Boolean);
const probeOut = args.find(a => a.startsWith('--probe-out='))?.split('=')[1];
const dumpDir = args.find(a => a.startsWith('--skeleton-dir='))?.split('=')[1];
const skeletonMax = parseInt(args.find(a => a.startsWith('--skeleton-max='))?.split('=')[1] || '6', 10);
const skeletonDone = new Set();
// Skeleton = maskPdfText (tr-pdf-parse.js): structure kept, no prose, safe to commit (§11).
function dumpPdfText(showId, mode, text, title) {
  if (!dumpDir) return;
  if (!skeletonDone.has(showId)) { if (skeletonDone.size >= skeletonMax) return; skeletonDone.add(showId); }
  fs.mkdirSync(dumpDir, { recursive: true });
  const keepWords = String(title || '').split(/\W+/).filter(w => w.length >= 3);
  // A volume PDF is ~10k lines: keep +-110 lines around the bare-title hits (then loose hits).
  const lines = text.split('\n');
  const keep = skeletonKeepLines(lines, title);
  const out = lines.filter((_, i) => keep.has(i)).join('\n');
  fs.writeFileSync(path.join(dumpDir, `${showId}.${mode}.txt`), maskPdfText(out, keepWords));
}

// Theatre Record credentials
const TR_EMAIL = process.env.TR_EMAIL || 'thomas.pryor@gmail.com';
const TR_PASSWORD = process.env.TR_PASSWORD || '';

// TR_OUTLET_MAP removed — all mappings now in outlet-registry.json aliases,
// resolved via shared normalizeOutlet() from review-normalization.js.

// Load data
const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));

// TR-specific overrides where the generic name is ambiguous
// (TR only covers London/WE productions)
const TR_MARKET_OVERRIDES = {
  'timeout': 'timeout-london',  // "Time Out" in TR is always London
};

function getOutletId(trName) {
  const id = normalizeOutlet(trName);
  return TR_MARKET_OVERRIDES[id] || id;
}

function getOutletDisplayName(trName) {
  const id = getOutletId(trName);
  return getRegistryDisplayName(id) || trName;
}

function makeFilename(outletId, criticName) {
  // Use shared normalization to prevent accent/alias variants creating duplicates
  return generateReviewFilename(outletId, criticName || 'unknown');
}

/**
 * Resolve the TR write target from the CURRENT disk state (called right
 * before writing — see the P2 note at the call site). Re-reads the exact file
 * and re-runs findExistingReviewFile, so a merge target is one that still
 * exists and still matches (stored byline + text) at write time.
 * Returns resolveTheatreRecordWriteTarget's decision plus `data` (the fresh
 * parsed merge target) and `variantPath` (for logging).
 */
function resolveFreshTheatreRecordTarget(showDir, outletId, filepath, review) {
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const exactExists = fs.existsSync(filepath);
  const exactData = exactExists ? readJson(filepath) : null;
  const variant = exactExists ? null : findExistingReviewFile(showDir, outletId, review.critic);
  const target = resolveTheatreRecordWriteTarget({
    exactPath: filepath,
    exactExists,
    exactData,
    variant,
    incomingCritic: review.critic,
    incomingText: review.fullText,
  });
  const variantPath = variant && variant.path ? variant.path : null;
  if (target.action !== 'merge') return { ...target, variantPath };
  const data = target.path === filepath ? exactData : (variant && variant.data);
  if (!data || !fs.existsSync(target.path)) {
    // Unreadable exact file / variant vanished between lookup and now: never
    // blind-overwrite — skip this row (the next run re-evaluates).
    return { action: 'skip', path: target.path, fillCritic: false, reason: 'merge-target-unreadable-or-gone', variantPath };
  }
  return { ...target, data, variantPath };
}

function parseDate(dateStr) {
  // "03 April 2026" → "2026-04-03" or "21.12.17" → "2017-12-21"
  if (!dateStr) return null;
  if (DATE_SHORT.test(dateStr)) return parseShortDate(dateStr);
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return d.toISOString().split('T')[0];
}

// Determine which shows to process
function getTargetShows() {
  let shows = showsData.shows;

  if (showsFilter.length) {
    const want = new Set(showsFilter);
    shows = shows.filter(s => want.has(s.id));
    for (const id of showsFilter) if (!shows.some(s => s.id === id)) { console.log(`  --shows: ${id} not in shows.json`); probeNote(id, { outcome: 'not-in-shows-json' }); }
    shows.sort((a, b) => new Date(a.openingDate || '2099') - new Date(b.openingDate || '2099'));
    return shows;
  }

  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
    return shows;
  }

  if (longRunning) {
    shows = shows.filter(s =>
      (s.category === 'west-end' || s.category === 'off-west-end') &&
      s.status === 'open' &&
      s.openingDate && new Date(s.openingDate) < new Date('2025-01-01')
    );
  } else if (browseWE || browseLondon || openWE) {
    const categories = browseLondon
      ? ['off-west-end']
      : ['west-end', 'off-west-end'];
    shows = shows.filter(s =>
      categories.includes(s.category) &&
      (s.status === 'open' || s.status === 'previews')
    );
  }

  // Sort by opening date (oldest first — biggest gaps)
  shows.sort((a, b) => new Date(a.openingDate || '2099') - new Date(b.openingDate || '2099'));

  if (limit > 0) shows = shows.slice(0, limit);
  return shows;
}

const { isLondonVenue } = require('./lib/tr-london-venue');

// Title normalization — shared module
const { normalizeTitle, titlesMatch, cleanSearchTitle } = require('./lib/title-normalization');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `extract-theatre-record.js — Extract reviews from Theatre Record (theatrerecord.com).

Usage:
  node scripts/extract-theatre-record.js [options]
  node scripts/extract-theatre-record.js --help, -h    print this usage and exit
`;
// Scrape TR /west-end or /london for featured shows with direct archive links
async function scrapeTRFeaturedShows(page, marketPath) {
  const url = `https://www.theatrerecord.com${marketPath}`;
  console.log(`Scraping featured shows: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  return page.evaluate(() => {
    const results = [];
    // "Top Picks" featured cards have h1 titles + "Continue reading..." links
    document.querySelectorAll('.feature, .features > div').forEach(el => {
      const h1 = el.querySelector('h1');
      const link = el.querySelector('a[href*="/archive/"]');
      if (h1 && link) {
        results.push({ title: h1.textContent.trim(), link: link.href });
      }
    });
    // "Recent Openings" articles with "See cast, creatives, and N reviews" links
    document.querySelectorAll('section.articles article').forEach(article => {
      const h2 = article.querySelector('h2');
      const link = article.querySelector('a[href*="/archive/"]');
      if (h2 && link) {
        results.push({ title: h2.textContent.trim(), link: link.href });
      }
    });
    return results;
  });
}

// Scrape TR /listings/current-west-end or /listings/current-london
async function scrapeTRListingPage(page, listingUrl) {
  console.log(`Scraping listing: ${listingUrl}`);
  await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(2000);

  const entries = await page.evaluate(() => {
    const results = [];
    const articles = document.querySelectorAll('section.articles article');
    articles.forEach(article => {
      const h2 = article.querySelector('h2');
      const h3 = article.querySelector('h3');
      if (!h2) return;
      const title = h2.textContent.trim();
      const venue = h3 ? h3.textContent.trim() : '';
      const opensFeat = article.querySelector('#feat-opens-press-night span, [id*="opens"] span');
      const opens = opensFeat ? opensFeat.textContent.trim() : '';
      results.push({ title, venue, opens });
    });
    return results;
  });

  // Deduplicate — TR often has two entries per show (old + detailed)
  const byTitle = new Map();
  for (const entry of entries) {
    const norm = normalizeTitle(entry.title);
    const existing = byTitle.get(norm);
    if (!existing || (entry.opens && !existing.opens)) {
      byTitle.set(norm, entry);
    }
  }
  const dedupedEntries = [...byTitle.values()];
  console.log(`  Found ${entries.length} entries (${dedupedEntries.length} unique) on listing page`);
  return dedupedEntries;
}

// Match TR listing entries to our shows.json
function matchListingToShows(listings, targetShows) {
  const matched = [];
  const unmatched = [];
  const listingByNormTitle = new Map();
  for (const entry of listings) {
    listingByNormTitle.set(normalizeTitle(entry.title), entry);
  }
  for (const show of targetShows) {
    // Exact match first, then fuzzy
    let listing = listingByNormTitle.get(normalizeTitle(show.title));
    if (!listing) {
      listing = listings.find(e => titlesMatch(e.title, show.title));
    }
    if (listing) {
      matched.push({ show, listing });
    } else {
      unmatched.push(show);
    }
  }
  return { matched, unmatched };
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log('=== Theatre Record Review Extractor ===');

  const targets = getTargetShows();
  console.log(`Target shows: ${targets.length}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);

  if (targets.length === 0) {
    console.log('No shows to process.');
    return;
  }

  if (!TR_PASSWORD) {
    console.error('TR_PASSWORD environment variable required');
    process.exit(1);
  }

  // Browser state — mutable so we can recover from crashes
  let browser, context, page;

  async function launchAndLogin() {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    page = await context.newPage();

    console.log('Logging in to Theatre Record...');
    await page.goto('https://www.theatrerecord.com/login');
    await page.getByRole('textbox', { name: 'Email' }).fill(TR_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(TR_PASSWORD);
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.waitForTimeout(3000);

    const loggedIn = await page.locator('text=Sign Out').count() > 0 ||
                     await page.locator('img[alt="Account"]').count() > 0;
    if (!loggedIn) {
      console.error('Login failed!');
      await browser.close();
      process.exit(1);
    }
    console.log('Login successful.\n');
  }

  await launchAndLogin();

  let totalNew = 0;
  let totalSkipped = 0;
  let totalShows = 0;

  // ─── Shared: extract search result entries from current page ───
  async function extractSearchResults(pg) {
    return pg.evaluate(() => {
      const articles = document.querySelectorAll('article');
      const r = [];
      articles.forEach(a => {
        const h2 = a.querySelector('h2');
        const venue = a.querySelector('h3');
        const links = a.querySelectorAll('a');
        let link = null;
        for (const l of links) {
          if (l.href && l.href.includes('/archive/')) { link = l; break; }
        }
        if (!link) {
          for (const l of links) {
            if (l.href && !l.href.includes('/search')) { link = l; break; }
          }
        }
        if (!h2 || !link) return;
        r.push({
          title: h2.textContent.trim(),
          venue: venue?.textContent?.trim() || '',
          link: link.href,
          linkText: link.textContent.trim()
        });
      });
      return r;
    });
  }

  // ─── Shared: extract reviews from a production page link ───
  // `picked`: the link is this show's own production, chosen by its per-show
  // search (not a browse-listing match), so it speaks for every TR file of it.
  async function processShowFromLink(show, productionLink, { picked = false } = {}) {
    const isPDF = productionLink.includes('/volume/') || productionLink.includes('/issue/');
    let reviews;

    if (isPDF) {
      console.log('  PDF format — downloading and extracting...');
      reviews = await extractReviewsFromPDF(page, context, productionLink, show);
    } else {
      try {
        await page.goto(productionLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
      } catch (e) {
        console.log(`  Failed to load page: ${e.message}`);
        return { newCount: 0, skippedCount: 0 };
      }
      await page.waitForTimeout(2000);

      reviews = await page.evaluate(() => {
        const articles = document.querySelectorAll('main article');
        const result = [];
        articles.forEach((a, i) => {
          if (i === 0) return;
          const h2 = a.querySelector('h2');
          if (!h2) return;
          const meta = h2.nextElementSibling;
          const paras = [...a.querySelectorAll('p')];
          const fullText = paras.map(p => p.textContent.trim()).filter(t => t).join('\n\n');
          const criticLink = meta ? meta.querySelector('a') : null;
          const dateText = meta ? meta.textContent.replace(/\s*by\s.*/, '').trim() : '';
          result.push({
            outlet: h2.textContent.trim(),
            critic: criticLink ? criticLink.textContent.trim() : null,
            date: dateText,
            fullText
          });
        });
        return result;
      });
    }

    const filteredCount = reviews.filter(r =>
      !r.fullText || r.fullText.length < 100 ||
      r.outlet.toLowerCase().includes('theatre record') ||
      r.outlet.toLowerCase().includes('summary') ||
      r.outlet.toLowerCase().includes('editor')
    ).length;
    probeNote(show.id, { isPDF, listed: reviews.length - filteredCount });
    console.log(`  Found ${reviews.length - filteredCount} reviews`);

    const showDir = path.join(REVIEW_TEXTS_DIR, show.id);
    if (!dryRun && !fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }

    let newCount = 0;
    let skippedCount = 0;
    let heldCount = 0; // skipped because we already hold the review (not guard rejects)

    // Lazily fetched once per show and reused across all its reviews — an
    // independent corroboration source (critic+outlet already listed for
    // this show) for the mention-count and film/TV guards below, which are
    // prone to false-rejecting real reviews on common-word titles and
    // multi-show columns (card #1227). Note: the wrong-production-date guard
    // above already validated this specific review's own pubDate against the
    // show's run window before we ever reach here, so a stale/prior-run WET
    // roundup post can't smuggle a wrong-production review past corroboration
    // — a review from a different run would already have skipReason set.
    let roundupRowsPromise = null;
    async function getRoundupRows() {
      if (roundupRowsPromise === null) {
        roundupRowsPromise = discoverWetRoundupRows(show)
          .then(result => (result ? result.rows : []))
          .catch(() => []);
      }
      return roundupRowsPromise;
    }

    const touchedFiles = new Set();
    for (const review of reviews) {
      if (!review.fullText || review.fullText.length < 100) continue;

      if (review.outlet.toLowerCase().includes('theatre record') ||
          review.outlet.toLowerCase().includes('summary') ||
          review.outlet.toLowerCase().includes('editor')) {
        continue;
      }

      const parentOutletId = getOutletId(review.outlet);
      const outletId = splitOutletForLabel(parentOutletId, review.outlet, review.critic);
      const outletDisplay = getRegistryDisplayName(outletId) || review.outlet;
      const filename = makeFilename(outletId, review.critic);
      const filepath = path.join(showDir, filename);

      // Check for existing file — both exact match and fuzzy (accent/alias variants)
      const fileExists = fs.existsSync(filepath);
      const existingVariant = findExistingReviewFile(showDir, outletId, review.critic);
      // The same review may still sit under the parent label (daily-mail for a
      // Mail on Sunday critic) until the outlet-mismatch heal moves it: held, not new.
      // BRO-6302: a review this section yields but the run skips because its file
      // exists is still on the page; the NO-RECORD sweep below must not stamp it.
      const seen = (p) => { if (p) touchedFiles.add(p); };
      const parentFile = parentOutletId !== outletId ? findExistingReviewFile(showDir, parentOutletId, review.critic) : null;
      if (parentFile) {
        seen(parentFile.path);
        skippedCount++;
        heldCount++;
        continue;
      }
      if ((fileExists || existingVariant) && !noSkipExisting) {
        seen(fileExists ? filepath : existingVariant.path);
        skippedCount++;
        heldCount++;
        continue;
      }

      // ─── Production validation guards ───
      const pubDate = parseDate(review.date);
      const showEarliestDate = show.previewsStartDate || show.openingDate;
      let skipReason = null;

      // priorRuns exemption: a TR archive review inside a declared earlier-run
      // window is legitimate prior-run coverage (return engagement / transfer),
      // not a wrong production — mirrors the rebuild inclusion guard.
      if (isLikelyWrongProduction(pubDate, showEarliestDate, 90)
          && !(pubDate && (isWithinPriorRun(new Date(pubDate), show.priorRuns) || isWithinTourLeg(new Date(pubDate), show.tourLegs)))) {
        skipReason = `wrong-production-date (review ${pubDate} vs show ${showEarliestDate})`;
      }

      // BRO-5420: the guard above only refuses reviews dated BEFORE the show. A
      // TR (London archive) review dated months after a Broadway opening is of a
      // London production of the same title (chicago-1996 / Daily Mail 1997).
      if (!skipReason && isLateTheatreRecordReviewOfBroadwayShow(show, pubDate, { isWithinPriorRun, isWithinTourLeg })) {
        skipReason = `wrong-production-late-london (review ${pubDate} vs Broadway opening ${show.openingDate || show.previewsStartDate})`;
      }

      // When show has no opening date, fall back to comparing review year vs show ID year.
      // Catches TR archiving reviews from a prior production under an unrelated future show
      // (e.g., "A Doll's House, Part 2" 2022 reviews assigned to "A Doll's House" 2026).
      if (!skipReason && !showEarliestDate && pubDate) {
        const idYearMatch = show.id.match(/-(\d{4})$/);
        if (idYearMatch) {
          const showIdYear = parseInt(idYearMatch[1]);
          const reviewYear = new Date(pubDate).getFullYear();
          if (showIdYear - reviewYear >= 2) {
            skipReason = `wrong-production-year (review year ${reviewYear} vs show ID year ${showIdYear}, no opening date to validate)`;
          }
        }
      }

      if (!skipReason) {
        const tourPatterns = [
          /\breview(?:ed)?\s+at\s+(?:the\s+)?(?:lowry|playhouse|hippodrome|opera house|new theatre|grand theatre|leeds|birmingham|manchester|bristol|cardiff|glasgow|edinburgh|sheffield|nottingham|southampton|brighton|bath|chichester|oxford|cambridge|salford|milton keynes)/i,
          /\btouring\s+(?:production|company|cast|show)\b/i,
          /\buk\s+tour\b/i,
          /\bnational\s+tour\b/i,
          /\bcurrent(?:ly)?\s+(?:on\s+)?tour\b/i,
        ];
        for (const pat of tourPatterns) {
          if (pat.test(review.fullText)) {
            skipReason = `tour-review (${pat.source.slice(0, 40)})`;
            break;
          }
        }
      }

      if (!skipReason) {
        const pantoMatches = (review.fullText.match(/\bpanto(?:s|mime)?\b/gi) || []).length;
        const pantoInOpening = /\bpanto(?:s|mime)?\b/i.test(review.fullText.slice(0, 200));
        if (pantoMatches >= 3 || pantoInOpening) {
          skipReason = 'panto (not the WE production)';
        }
      }

      if (!skipReason) {
        const filmCheck = checkFilmTvGuard(review.fullText);
        if (filmCheck.fails) {
          const roundupRows = await getRoundupRows();
          if (isCorroboratedByRoundup(review.outlet, review.critic, roundupRows)) {
            console.log(`    (film/TV guard bypassed — corroborated by WET roundup: ${filename})`);
          } else {
            skipReason = filmCheck.reason;
          }
        }
      }

      // Guard 5: Wrong-show content detection
      // Check if the review actually discusses our show (catches multi-column
      // PDF contamination AND misfiled HTML reviews on TR production pages).
      // Below-threshold mention counts on common-word/single-word titles
      // (e.g. "Barcelona") false-reject real reviews — before rejecting,
      // corroborate against the show's WET roundup (card #1227).
      if (!skipReason) {
        const mentionCheck = checkWrongShowMentionGuard(show, review.fullText);
        if (mentionCheck.fails) {
          const roundupRows = await getRoundupRows();
          if (isCorroboratedByRoundup(review.outlet, review.critic, roundupRows)) {
            console.log(`    (wrong-show guard bypassed — corroborated by WET roundup: ${filename}, ${mentionCheck.mentions} mention(s))`);
          } else {
            skipReason = mentionCheck.reason;
          }
        }
      }

      // Guard 6: Variant-show detection
      // Theatre Record sometimes co-lists variant productions (dining experiences,
      // immersive events) on the same page as the base musical. This guard uses
      // KNOWN variant signatures — specific to titles with known confusable variants.
      // Generic keywords like "immersive" are too broad (Cabaret, Hunger Games, etc.).
      if (!skipReason) {
        const reviewLower = review.fullText.toLowerCase();
        const targetTitleNorm = foldDiacritics(show.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
        const KNOWN_VARIANTS = [
          { title: 'mamma mia', keywords: ['the party', 'taverna', 'o2 arena'], label: 'Mamma Mia! The Party' },
          // Add more known variant titles here as they're discovered
        ];
        for (const variant of KNOWN_VARIANTS) {
          if (!targetTitleNorm.startsWith(variant.title)) continue;
          const matchedWord = variant.keywords.find(w => reviewLower.includes(w));
          if (matchedWord) {
            skipReason = `variant-show (review mentions "${matchedWord}" → likely ${variant.label}, not "${show.title}")`;
            break;
          }
        }
      }

      if (skipReason) {
        console.log(`    SKIP: ${filename} — ${skipReason}`);
        skippedCount++;
        continue;
      }

      const fetchedAt = new Date().toISOString();
      const reviewData = {
        showId: show.id,
        outletId,
        outlet: outletDisplay,
        criticName: review.critic || 'Unknown',
        url: null,
        publishDate: parseDate(review.date) || show.openingDate || null,
        fullText: review.fullText,
        isFullReview: true,
        contentTier: 'complete',
        contentTierReason: 'Full review text from Theatre Record',
        source: 'theatre-record',
        theatreRecordUrl: productionLink,
        addedAt: fetchedAt,
        // BRO-4490: the text is fetched now, so stamp it; without this the
        // scorer's truncated-text checks see a text with no fetch date.
        textFetchedAt: fetchedAt,
        textWordCount: review.fullText.split(/\s+/).length
      };

      // --no-skip-existing (always passed in CI): merge into the existing
      // file for this outlet+critic — including a URL-bearing "--unknown"
      // twin of the same article found by findExistingReviewFile — instead of
      // writing a second, URL-less named file beside it (that twin shape made
      // the rebuild drop the URL: 27 url:null rows, 2026-09-24).
      //
      // Re-resolve from disk HERE, not from the fileExists/existingVariant
      // read at the top of the loop: the awaited roundup discovery above can
      // run long, and a concurrent writer may have created, renamed (the
      // rebuild's --unknown cleanup) or re-attributed the file meanwhile.
      const target = resolveFreshTheatreRecordTarget(showDir, outletId, filepath, review);
      if (target.action === 'skip') {
        console.log(`    SKIP: ${filename} — ${target.reason} (${path.basename(target.path)})`);
        seen(target.path);
        skippedCount++;
        heldCount++;
        continue;
      }
      if (target.action === 'merge') {
        const targetName = path.basename(target.path);
        const existing = target.data;
        touchedFiles.add(target.path);
        const merged = mergeTheatreRecordIntoExisting(existing, reviewData, { fillCritic: target.fillCritic });
        if (dryRun) {
          console.log(`    MERGE: ${filename} -> ${targetName} (${target.reason}; adding TR data to existing review)`);
        } else {
          safeWriteReview(target.path, merged);
          console.log(`    MERGED: ${filename} -> ${targetName} (${target.reason}; preserved url=${!!merged.url}, critic=${merged.criticName})`);
        }
      } else if (dryRun) {
        console.log(`    NEW: ${filename} (${review.fullText.length} chars, ${reviewData.textWordCount} words${target.variantPath ? `; not merged into ${path.basename(target.variantPath)}: ${target.reason}` : ''})`);
      } else {
        touchedFiles.add(filepath);
        safeWriteReview(filepath, reviewData);
        console.log(`    SAVED: ${filename} (${reviewData.textWordCount} words${target.variantPath ? `; not merged into ${path.basename(target.variantPath)}: ${target.reason}` : ''})`);
      }
      newCount++;
    }

    // BRO-6154: a file the scorer rejected as another show's review that this
    // production's section no longer yields means Theatre Record has no record of
    // that outlet+critic under this production. Say so on the file.
    // BRO-6302: with the per-show pick, a rejected file taken from a different TR
    // page (an earlier run's wrong production pick: Come From Away's 2021
    // reopening listing, The Play That Goes Wrong's 2020 return) is covered too.
    // BRO-6365: a picked production whose PDF parsed cleanly but yielded nothing
    // for this show (pigeon-english, still-no-idea) has no record of any of its files.
    if (shouldSweepNoRecord({ reviewCount: reviews.length, picked, isPDF, parsedOk: reviews.parsedOk }) && fs.existsSync(showDir)) {
      for (const f of fs.readdirSync(showDir)) {
        const fp = path.join(showDir, f);
        if (!f.endsWith('.json') || touchedFiles.has(fp)) continue;
        let d; try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
        if (!isTrNoRecordCandidate(d, productionLink, { picked })) continue;
        console.log(`    NO-RECORD: ${f} (rejected as another show's text; not in this production's TR section)`);
        if (!dryRun) safeWriteReview(fp, { ...d, trNoRecordForProduction: { reason: 'Theatre Record has no review by this outlet and critic under this production (BRO-6154)', at: new Date().toISOString() } });
      }
    }

    if (newCount === 0 && reviews.length > 0) {
      console.log('  All reviews already exist');
    }
    probeNote(show.id, { saved: newCount, skippedExisting: heldCount, skippedGuarded: skippedCount - heldCount });
    return { newCount, skippedCount };
  }

  // ─── Shared: search TR, collect results, merge deduped ───
  async function searchTR(title) {
    const searchUrl = `https://www.theatrerecord.com/search?query=${encodeURIComponent('"' + title + '"')}&title=on&order=newest`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);
    let results = await extractSearchResults(page);

    // Quoted search with apostrophes/special chars often returns 0 results on TR
    // Retry without quotes if needed
    if (results.length === 0 && /[''"'']/.test(title)) {
      const cleanTitle = title.replace(/[''"'']/g, ' ').replace(/\s+/g, ' ').trim();
      const retryUrl = `https://www.theatrerecord.com/search?query=${encodeURIComponent(cleanTitle)}&title=on&order=newest`;
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);
      results = await extractSearchResults(page);
    }

    return results;
  }

  // ─── Shared: search TR for a show, pick best result, extract ───
  async function searchAndProcessShow(show, hintVenue) {
    const searchTitle = cleanSearchTitle(show.title);

    let results = await searchTR(searchTitle);

    // If no results or no London venue, retry with location filter
    if (results.length === 0 || !results.find(r => isLondonVenue(r.venue))) {
      const retryUrl = `https://www.theatrerecord.com/search?query=${encodeURIComponent('"' + searchTitle + '"')}&title=on&location=on&order=newest`;
      await page.goto(retryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);

      const retryResults = await extractSearchResults(page);
      const seen = new Set(results.map(r => r.link));
      for (const r of retryResults) {
        if (!seen.has(r.link)) { results.push(r); seen.add(r.link); }
      }
    }

    let titleMatches = results.filter(r => trTitleMatches(r.title, show.title));

    // If no title match, retry with a cleaned (suffix/prefix-stripped) title
    if (titleMatches.length === 0) {
      const shorter = cleanSearchTitle(searchTitle);
      if (shorter !== searchTitle && shorter.length >= 3) {
        console.log(`  Retrying search with shorter title: "${shorter}"`);
        const moreResults = await searchTR(shorter);
        const seen = new Set(results.map(r => r.link));
        for (const r of moreResults) {
          if (!seen.has(r.link)) { results.push(r); seen.add(r.link); }
        }
        titleMatches = results.filter(r => trTitleMatches(r.title, show.title));
      }
    }

    if (results.length === 0) {
      console.log('  No results found on Theatre Record');
      probeNote(show.id, { outcome: 'search-miss', searchQuery: searchTitle });
      return null;
    }

    if (titleMatches.length === 0) {
      probeNote(show.id, { outcome: 'title-mismatch', trResults: results.slice(0, 8).map(r => ({ title: r.title, venue: r.venue })) });
      console.log(`  No title match. TR results: ${results.map(r => `"${r.title}" @ ${r.venue}`).join('; ')}`);
      return null;
    }

    // Pick THIS production: press-night window from the archive link's
    // month, then hint venue > own venue > any London venue (BRO-4851 — the
    // old "first London title match" took the newer Old Vic Oedipus for the
    // 2024 Wyndham's row).
    const bestResult = pickTrProduction(titleMatches, show, { hintVenue, isLondonVenue });
    if (!bestResult) {
      probeNote(show.id, { outcome: 'no-production-in-window', trResults: titleMatches.map(r => ({ title: r.title, venue: r.venue, link: r.link })) });
      console.log(`  No TR production in this show's press-night window. Title matches: ${titleMatches.map(r => `"${r.title}" @ ${r.venue} (${r.link})`).join('; ')}`);
      return null;
    }

    probeNote(show.id, { outcome: 'picked', picked: { title: bestResult.title, venue: bestResult.venue, link: bestResult.link, candidates: titleMatches.length },
      trResults: results.slice(0, 12).map(r => ({ title: r.title, venue: r.venue, link: r.link })) });
    console.log(`  Found: ${bestResult.title} @ ${bestResult.venue}`);
    console.log(`  Link: ${bestResult.link}`);

    return processShowFromLink(show, bestResult.link, { picked: true });
  }

  // ─── Main processing loop ───
  if (browseWE || browseLondon) {
    const listingUrl = browseLondon
      ? 'https://www.theatrerecord.com/listings/current-london'
      : 'https://www.theatrerecord.com/listings/current-west-end';

    const listings = await scrapeTRListingPage(page, listingUrl);

    // Also scrape featured shows from /west-end or /london for direct archive links
    const marketPath = browseLondon ? '/london' : '/west-end';
    const featured = await scrapeTRFeaturedShows(page, marketPath);
    console.log(`  Found ${featured.length} featured shows with direct links`);

    // Build a map of featured show links by normalized title
    const featuredByTitle = new Map();
    for (const f of featured) {
      featuredByTitle.set(normalizeTitle(f.title), f.link);
    }

    if (listings.length === 0) {
      console.log('WARNING: No entries on listings page — page structure may have changed.');
      console.log('Falling back to search mode for all shows...\n');
    }

    const { matched, unmatched } = listings.length > 0
      ? matchListingToShows(listings, targets)
      : { matched: [], unmatched: targets };

    // Check if any unmatched shows have direct featured links
    const featuredMatched = [];
    const trulyUnmatched = [];
    for (const show of unmatched) {
      // Check exact and fuzzy title match against featured shows
      let directLink = featuredByTitle.get(normalizeTitle(show.title));
      if (!directLink) {
        for (const [normTitle, link] of featuredByTitle) {
          if (titlesMatch(show.title, normTitle)) { directLink = link; break; }
        }
      }
      if (directLink) {
        featuredMatched.push({ show, link: directLink });
      } else {
        trulyUnmatched.push(show);
      }
    }

    console.log(`\nMatched ${matched.length} shows via listing page`);
    if (featuredMatched.length > 0) {
      console.log(`Matched ${featuredMatched.length} shows via featured/recent openings`);
    }
    if (trulyUnmatched.length > 0) {
      console.log(`Unmatched: ${trulyUnmatched.length} shows (will fall back to search)`);
    }
    console.log('');

    // Helper: process a show with browser crash recovery
    async function processWithRecovery(show, hintVenue) {
      try {
        const result = await searchAndProcessShow(show, hintVenue);
        if (result) {
          totalNew += result.newCount;
          totalSkipped += result.skippedCount;
          if (result.newCount > 0 || result.skippedCount > 0) totalShows++;
        }
        await page.waitForTimeout(2000);
      } catch (err) {
        const isBrowserDead = err.message?.includes('Target page, context or browser has been closed') ||
                              err.message?.includes('browser has been closed') ||
                              err.message?.includes('Navigation failed') ||
                              err.message?.includes('ERR_ABORTED');
        if (isBrowserDead) {
          probeNote(show.id, { outcome: 'error', error: 'browser-crash: ' + String(err.message).slice(0, 100) });
          console.log(`  Browser crashed — relaunching...`);
          await launchAndLogin();
        } else {
          console.log(`  Error: ${err.message}`);
          probeNote(show.id, { outcome: 'error', error: String(err.message).slice(0, 160) });
        }
      }
    }

    // Process matched shows — search with venue hint from listing
    for (const { show, listing } of matched) {
      console.log(`\n--- ${show.title} (${show.id}) ---`);
      console.log(`  Listing: "${listing.title}" @ ${listing.venue}`);
      await processWithRecovery(show, listing.venue);
    }

    // Process featured matches (direct archive links, no search needed)
    for (const { show, link } of featuredMatched) {
      console.log(`\n--- ${show.title} (${show.id}) ---`);
      console.log(`  Featured link: ${link}`);
      try {
        const result = await processShowFromLink(show, link);
        if (result) {
          totalNew += result.newCount;
          totalSkipped += result.skippedCount;
          if (result.newCount > 0 || result.skippedCount > 0) totalShows++;
        }
        await page.waitForTimeout(2000);
      } catch (err) {
        if (err.message?.includes('browser has been closed') || err.message?.includes('ERR_ABORTED')) {
          probeNote(show.id, { outcome: 'error', error: 'browser-crash: ' + String(err.message).slice(0, 100) });
          console.log(`  Browser crashed — relaunching...`);
          await launchAndLogin();
        } else {
          console.log(`  Error: ${err.message}`);
          probeNote(show.id, { outcome: 'error', error: String(err.message).slice(0, 160) });
        }
      }
    }

    // Fall back to plain search for truly unmatched shows
    if (trulyUnmatched.length > 0) {
      console.log(`\n\n=== Falling back to search for ${trulyUnmatched.length} unmatched shows ===`);
      for (const show of trulyUnmatched) {
        console.log(`\n--- ${show.title} (${show.id}) ---`);
        await processWithRecovery(show);
      }
    }
  } else {
    // ─── Original search mode ───
    for (const show of targets) {
      console.log(`\n--- ${show.title} (${show.id}) ---`);
      try {
        const result = await searchAndProcessShow(show);
        if (result) {
          totalNew += result.newCount;
          totalSkipped += result.skippedCount;
          if (result.newCount > 0 || result.skippedCount > 0) totalShows++;
        }
        await page.waitForTimeout(2000);
      } catch (err) {
        if (err.message?.includes('browser has been closed') || err.message?.includes('ERR_ABORTED')) {
          probeNote(show.id, { outcome: 'error', error: 'browser-crash: ' + String(err.message).slice(0, 100) });
          console.log(`  Browser crashed — relaunching...`);
          await launchAndLogin();
        } else {
          console.log(`  Error: ${err.message}`);
          probeNote(show.id, { outcome: 'error', error: String(err.message).slice(0, 160) });
        }
      }
    }
  }

  await browser.close();
  if (probeOut) console.log(`Probe written: ${probeOut} (${Object.keys(PROBE).length} shows)`);

  console.log('\n=== Summary ===');
  console.log(`Shows processed: ${totalShows}`);
  console.log(`New reviews: ${totalNew}`);
  console.log(`Skipped (existing): ${totalSkipped}`);
  if (dryRun) console.log('(DRY RUN — nothing saved)');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
