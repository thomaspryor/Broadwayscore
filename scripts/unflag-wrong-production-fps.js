#!/usr/bin/env node
/**
 * unflag-wrong-production-fps.js — Unflag false-positive wrongProduction reviews
 *
 * Phase 1 of cross-revival review recovery.
 *
 * CONSERVATIVE APPROACH: Only auto-unflag HIGH-confidence false positives.
 * Many wrongProduction files are CORRECTLY flagged (tour reviews from regional outlets
 * filed under the Broadway production). Only unflag when we're confident it's an
 * actual Broadway/production review, not a tour/regional review.
 *
 * High-confidence unflag criteria:
 *   1. OPENING COVERAGE: publishDate within 14 days of opening AND URL date (if any)
 *      doesn't contradict. These are preview/opening-night reviews.
 *   2. PRE-BROADWAY FP: auto-adjudicated as "pre-broadway" with date within 90 days
 *      before opening. Pre-Broadway tryouts are correctly filed under the Broadway show.
 *   3. URL-YEAR GUARD on SHORT-RUN shows: flagged by URL-year guard but show ran < 3 years.
 *      For short-run shows, there's no tour to confuse with.
 *
 * NOT auto-unflagged (printed as REVIEW_NEEDED):
 *   - Regional outlets on long-running shows (likely tour reviews)
 *   - Files with wrongProductionReason (LLM-classified individually)
 *   - Cross-market/structural guards
 *
 * Usage:
 *   node scripts/unflag-wrong-production-fps.js --dry-run    # Preview changes
 *   node scripts/unflag-wrong-production-fps.js              # Apply changes
 *   node scripts/unflag-wrong-production-fps.js --verbose    # Show all skipped details
 */

const fs = require('fs');
const path = require('path');
const { clearWrongProductionFlags } = require('./lib/wrong-production-clear');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `unflag-wrong-production-fps.js — Unflag false-positive wrongProduction reviews

Usage:
  node scripts/unflag-wrong-production-fps.js --dry-run    # Preview changes
  node scripts/unflag-wrong-production-fps.js              # Apply changes
  node scripts/unflag-wrong-production-fps.js --verbose    # Show all skipped details
  node scripts/unflag-wrong-production-fps.js --help, -h   # print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266/#498/#638/#545 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

const BASE = path.join(__dirname, '..', 'data', 'review-texts');
const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'shows.json'), 'utf8'));

// Build show metadata
const showMap = {};
for (const s of showsData.shows) {
  showMap[s.id] = s;
}

// Notes that indicate structural or content-verified guards — never auto-unflag these
const STRUCTURAL_NOTE_PATTERNS = [
  'Cross-market', 'cross-market', 'Same URL exists in', 'London outlet',
  'US outlet', 'URL-market guard', 'Venue guard',
  'fullText is from',  // content manually verified as wrong production
];

function isStructuralNote(note) {
  if (!note) return false;
  return STRUCTURAL_NOTE_PATTERNS.some(p => note.includes(p));
}

function extractDates(data) {
  const result = { publishDate: null, urlDate: null, urlYears: null };

  if (data.publishDate) {
    const d = new Date(data.publishDate);
    if (!isNaN(d.getTime())) result.publishDate = d;
  }

  if (data.url) {
    // Full date from URL
    const m = data.url.match(/\/((?:19|20)\d\d)[/-](\d{2})[/-](\d{2})/);
    if (m) {
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}`);
      if (!isNaN(d.getTime())) result.urlDate = d;
    }
    // Year-only from URL
    const ym = data.url.match(/(?:[/\-_.])((?:19|20)\d\d)(?:[/\-_.]|$)/g);
    if (ym) {
      result.urlYears = ym.map(y => parseInt(y.match(/\d{4}/)[0])).filter(y => y >= 1950 && y <= 2030);
    }
  }

  return result;
}

function daysBetween(d1, d2) {
  return Math.round((d1 - d2) / 86400000);
}

