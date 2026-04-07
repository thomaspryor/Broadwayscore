#!/usr/bin/env node

/**
 * audit-url-validation.js
 *
 * Retroactive content validation of roundup-sourced URLs. Identifies review
 * files where the URL may link to a different show's review due to positional
 * misattribution from aggregator carousels/roundups.
 *
 * Three-phase approach to minimize ScrapingBee credit usage:
 *   Phase 1 (free):  URL-path word matching — accept URLs containing show title words
 *   Phase 2 (free):  Archive HTML validation — validate cached aggregator pages
 *   Phase 3 (costs): Targeted fetch + validate — fetch remaining suspicious URLs
 *
 * Usage:
 *   node scripts/audit-url-validation.js --dry-run
 *   node scripts/audit-url-validation.js --status=open
 *   node scripts/audit-url-validation.js --show=oh-mary-2024
 *   node scripts/audit-url-validation.js --phase=1 --status=open
 *   SB_CREDIT_BUDGET=500 node scripts/audit-url-validation.js --status=open --limit=200
 *
 * Output: data/audit/url-validation-audit.json
 */

const fs = require('fs');
const path = require('path');

const { ROUNDUP_URL_SOURCES } = require('./gather-reviews');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { fetchPage, getScraperStats } = require('./lib/scraper');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const ARCHIVE_DIR = path.join(DATA_DIR, 'aggregator-archive');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const OUTPUT_PATH = path.join(DATA_DIR, 'audit', 'url-validation-audit.json');

// Sources whose archives are HTML (can run validatePageMatchesShow)
const HTML_ARCHIVE_DIRS = {
  'show-score': 'show-score',
  'show-score-playwright': 'show-score',
  'dtli': 'dtli',
  'bww-roundup': 'bww-roundups',
};

// Stop words to exclude from title matching
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'is',
  'it', 'by', 'as', 'my', 'no', 'so', 'if', 'do', 'be', 'we', 'he', 'me',
]);

// ============================================================
// Phase 1: URL-path word matching
// ============================================================

/**
 * Check if a URL path contains enough words from the show title
 * to be considered a likely match. Custom tokenizer for URL paths
 * (not reusing titleWordsMatchWithConfidence which uses \b boundaries).
 *
 * @param {string} url - The review URL
 * @param {string} showTitle - The show's title from shows.json
 * @returns {{ matched: boolean, titleWords: string[], matchedWords: string[], ratio: number }}
 */
