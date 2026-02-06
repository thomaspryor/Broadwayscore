#!/usr/bin/env node
/**
 * cleanup-review-sources.js — Flag dirty review source files before rebuild/scoring
 *
 * Phase A: Deterministic, safe fixes:
 *   Pass 1: Fix trivially broken URLs (whitespace, typos, missing domains)
 *   Pass 2: Flag /people/ profile URLs as wrongShow
 *   Pass 3: Flag BWW regional/tour reviews as wrongProduction
 *   Pass 4: Same-show dedup (4a: URL dedup, 4b: outlet+critic dedup)
 *
 * Usage:
 *   node scripts/cleanup-review-sources.js [--dry-run] [--verbose] [--no-backup] [--shows=id1,id2]
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet, normalizeCritic, mergeReviews } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'audit', 'cleanup-backups');
const REPORT_PATH = path.join(__dirname, '..', 'data', 'audit', 'source-cleanup-report.json');

// Parse CLI flags
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const NO_BACKUP = args.includes('--no-backup');
const showsArg = args.find(a => a.startsWith('--shows='));
const SHOW_FILTER = showsArg ? showsArg.split('=')[1].split(',') : null;

const stats = {
  pass1_urlFixed: 0,
  pass2_profileFlagged: 0,
  pass3_tourFlagged: 0,
  pass4a_urlDupeFlagged: 0,
  pass4a_urlDupeMerged: 0,
  pass4b_keyCritDupeFlagged: 0,
  pass4b_keyCritDupeMerged: 0,
  skippedAlreadyFlagged: 0,
  filesRead: 0,
  filesModified: 0,
};
const modifications = []; // { showId, file, pass, action, detail }

// ── Helpers ──────────────────────────────────────────────────────────────────

function atomicWriteJSON(filePath, data) {
  const content = JSON.stringify(data, null, 2) + '\n';
  if (DRY_RUN) return;
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function backupFile(filePath) {
  if (NO_BACKUP || DRY_RUN) return;
  const rel = path.relative(REVIEW_TEXTS_DIR, filePath);
  const dest = path.join(BACKUP_DIR, rel);
  const destDir = path.dirname(dest);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(filePath, dest);
  }
}

function log(msg) {
  if (VERBOSE) console.log(msg);
}

function normalizeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
    trackingParams.forEach(p => parsed.searchParams.delete(p));
    const search = parsed.searchParams.toString();
    const base = `${parsed.hostname.replace(/^www\./, '')}${parsed.pathname}`.replace(/\/$/, '').toLowerCase();
    return search ? `${base}?${search}` : base;
  } catch {
    return url.toLowerCase().replace(/\/$/, '');
  }
}

function isAlreadyFlagged(data) {
  return !!(data.wrongProduction || data.wrongShow || data.wrongAttribution || data.duplicateOf);
}

/**
 * Deterministic winner selection for same-show dedup.
 * Returns negative if a wins, positive if b wins.
 */
function compareReviewPriority(a, b) {
  // 1. Has fullText (length > 100)
  const aFull = a.data.fullText && a.data.fullText.length > 100 ? 1 : 0;
  const bFull = b.data.fullText && b.data.fullText.length > 100 ? 1 : 0;
  if (aFull !== bFull) return bFull - aFull;

  // 2. Has assignedScore or humanReviewScore
  const aScored = (a.data.assignedScore != null || a.data.humanReviewScore != null) ? 1 : 0;
  const bScored = (b.data.assignedScore != null || b.data.humanReviewScore != null) ? 1 : 0;
  if (aScored !== bScored) return bScored - aScored;

  // 3. Longer combined excerpt text
  const excerptLen = (d) => (d.bwwExcerpt || '').length + (d.dtliExcerpt || '').length +
    (d.showScoreExcerpt || '').length + (d.nycTheatreExcerpt || '').length;
  const aExc = excerptLen(a.data);
  const bExc = excerptLen(b.data);
  if (aExc !== bExc) return bExc - aExc;

  // 4. Real critic name (not "unknown")
  const aReal = (a.data.criticName || '').toLowerCase() !== 'unknown' ? 1 : 0;
  const bReal = (b.data.criticName || '').toLowerCase() !== 'unknown' ? 1 : 0;
  if (aReal !== bReal) return bReal - aReal;

  // 5. More sources entries
  const aSrc = (a.data.sources || []).length;
  const bSrc = (b.data.sources || []).length;
  if (aSrc !== bSrc) return bSrc - aSrc;

  // 6. Alphabetical filename (deterministic tiebreaker)
  return a.file.localeCompare(b.file);
}