function showRunYears(show) {
  const open = show.openingDate ? new Date(show.openingDate) : null;
  const close = show.closingDate ? new Date(show.closingDate) : null;
  if (!open) return null;
  const openYear = open.getFullYear();
  const closeYear = close ? close.getFullYear() : new Date().getFullYear();
  return closeYear - openYear;
}

// Main scan
const dirs = fs.readdirSync(BASE).filter(d => {
  try { return fs.statSync(path.join(BASE, d)).isDirectory(); } catch { return false; }
});

const stats = {
  unflagged: 0, reviewNeeded: 0, llmClassified: 0, structural: 0,
  noDate: 0, outsideWindow: 0, noSiblings: 0, skippedOther: 0,
};
const unflaggedFiles = [];
const reviewNeededFiles = [];

for (const dir of dirs) {
  const show = showMap[dir];
  if (!show) continue;

  const openDate = show.openingDate ? new Date(show.openingDate) : null;
  if (!openDate) continue;

  const closeDate = show.closingDate ? new Date(show.closingDate) : null;
  const runYears = showRunYears(show);

  const dirPath = path.join(BASE, dir);
  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));

  // Count non-wrongProd siblings
  const wpFiles = [];
  let nonWpCount = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8'));
      if (data.wrongProduction === true) wpFiles.push({ file: f, data });
      else nonWpCount++;
    } catch (e) { /* skip */ }
  }

  if (wpFiles.length === 0) continue;
  if (nonWpCount === 0) { stats.noSiblings += wpFiles.length; continue; }

  for (const { file: f, data } of wpFiles) {
    // Skip LLM-classified (individually assessed)
    if (data.wrongProductionReason) { stats.llmClassified++; continue; }

    // Skip wrongShow/duplicate
    if (data.wrongShow || data.duplicateTextOf) { stats.skippedOther++; continue; }

    // Skip structural guards
    if (isStructuralNote(data.wrongProductionNote)) { stats.structural++; continue; }

    // Extract dates
    const dates = extractDates(data);
    const note = data.wrongProductionNote || '';

    // Skip Auto-adjudicated/Auto-flagged notes (LLM verified content) UNLESS pre-broadway
    // Pre-broadway is a valid FP (tryout correctly filed under Broadway show)
    if ((note.startsWith('Auto-adjudicated:') || note.startsWith('Auto-flagged:'))
        && !note.includes('pre-broadway') && !note.includes('pre-Broadway')) {
      stats.llmClassified++;
      continue;
    }

    // --- RULE 1: Opening coverage (publishDate within 14 days of opening) ---
    if (dates.publishDate) {
      const daysFromOpening = daysBetween(dates.publishDate, openDate);
      // publishDate within 14 days before to 14 days after opening
      if (daysFromOpening >= -14 && daysFromOpening <= 14) {
        // Cross-check: if URL date or URL year contradicts publishDate, skip
        // (publishDate might be wrong, e.g. scraped metadata from different article)
        if (dates.urlDate) {
          const urlVsPub = Math.abs(daysBetween(dates.urlDate, dates.publishDate));
          if (urlVsPub > 60) {
            reviewNeededFiles.push({
              show: dir, file: f, reason: 'publishDate near opening but URL date contradicts',
              detail: `pub=${dates.publishDate.toISOString().split('T')[0]} url=${dates.urlDate.toISOString().split('T')[0]} open=${show.openingDate}`,
            });
            stats.reviewNeeded++;
            continue;
          }
        }
        // Also check URL year (catches cases like deadline.com/2017/09/ without full date)
        if (dates.urlYears && dates.urlYears.length > 0) {
          const pubYear = dates.publishDate.getFullYear();
          const closestUrlYear = dates.urlYears.reduce((best, y) =>
            Math.abs(y - pubYear) < Math.abs(best - pubYear) ? y : best);
          if (Math.abs(closestUrlYear - pubYear) > 2) {
            reviewNeededFiles.push({
              show: dir, file: f, reason: 'publishDate near opening but URL year contradicts',
              detail: `pub=${dates.publishDate.toISOString().split('T')[0]} urlYear=${closestUrlYear} open=${show.openingDate}`,
            });
            stats.reviewNeeded++;
            continue;
          }
        }
        // High confidence: opening coverage
        doUnflag(dir, dirPath, f, data, show, `opening-coverage: publishDate ${daysFromOpening}d from opening`);
        continue;
      }
    }

    // --- RULE 2: Pre-Broadway auto-adjudicated ---
    if (note.includes('Auto-adjudicated: pre-broadway') || note.includes('Auto-adjudicated: pre-Broadway')) {
      // Pre-Broadway tryouts are correctly filed under the Broadway show
      // Verify date is within 90 days before opening
      const bestDate = dates.publishDate || dates.urlDate;
      if (bestDate) {
        const daysBeforeOpening = daysBetween(openDate, bestDate);
        if (daysBeforeOpening >= 0 && daysBeforeOpening <= 365) {
          doUnflag(dir, dirPath, f, data, show, `pre-broadway: ${daysBeforeOpening}d before opening`);
          continue;
        }
      } else if (dates.urlYears && dates.urlYears.length > 0) {
        // URL year within 1 year before opening year
        const openYear = openDate.getFullYear();
        if (dates.urlYears.some(y => y >= openYear - 1 && y <= openYear)) {
          doUnflag(dir, dirPath, f, data, show, `pre-broadway: URL year near opening year ${openYear}`);
          continue;
        }
      }
    }

    // --- RULE 3: URL-year guard on short-run shows (< 3 years) ---
    if (note.includes('URL contains year') && runYears !== null && runYears < 3) {
      // For short-run shows, the URL-year guard fires on URL years that are just 1-2 years off
      // from opening. No tour confusion because the show didn't run long enough.
      if (dates.urlYears && dates.urlYears.length > 0) {
        const openYear = openDate.getFullYear();
        const closeYear = closeDate ? closeDate.getFullYear() : openYear + 1;
        if (dates.urlYears.some(y => y >= openYear - 1 && y <= closeYear + 1)) {
          doUnflag(dir, dirPath, f, data, show, `url-year-guard on short-run show (${runYears}yr)`);
          continue;
        }
      }
    }

    // --- RULE 4: No-note file with publishDate during the show's actual run ---
    // Only for shows that ran < 3 years (avoids tour reviews)
    if (!note && dates.publishDate && runYears !== null && runYears < 3) {
      const effectiveClose = closeDate || new Date();
      const daysAfterOpen = daysBetween(dates.publishDate, openDate);
      const daysBeforeClose = daysBetween(effectiveClose, dates.publishDate);
      if (daysAfterOpen >= -45 && daysBeforeClose >= -90) {
        doUnflag(dir, dirPath, f, data, show, `short-run show publishDate during run`);
        continue;
      }
    }

    // --- Not high-confidence: classify as review-needed or skip ---
    const bestDate = dates.publishDate || dates.urlDate;
    if (!bestDate && (!dates.urlYears || dates.urlYears.length === 0)) {
      stats.noDate++;
      continue;
    }

    // Check if within broad window (for REVIEW_NEEDED classification)
    let withinBroadWindow = false;
    if (bestDate) {
      const earlyBound = new Date(openDate.getTime() - 45 * 86400000);
      const effectiveClose = closeDate || new Date();
      const lateBound = new Date(effectiveClose.getTime() + 365 * 86400000);
      withinBroadWindow = bestDate >= earlyBound && bestDate <= lateBound;
    } else if (dates.urlYears) {
      const openYear = openDate.getFullYear();
      const closeYear = closeDate ? closeDate.getFullYear() : new Date().getFullYear();
      withinBroadWindow = dates.urlYears.some(y => y >= openYear - 1 && y <= closeYear + 1);
    }

    if (withinBroadWindow) {
      const dateStr = bestDate ? bestDate.toISOString().split('T')[0] : `years:[${dates.urlYears}]`;
      reviewNeededFiles.push({
        show: dir, file: f,
        reason: runYears >= 3 ? 'long-running show — may be tour' : 'within window but low confidence',
        detail: `date=${dateStr} open=${show.openingDate} close=${show.closingDate || 'open'} note="${note.substring(0, 60)}"`,
      });
      stats.reviewNeeded++;
    } else {
      stats.outsideWindow++;
    }
  }
}