function urlPathContainsTitleWords(url, showTitle) {
  // Extract meaningful words from show title
  const titleWords = showTitle
    .toLowerCase()
    .replace(/['']/g, '')       // Remove apostrophes
    .replace(/[^a-z0-9\s]/g, ' ')  // Non-alphanumeric to spaces
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  if (titleWords.length === 0) {
    // Single short-word titles (e.g., "1776", "Gigi") — match the full slug
    const fullSlug = showTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (fullSlug.length >= 2) {
      try {
        const urlPath = new URL(url).pathname.toLowerCase();
        return {
          matched: urlPath.includes(fullSlug),
          titleWords: [fullSlug],
          matchedWords: urlPath.includes(fullSlug) ? [fullSlug] : [],
          ratio: urlPath.includes(fullSlug) ? 1.0 : 0,
        };
      } catch { return { matched: false, titleWords: [fullSlug], matchedWords: [], ratio: 0 }; }
    }
    return { matched: false, titleWords: [], matchedWords: [], ratio: 0 };
  }

  // Tokenize URL path by common delimiters
  let urlPath;
  try {
    urlPath = new URL(url).pathname.toLowerCase();
  } catch {
    return { matched: false, titleWords, matchedWords: [], ratio: 0 };
  }
  const urlTokens = urlPath.split(/[-/_.]/).filter(t => t.length > 0);
  const urlTokenSet = new Set(urlTokens);

  // Check how many title words appear in URL tokens
  const matchedWords = titleWords.filter(w => urlTokenSet.has(w));
  const ratio = matchedWords.length / titleWords.length;

  return {
    matched: ratio >= 0.5,
    titleWords,
    matchedWords,
    ratio,
  };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes('--dry-run');
  const VERBOSE = args.includes('--verbose');
  const RESUME = args.includes('--resume');
  const SHOW_FILTER = args.find(a => a.startsWith('--show='))?.split('=')[1] || null;
  const SOURCE_FILTER = args.find(a => a.startsWith('--source='))?.split('=')[1] || null;
  const STATUS_FILTER = args.find(a => a.startsWith('--status='))?.split('=')[1] || 'all';
  const PHASE_FILTER = args.find(a => a.startsWith('--phase='))?.split('=')[1] || 'all';
  const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

  console.log('========================================');
  console.log('URL Validation Audit');
  console.log('========================================');
  console.log(`Filters: status=${STATUS_FILTER}, source=${SOURCE_FILTER || 'all'}, show=${SHOW_FILTER || 'all'}`);
  console.log(`Phase: ${PHASE_FILTER}, Limit: ${LIMIT || 'none'}, Dry run: ${DRY_RUN}, Resume: ${RESUME}`);

  // Load shows data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const showMap = new Map();
  for (const show of showsData.shows) {
    showMap.set(show.id, show);
  }

  // Load previous results for --resume
  let previousResults = new Set();
  if (RESUME && fs.existsSync(OUTPUT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
      for (const r of (prev.results || [])) {
        previousResults.add(`${r.showId}/${r.file}`);
      }
      console.log(`Resume: loaded ${previousResults.size} previously audited files`);
    } catch { /* ignore corrupt file */ }
  }

  // Collect all roundup-sourced review files with URLs
  console.log('\nScanning review-text files...');
  const candidates = [];

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(d => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, d);
      return fs.statSync(fullPath).isDirectory();
    })
    .filter(d => !SHOW_FILTER || d === SHOW_FILTER);

  for (const showId of showDirs) {
    const show = showMap.get(showId);
    if (!show) continue;

    // Status filter
    if (STATUS_FILTER !== 'all' && show.status !== STATUS_FILTER) continue;

    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
        if (!data.url || !data.source) continue;
        if (!ROUNDUP_URL_SOURCES.has(data.source)) continue;
        if (SOURCE_FILTER && data.source !== SOURCE_FILTER) continue;

        // Skip already-audited files in resume mode
        if (RESUME && previousResults.has(`${showId}/${file}`)) continue;

        // Skip already-flagged files
        if (data.wrongShow || data.wrongProduction) continue;

        candidates.push({
          showId,
          file,
          url: data.url,
          source: data.source,
          outlet: data.outlet || data.outletId || 'unknown',
          showTitle: show.title,
          openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
          showStatus: show.status || 'unknown',
        });
      } catch { /* skip unreadable files */ }
    }
  }

  console.log(`Found ${candidates.length} roundup-sourced review files with URLs`);

  // Stats
  const stats = {
    totalScanned: candidates.length,
    phase1SlugMatch: 0,
    phase1Suspicious: 0,
    phase2ArchiveValid: 0,
    phase2NoArchive: 0,
    phase3Fetched: 0,
    phase3Valid: 0,
    phase3FetchFailed: 0,
    mismatches: 0,
    budgetExhausted: false,
    creditsUsed: 0,
  };

  const results = [];
  const mismatches = [];

  function recordResult(candidate, phase, verdict, reason) {
    const entry = {
      showId: candidate.showId,
      file: candidate.file,
      url: candidate.url,
      source: candidate.source,
      outlet: candidate.outlet,
      phase,
      verdict,
      reason,
      showTitle: candidate.showTitle,
      showStatus: candidate.showStatus,
    };
    results.push(entry);
    if (verdict === 'mismatch') {
      mismatches.push(entry);
      stats.mismatches++;
    }
  }

  // ============================================================
  // PHASE 1: URL-path word matching (FREE)
  // ============================================================
  const runPhase1 = PHASE_FILTER === 'all' || PHASE_FILTER === '1';
  const phase2Candidates = [];

  if (runPhase1) {
    console.log('\n--- Phase 1: URL-path word matching ---');

    for (const c of candidates) {
      const match = urlPathContainsTitleWords(c.url, c.showTitle);
      if (match.matched) {
        stats.phase1SlugMatch++;
        if (VERBOSE) console.log(`  ✓ slug-match: ${c.showId}/${c.file} (${match.ratio.toFixed(2)})`);
        recordResult(c, 1, 'slug-match', `${match.matchedWords.join(',')} in URL (${(match.ratio * 100).toFixed(0)}%)`);
      } else {
        stats.phase1Suspicious++;
        phase2Candidates.push(c);
        if (VERBOSE) console.log(`  ? suspicious: ${c.showId}/${c.file} — title words [${match.titleWords.join(',')}] not in URL`);
      }
    }

    console.log(`  Slug-match (cleared): ${stats.phase1SlugMatch} (${(100 * stats.phase1SlugMatch / (candidates.length || 1)).toFixed(1)}%)`);
    console.log(`  Suspicious (need checking): ${stats.phase1Suspicious}`);
  } else {
    // Skip phase 1 — all candidates go to phase 2
    phase2Candidates.push(...candidates);
  }

  if (DRY_RUN && PHASE_FILTER === '1') {
    writeOutput(stats, results, mismatches);
    return;
  }

  // ============================================================
  // PHASE 2: Archive HTML validation (FREE)
  // ============================================================
  const runPhase2 = PHASE_FILTER === 'all' || PHASE_FILTER === '2';
  const phase3Candidates = [];

  // Cache: showId+source → validation result
  const archiveCache = new Map();

  if (runPhase2) {
    console.log('\n--- Phase 2: Archive HTML validation ---');

    for (const c of phase2Candidates) {
      const archiveSubdir = HTML_ARCHIVE_DIRS[c.source];
      if (!archiveSubdir) {
        // No HTML archive for this source (JSON-only WE sources)
        stats.phase2NoArchive++;
        phase3Candidates.push(c);
        continue;
      }

      const cacheKey = `${c.showId}|${archiveSubdir}`;
      let archiveValid = archiveCache.get(cacheKey);

      if (archiveValid === undefined) {
        // Check for archive file
        const archivePath = path.join(ARCHIVE_DIR, archiveSubdir, `${c.showId}.html`);
        if (fs.existsSync(archivePath)) {
          try {
            const html = fs.readFileSync(archivePath, 'utf8');
            const validation = await validatePageMatchesShow(html, c.showTitle, {
              openingYear: c.openingYear,
              skipLlm: true,  // Phase 2 must be free
            });
            archiveValid = validation.valid;
            archiveCache.set(cacheKey, archiveValid);
            if (VERBOSE) console.log(`  Archive ${archiveSubdir}/${c.showId}.html: ${archiveValid ? 'valid' : 'INVALID'} (${validation.reason})`);
          } catch (e) {
            archiveValid = null; // Unreadable
            archiveCache.set(cacheKey, null);
          }
        } else {
          archiveValid = null; // No archive file
          archiveCache.set(cacheKey, null);
        }
      }

      if (archiveValid === true) {
        stats.phase2ArchiveValid++;
        recordResult(c, 2, 'archive-valid', `${archiveSubdir} archive validated for ${c.showId}`);
      } else if (archiveValid === false) {
        // Archive itself doesn't match — suspicious, push to phase 3
        phase3Candidates.push(c);
      } else {
        // No archive available
        stats.phase2NoArchive++;
        phase3Candidates.push(c);
      }
    }

    console.log(`  Archive-valid (cleared): ${stats.phase2ArchiveValid}`);
    console.log(`  No archive / archive invalid: ${phase3Candidates.length}`);
  } else if (!runPhase1) {
    // Skip both phase 1 and 2 — all candidates go to phase 3
    phase3Candidates.push(...candidates);
  } else {
    phase3Candidates.push(...phase2Candidates);
  }

  if (DRY_RUN || PHASE_FILTER === '1' || PHASE_FILTER === '2') {
    if (DRY_RUN) {
      console.log(`\n[DRY RUN] Phase 3 would fetch ${phase3Candidates.length} URLs`);
      // Show breakdown by status
      const openCount = phase3Candidates.filter(c => c.showStatus === 'open').length;
      const closedCount = phase3Candidates.filter(c => c.showStatus === 'closed').length;
      console.log(`  Open shows: ${openCount}, Closed: ${closedCount}, Other: ${phase3Candidates.length - openCount - closedCount}`);
    }
    writeOutput(stats, results, mismatches);
    return;
  }

  // ============================================================
  // PHASE 3: Targeted fetch + validate (COSTS CREDITS)
  // ============================================================
  const runPhase3 = PHASE_FILTER === 'all' || PHASE_FILTER === '3';

  if (runPhase3 && phase3Candidates.length > 0) {
    console.log('\n--- Phase 3: Fetch + validate ---');

    // Sort: open shows first, then by showId
    phase3Candidates.sort((a, b) => {
      if (a.showStatus === 'open' && b.showStatus !== 'open') return -1;
      if (a.showStatus !== 'open' && b.showStatus === 'open') return 1;
      return a.showId.localeCompare(b.showId);
    });

    const limit = LIMIT > 0 ? Math.min(LIMIT, phase3Candidates.length) : phase3Candidates.length;
    console.log(`  URLs to check: ${phase3Candidates.length} (limit: ${limit})`);

    let fetched = 0;
    for (const c of phase3Candidates) {
      if (fetched >= limit) {
        console.log(`  Limit reached (${limit})`);
        break;
      }

      // Check budget
      const scraperStats = getScraperStats();
      if (scraperStats.sbBudgetExceeded) {
        console.log(`  ⚠ SB credit budget exhausted — stopping Phase 3`);
        stats.budgetExhausted = true;
        break;
      }

      try {
        const pageResult = await fetchPage(c.url, { timeout: 15000 });
        stats.phase3Fetched++;
        fetched++;

        if (pageResult && pageResult.content) {
          const validation = await validatePageMatchesShow(pageResult.content, c.showTitle, {
            openingYear: c.openingYear,
          });

          if (validation.valid) {
            stats.phase3Valid++;
            recordResult(c, 3, 'valid', validation.reason);
          } else {
            console.log(`  ✗ MISMATCH: ${c.showId}/${c.file}`);
            console.log(`    URL: ${c.url}`);
            console.log(`    Expected: "${c.showTitle}" | Reason: ${validation.reason}`);
            recordResult(c, 3, 'mismatch', validation.reason);
          }
        } else {
          stats.phase3FetchFailed++;
          recordResult(c, 3, 'fetch-empty', 'fetchPage returned no content');
        }
      } catch (e) {
        stats.phase3FetchFailed++;
        recordResult(c, 3, 'fetch-error', e.message);
        if (VERBOSE) console.log(`  ⟳ Fetch failed: ${c.url} — ${e.message}`);
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 1000));
    }

    stats.creditsUsed = getScraperStats().sbCredits;
    console.log(`  Fetched: ${stats.phase3Fetched} (${stats.phase3Valid} valid, ${stats.mismatches} mismatches, ${stats.phase3FetchFailed} failed)`);
    console.log(`  SB credits used: ${stats.creditsUsed}`);
  }

  writeOutput(stats, results, mismatches);
}