// ── Load all review files ────────────────────────────────────────────────────

function loadAllReviews() {
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
    try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
  });

  const allReviews = []; // { showId, file, filePath, data }

  for (const showId of showDirs) {
    if (SHOW_FILTER && !SHOW_FILTER.includes(showId)) continue;

    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      const filePath = path.join(showDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        stats.filesRead++;
        allReviews.push({ showId, file, filePath, data });
      } catch (e) {
        console.warn(`  ⚠ Failed to parse ${showId}/${file}: ${e.message}`);
      }
    }
  }

  return allReviews;
}

// ── Pass 1: Fix trivially broken URLs ────────────────────────────────────────

function pass1_fixUrls(reviews) {
  console.log('\n── Pass 1: Fix broken URLs ──');
  let count = 0;

  for (const r of reviews) {
    if (!r.data.url) continue;
    const origUrl = r.data.url;
    let url = origUrl;

    // Leading/trailing whitespace
    url = url.trim();

    // Double-h typo: hhttp:// → http://
    if (url.startsWith('hhttp://')) {
      url = url.slice(1);
    }

    // Truncated scheme: s:// → https://
    if (url.startsWith('s://')) {
      url = 'http' + url;
    }

    // BWW /article/ missing domain (but not /{city}/article/)
    if (url.startsWith('/article/')) {
      url = 'https://www.broadwayworld.com' + url;
    }

    if (url !== origUrl) {
      count++;
      log(`  ✓ Fix URL: ${r.showId}/${r.file}: "${origUrl.substring(0, 60)}" → "${url.substring(0, 60)}"`);
      backupFile(r.filePath);
      r.data.url = url;
      atomicWriteJSON(r.filePath, r.data);
      stats.pass1_urlFixed++;
      stats.filesModified++;
      modifications.push({ showId: r.showId, file: r.file, pass: 1, action: 'url-fixed', detail: `"${origUrl.substring(0, 50)}" → "${url.substring(0, 50)}"` });
    }
  }

  console.log(`  Fixed ${count} URLs`);
}

// ── Pass 2: Flag /people/ profile URLs ───────────────────────────────────────