function doUnflag(showId, dirPath, file, data, show, reason) {
  const openDate = show.openingDate ? new Date(show.openingDate) : null;
  const closeDate = show.closingDate ? new Date(show.closingDate) : null;

  console.log(`${DRY_RUN ? '[DRY RUN] ' : ''}UNFLAG: ${showId}/${file} — ${reason}`);

  if (!DRY_RUN) {
    clearWrongProductionFlags(data, { source: 'unflag-wrong-production-fps.js', reason });

    // Set allow flags as needed
    const dates = extractDates(data);
    const bestDate = dates.publishDate || dates.urlDate;

    if (bestDate && openDate && bestDate < openDate) {
      data.allowEarlyDate = true;
    }
    if (bestDate && closeDate && bestDate > closeDate) {
      data.allowLateDate = true;
    }
    // For URL-year-only unflagging, set both to prevent re-flagging
    if (!dates.publishDate && !dates.urlDate && dates.urlYears) {
      data.allowEarlyDate = true;
      data.allowLateDate = true;
    }

    data.wrongProductionAutoCleared = `unflag-fps: ${reason}`;
    data.wrongProductionAutoClearedAt = new Date().toISOString().split('T')[0];

    fs.writeFileSync(path.join(dirPath, file), JSON.stringify(data, null, 2) + '\n');
  }

  stats.unflagged++;
  unflaggedFiles.push({ show: showId, file, reason });
}