function writeOutput(stats, results, mismatches) {
  const output = {
    _meta: {
      runDate: new Date().toISOString(),
      filters: {
        status: process.argv.find(a => a.startsWith('--status='))?.split('=')[1] || 'all',
        source: process.argv.find(a => a.startsWith('--source='))?.split('=')[1] || null,
        show: process.argv.find(a => a.startsWith('--show='))?.split('=')[1] || null,
        phase: process.argv.find(a => a.startsWith('--phase='))?.split('=')[1] || 'all',
      },
      stats,
    },
    results,
    mismatches,
  };

  // Atomic write
  const tmpPath = OUTPUT_PATH + '.tmp';
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(output, null, 2) + '\n');
  fs.renameSync(tmpPath, OUTPUT_PATH);

  // Summary
  console.log('\n========================================');
  console.log('AUDIT SUMMARY');
  console.log('========================================');
  console.log(`Total scanned:           ${stats.totalScanned}`);
  if (stats.phase1SlugMatch > 0 || stats.phase1Suspicious > 0) {
    console.log(`Phase 1 slug-match:      ${stats.phase1SlugMatch} (${(100 * stats.phase1SlugMatch / (stats.totalScanned || 1)).toFixed(1)}%)`);
    console.log(`Phase 1 suspicious:      ${stats.phase1Suspicious}`);
  }
  if (stats.phase2ArchiveValid > 0 || stats.phase2NoArchive > 0) {
    console.log(`Phase 2 archive-valid:   ${stats.phase2ArchiveValid}`);
    console.log(`Phase 2 no-archive:      ${stats.phase2NoArchive}`);
  }
  if (stats.phase3Fetched > 0) {
    console.log(`Phase 3 fetched:         ${stats.phase3Fetched}`);
    console.log(`Phase 3 valid:           ${stats.phase3Valid}`);
    console.log(`Phase 3 fetch-failed:    ${stats.phase3FetchFailed}`);
    console.log(`SB credits used:         ${stats.creditsUsed}`);
  }
  console.log(`MISMATCHES FOUND:        ${stats.mismatches}`);
  if (stats.budgetExhausted) {
    console.log(`⚠ Budget exhausted — some URLs were not checked`);
  }
  console.log(`\nReport: ${OUTPUT_PATH}`);
}

// Allow importing as a module (for tests) without running CLI
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { urlPathContainsTitleWords };