function pass2_flagProfiles(reviews) {
  console.log('\n── Pass 2: Flag /people/ profile URLs ──');
  let count = 0;

  for (const r of reviews) {
    if (!r.data.url) continue;
    if (r.data.wrongShow) { stats.skippedAlreadyFlagged++; continue; }

    // Match /people/ URLs (relative or with domain)
    const url = r.data.url;
    if (url.startsWith('/people/') || url.match(/broadwayworld\.com\/people\//)) {
      count++;
      log(`  ✓ Profile URL: ${r.showId}/${r.file}: ${url.substring(0, 60)}`);
      backupFile(r.filePath);
      r.data.wrongShow = true;
      r.data.wrongShowReason = 'URL is a BWW critic profile page, not a review';
      r.data.url = null;
      atomicWriteJSON(r.filePath, r.data);
      stats.pass2_profileFlagged++;
      stats.filesModified++;
      modifications.push({ showId: r.showId, file: r.file, pass: 2, action: 'profile-flagged', detail: url.substring(0, 60) });
    }
  }

  console.log(`  Flagged ${count} profile URLs`);
}

// ── Pass 3: Flag BWW regional/tour reviews ───────────────────────────────────

function pass3_flagTour(reviews) {
  console.log('\n── Pass 3: Flag BWW regional/tour reviews ──');
  let count = 0;

  for (const r of reviews) {
    if (!r.data.url) continue;
    if (r.data.wrongProduction) { stats.skippedAlreadyFlagged++; continue; }

    const url = r.data.url;
    // Relative URL: /{city}/article/... where city is a regional BWW page
    const relMatch = url.match(/^\/([a-z][a-z0-9-]+)\/article\//);
    if (relMatch) {
      const city = relMatch[1];
      count++;
      log(`  ✓ Tour review: ${r.showId}/${r.file}: /${city}/article/...`);
      backupFile(r.filePath);
      r.data.wrongProduction = true;
      r.data.wrongProductionReason = `BWW regional/tour review (${city})`;
      atomicWriteJSON(r.filePath, r.data);
      stats.pass3_tourFlagged++;
      stats.filesModified++;
      modifications.push({ showId: r.showId, file: r.file, pass: 3, action: 'tour-flagged', detail: city });
      continue;
    }

    // Full URL with regional prefix: broadwayworld.com/{city}/article/...
    const fullMatch = url.match(/broadwayworld\.com\/([a-z][a-z0-9-]+)\/article\//);
    if (fullMatch && fullMatch[1] !== 'article') {
      const city = fullMatch[1];
      count++;
      log(`  ✓ Tour review: ${r.showId}/${r.file}: .../${city}/article/...`);
      backupFile(r.filePath);
      r.data.wrongProduction = true;
      r.data.wrongProductionReason = `BWW regional/tour review (${city})`;
      atomicWriteJSON(r.filePath, r.data);
      stats.pass3_tourFlagged++;
      stats.filesModified++;
      modifications.push({ showId: r.showId, file: r.file, pass: 3, action: 'tour-flagged', detail: city });
    }
  }

  console.log(`  Flagged ${count} tour reviews`);
}

// ── Pass 4: Same-show dedup ──────────────────────────────────────────────────

function pass4_sameShowDedup(reviews) {
  console.log('\n── Pass 4: Same-show dedup ──');

  // Group reviews by show
  const byShow = {};
  for (const r of reviews) {
    if (isAlreadyFlagged(r.data)) continue;
    if (!byShow[r.showId]) byShow[r.showId] = [];
    byShow[r.showId].push(r);
  }

  const alreadyFlaggedFiles = new Set(); // track files flagged in 4a so 4b doesn't re-flag

  // ── 4a: URL dedup ──
  console.log('  4a: URL dedup...');
  let urlDupes = 0;

  for (const [showId, showReviews] of Object.entries(byShow)) {
    // Group by normalized URL
    const byUrl = {};
    for (const r of showReviews) {
      if (!r.data.url || !r.data.url.startsWith('http')) continue;
      const norm = normalizeUrl(r.data.url);
      if (!norm) continue;
      if (!byUrl[norm]) byUrl[norm] = [];
      byUrl[norm].push(r);
    }

    for (const [normUrl, group] of Object.entries(byUrl)) {
      if (group.length < 2) continue;

      // Sort by priority (winner first)
      group.sort(compareReviewPriority);
      const winner = group[0];

      for (let i = 1; i < group.length; i++) {
        const loser = group[i];
        urlDupes++;
        alreadyFlaggedFiles.add(loser.filePath);

        log(`  ✓ URL dupe: ${showId}/${loser.file} → ${winner.file} (${normUrl.substring(0, 50)})`);

        // Merge useful data from loser into winner
        backupFile(winner.filePath);
        backupFile(loser.filePath);

        const merged = mergeReviews(winner.data, loser.data);
        Object.assign(winner.data, merged);
        atomicWriteJSON(winner.filePath, winner.data);

        loser.data.duplicateOf = winner.file;
        atomicWriteJSON(loser.filePath, loser.data);

        stats.pass4a_urlDupeFlagged++;
        stats.pass4a_urlDupeMerged++;
        stats.filesModified += 2;
        modifications.push({ showId, file: loser.file, pass: '4a', action: 'url-dupe-flagged', detail: `winner: ${winner.file}` });
      }
    }
  }

  console.log(`  4a: Flagged ${urlDupes} URL duplicates`);

  // ── 4b: Outlet+critic key dedup ──
  console.log('  4b: Outlet+critic dedup...');
  let keyDupes = 0;

  for (const [showId, showReviews] of Object.entries(byShow)) {
    // Group by normalized outlet+critic key
    const byKey = {};
    for (const r of showReviews) {
      if (alreadyFlaggedFiles.has(r.filePath)) continue;
      if (r.data.duplicateOf) continue;
      const outlet = normalizeOutlet(r.data.outlet || r.data.outletId || '');
      const critic = normalizeCritic(r.data.criticName || '');
      if (!outlet) continue;
      const key = `${outlet}|${critic}`;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(r);
    }

    for (const [key, group] of Object.entries(byKey)) {
      if (group.length < 2) continue;

      group.sort(compareReviewPriority);
      const winner = group[0];

      for (let i = 1; i < group.length; i++) {
        const loser = group[i];
        keyDupes++;

        log(`  ✓ Key dupe: ${showId}/${loser.file} → ${winner.file} (${key})`);

        backupFile(winner.filePath);
        backupFile(loser.filePath);

        const merged = mergeReviews(winner.data, loser.data);
        Object.assign(winner.data, merged);
        atomicWriteJSON(winner.filePath, winner.data);

        loser.data.duplicateOf = winner.file;
        atomicWriteJSON(loser.filePath, loser.data);

        stats.pass4b_keyCritDupeFlagged++;
        stats.pass4b_keyCritDupeMerged++;
        stats.filesModified += 2;
        modifications.push({ showId, file: loser.file, pass: '4b', action: 'key-dupe-flagged', detail: `winner: ${winner.file}, key: ${key}` });
      }
    }
  }

  console.log(`  4b: Flagged ${keyDupes} outlet+critic duplicates`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('=== Review Source File Cleanup ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  if (SHOW_FILTER) console.log(`Show filter: ${SHOW_FILTER.join(', ')}`);
  console.log('');

  const reviews = loadAllReviews();
  console.log(`Loaded ${reviews.length} review files from ${new Set(reviews.map(r => r.showId)).size} shows`);

  pass1_fixUrls(reviews);
  pass2_flagProfiles(reviews);
  pass3_flagTour(reviews);
  pass4_sameShowDedup(reviews);

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log(`Files read:              ${stats.filesRead}`);
  console.log(`Files modified:          ${stats.filesModified}`);
  console.log(`Pass 1 - URLs fixed:     ${stats.pass1_urlFixed}`);
  console.log(`Pass 2 - Profiles:       ${stats.pass2_profileFlagged}`);
  console.log(`Pass 3 - Tour reviews:   ${stats.pass3_tourFlagged}`);
  console.log(`Pass 4a - URL dupes:     ${stats.pass4a_urlDupeFlagged}`);
  console.log(`Pass 4b - Key dupes:     ${stats.pass4b_keyCritDupeFlagged}`);
  console.log(`Skipped (already flagged): ${stats.skippedAlreadyFlagged}`);
  console.log('');

  const totalFlagged = stats.pass2_profileFlagged + stats.pass3_tourFlagged +
    stats.pass4a_urlDupeFlagged + stats.pass4b_keyCritDupeFlagged;
  console.log(`Total newly flagged/fixed: ${stats.pass1_urlFixed + totalFlagged}`);
  console.log(`Estimated LLM scoring savings: ~$${(totalFlagged * 0.045).toFixed(2)}`);

  // Write audit report
  const report = {
    generatedAt: new Date().toISOString(),
    mode: DRY_RUN ? 'dry-run' : 'live',
    showFilter: SHOW_FILTER || 'all',
    stats,
    modifications,
  };

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
    console.log(`\nReport written to ${REPORT_PATH}`);
  } else {
    console.log('\n(Dry run — no files modified)');
  }

  // Check for leftover .tmp files
  if (!DRY_RUN) {
    const tmpFiles = [];
    const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(d => {
      try { return fs.statSync(path.join(REVIEW_TEXTS_DIR, d)).isDirectory(); } catch { return false; }
    });
    for (const dir of showDirs) {
      if (SHOW_FILTER && !SHOW_FILTER.includes(dir)) continue;
      const files = fs.readdirSync(path.join(REVIEW_TEXTS_DIR, dir));
      for (const f of files) {
        if (f.endsWith('.tmp')) tmpFiles.push(`${dir}/${f}`);
      }
    }
    if (tmpFiles.length > 0) {
      console.warn(`\n⚠ WARNING: ${tmpFiles.length} .tmp files found:`);
      tmpFiles.forEach(f => console.warn(`  ${f}`));
    }
  }
}

main();