// === OUTPUT ===
console.log('\n=== SUMMARY ===');
console.log(`HIGH-CONFIDENCE UNFLAGGED: ${stats.unflagged}${DRY_RUN ? ' (dry run)' : ''}`);
console.log(`REVIEW NEEDED (within window but low confidence): ${stats.reviewNeeded}`);
console.log(`Skipped — LLM-classified: ${stats.llmClassified}`);
console.log(`Skipped — structural guards: ${stats.structural}`);
console.log(`Skipped — no date: ${stats.noDate}`);
console.log(`Skipped — outside window: ${stats.outsideWindow}`);
console.log(`Skipped — no siblings: ${stats.noSiblings}`);
console.log(`Skipped — other: ${stats.skippedOther}`);

if (unflaggedFiles.length > 0) {
  console.log(`\n=== UNFLAGGED FILES (${unflaggedFiles.length}) ===`);
  const byShow = {};
  for (const u of unflaggedFiles) {
    if (!byShow[u.show]) byShow[u.show] = [];
    byShow[u.show].push(u);
  }
  for (const [show, files] of Object.entries(byShow).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${show}: ${files.length}`);
    for (const f of files) console.log(`    ${f.file} — ${f.reason}`);
  }
}

if (reviewNeededFiles.length > 0) {
  console.log(`\n=== REVIEW NEEDED (${reviewNeededFiles.length}) ===`);
  console.log('These files are within the show window but may be tour reviews.');
  console.log('Manual content review required before unflagging.\n');
  const byReason = {};
  for (const r of reviewNeededFiles) {
    if (!byReason[r.reason]) byReason[r.reason] = [];
    byReason[r.reason].push(r);
  }
  for (const [reason, files] of Object.entries(byReason)) {
    console.log(`  --- ${reason} (${files.length}) ---`);
    const shown = VERBOSE ? files : files.slice(0, 10);
    for (const f of shown) console.log(`    ${f.show}/${f.file} | ${f.detail}`);
    if (!VERBOSE && files.length > 10) console.log(`    ... and ${files.length - 10} more (use --verbose)`);
  }
}
