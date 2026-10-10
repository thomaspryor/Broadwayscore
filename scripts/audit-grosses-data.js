#!/usr/bin/env node
/**
 * Grosses Data Audit Script
 *
 * Comprehensive audit of grosses.json and grosses-history.json for abnormalities.
 * Produces a JSON report at data/audit/grosses-data-audit.json.
 *
 * Checks:
 *  1. Impossible values (negative grosses, capacity >110%, ATP outliers)
 *  2. Show ID mismatches / orphan entries
 *  3. Missing open shows
 *  4. Stale data detection
 *  5. YoY/WoW calculation sanity
 *  6. AllTime consistency
 *  7. Capacity outliers
 *  8. ATP outliers
 *  9. Gross vs attendance consistency (ATP cross-check)
 * 10. History gaps
 * 11. Closed show data anomalies
 * 12. History data value checks
 *
 * Usage: node scripts/audit-grosses-data.js
 */

const fs = require('fs');
const path = require('path');

const GROSSES_PATH = path.join(__dirname, '../data/grosses.json');
const HISTORY_PATH = path.join(__dirname, '../data/grosses-history.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const OUTPUT_PATH = path.join(__dirname, '../data/audit/grosses-data-audit.json');

// Load data
const grosses = JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf-8'));
const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf-8'));

const issues = [];
const showsBySlug = new Map();
showsData.shows.forEach(s => showsBySlug.set(s.slug, s));

const allGrossesSlugs = Object.keys(grosses.shows);
const historyWeeks = Object.keys(history.weeks).sort();

function addIssue(type, severity, showId, detail) {
  issues.push({ type, severity, showId, detail });
}

// ==========================================================================
// 1. Impossible Values in grosses.json (thisWeek data)
// ==========================================================================
function checkImpossibleValues() {
  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek) continue;
    const tw = data.thisWeek;

    // Negative gross
    if (tw.gross !== null && tw.gross < 0) {
      addIssue('impossible-value', 'high', slug, `Negative thisWeek gross: $${tw.gross}`);
    }
    if (tw.grossPrevWeek !== null && tw.grossPrevWeek < 0) {
      addIssue('impossible-value', 'high', slug, `Negative grossPrevWeek: $${tw.grossPrevWeek}`);
    }
    if (tw.grossYoY !== null && tw.grossYoY < 0) {
      addIssue('impossible-value', 'high', slug, `Negative grossYoY: $${tw.grossYoY}`);
    }

    // Capacity > 110% (some standing room can push above 100%, but 110%+ is suspicious)
    if (tw.capacity !== null && tw.capacity > 110) {
      addIssue('impossible-value', 'high', slug, `Capacity ${tw.capacity}% exceeds 110% threshold`);
    }
    if (tw.capacity !== null && tw.capacity < 0) {
      addIssue('impossible-value', 'high', slug, `Negative capacity: ${tw.capacity}%`);
    }

    // ATP extreme outliers
    if (tw.atp !== null && tw.atp < 0) {
      addIssue('impossible-value', 'high', slug, `Negative ATP: $${tw.atp}`);
    }
    if (tw.atp !== null && tw.atp > 500) {
      addIssue('impossible-value', 'high', slug, `ATP $${tw.atp} exceeds $500 threshold`);
    }

    // Attendance
    if (tw.attendance !== null && tw.attendance < 0) {
      addIssue('impossible-value', 'high', slug, `Negative attendance: ${tw.attendance}`);
    }
    if (tw.attendance !== null && tw.attendance === 0 && tw.gross !== null && tw.gross > 0) {
      addIssue('impossible-value', 'high', slug, `Zero attendance but positive gross ($${tw.gross})`);
    }

    // Performances
    if (tw.performances !== null && (tw.performances < 0 || tw.performances > 16)) {
      addIssue('impossible-value', 'medium', slug,
        `Unusual weekly performances count: ${tw.performances} (expected 1-16)`);
    }
  }
}

// ==========================================================================
// 2. Show ID Mismatches / Orphan Entries
// ==========================================================================
function checkOrphanEntries() {
  for (const slug of allGrossesSlugs) {
    if (!showsBySlug.has(slug)) {
      addIssue('orphan-entry', 'medium', slug,
        `Grosses entry for "${slug}" has no matching show in shows.json`);
    }
  }

  // Also check history for orphans not in grosses.json
  const grossesSlugsSet = new Set(allGrossesSlugs);
  const historyOrphans = new Set();
  for (const weekKey of historyWeeks) {
    for (const slug of Object.keys(history.weeks[weekKey])) {
      if (!showsBySlug.has(slug) && !historyOrphans.has(slug)) {
        historyOrphans.add(slug);
        addIssue('orphan-history-entry', 'low', slug,
          `History entry for "${slug}" has no matching show in shows.json (found in week ${weekKey})`);
      }
    }
  }
}

// ==========================================================================
// 3. Missing Open Shows
// ==========================================================================
function checkMissingOpenShows() {
  const openShows = showsData.shows.filter(s => s.status === 'open');
  for (const show of openShows) {
    if (!grosses.shows[show.slug]) {
      addIssue('missing-open-show', 'high', show.slug,
        `Open show "${show.title}" has no grosses data at all`);
    } else if (!grosses.shows[show.slug].thisWeek) {
      addIssue('missing-open-show-thisweek', 'medium', show.slug,
        `Open show "${show.title}" has allTime data but no thisWeek data`);
    }
  }

  // Also check preview shows
  const previewShows = showsData.shows.filter(s => s.status === 'previews');
  for (const show of previewShows) {
    // Preview shows may or may not have grosses - just note as low severity
    if (grosses.shows[show.slug] && grosses.shows[show.slug].thisWeek) {
      // This is fine - previews can report grosses
    }
    // Don't flag missing preview shows - many don't report grosses yet
  }
}

// ==========================================================================
// 4. Stale Data Detection
// ==========================================================================
function checkStaleData() {
  const now = new Date();

  // Check top-level lastUpdated
  const lastUpdated = new Date(grosses.lastUpdated);
  const daysSinceUpdate = (now - lastUpdated) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate > 14) {
    addIssue('stale-data', 'high', '_global',
      `Grosses lastUpdated is ${Math.round(daysSinceUpdate)} days old (${grosses.lastUpdated})`);
  } else if (daysSinceUpdate > 9) {
    addIssue('stale-data', 'medium', '_global',
      `Grosses lastUpdated is ${Math.round(daysSinceUpdate)} days old (${grosses.lastUpdated})`);
  }

  // Parse weekEnding
  const weParts = grosses.weekEnding.split('/');
  const weekEndingDate = new Date(
    parseInt(weParts[2].length === 2 ? '20' + weParts[2] : weParts[2]),
    parseInt(weParts[0]) - 1,
    parseInt(weParts[1])
  );
  const daysSinceWeekEnd = (now - weekEndingDate) / (1000 * 60 * 60 * 24);
  if (daysSinceWeekEnd > 14) {
    addIssue('stale-weekending', 'high', '_global',
      `weekEnding "${grosses.weekEnding}" is ${Math.round(daysSinceWeekEnd)} days ago`);
  } else if (daysSinceWeekEnd > 9) {
    addIssue('stale-weekending', 'medium', '_global',
      `weekEnding "${grosses.weekEnding}" is ${Math.round(daysSinceWeekEnd)} days ago`);
  }

  // Check history freshness
  if (historyWeeks.length > 0) {
    const latestHistoryWeek = historyWeeks[historyWeeks.length - 1];
    const latestHistDate = new Date(latestHistoryWeek + 'T00:00:00Z');
    const daysSinceLatestHist = (now - latestHistDate) / (1000 * 60 * 60 * 24);
    if (daysSinceLatestHist > 14) {
      addIssue('stale-history', 'medium', '_global',
        `Latest history week is "${latestHistoryWeek}" (${Math.round(daysSinceLatestHist)} days ago)`);
    }
  }

  // Check per-show lastUpdated for shows with thisWeek data
  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek) continue;
    if (data.lastUpdated) {
      const showUpdated = new Date(data.lastUpdated);
      const showDays = (now - showUpdated) / (1000 * 60 * 60 * 24);
      if (showDays > 21) {
        addIssue('stale-show-data', 'low', slug,
          `Show lastUpdated is ${Math.round(showDays)} days old (${data.lastUpdated})`);
      }
    }
  }
}

// ==========================================================================
// 5. YoY/WoW Calculation Sanity
// ==========================================================================
function checkYoYWoWSanity() {
  // grossYoY stores the RAW GROSS from the same week last year (not a percentage).
  // grossPrevWeek stores the RAW GROSS from previous week.
  // capacityYoY stores the capacity % from last year.
  // atpYoY stores the raw ATP from last year.

  // Cross-check grossPrevWeek against history
  if (historyWeeks.length < 2) return;

  const latestWeek = historyWeeks[historyWeeks.length - 1];
  const prevWeek = historyWeeks[historyWeeks.length - 2];

  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek || data.thisWeek.grossPrevWeek === null) continue;

    const histPrev = history.weeks[prevWeek] && history.weeks[prevWeek][slug];
    if (histPrev && histPrev.gross !== null) {
      // grossPrevWeek should match the previous week's gross in history
      const diff = Math.abs(data.thisWeek.grossPrevWeek - histPrev.gross);
      const pctDiff = histPrev.gross > 0 ? diff / histPrev.gross : 0;
      if (pctDiff > 0.01 && diff > 100) {
        addIssue('wow-mismatch', 'medium', slug,
          `grossPrevWeek ($${data.thisWeek.grossPrevWeek.toLocaleString()}) differs from history prev week gross ($${histPrev.gross.toLocaleString()}) by ${(pctDiff * 100).toFixed(1)}%`);
      }
    }
  }

  // Cross-check grossYoY against history (~52 weeks ago)
  if (historyWeeks.length >= 52) {
    const latestDate = new Date(latestWeek + 'T00:00:00Z');
    const yoyTargetDate = new Date(latestDate.getTime() - 364 * 24 * 60 * 60 * 1000);

    // Find closest week to 52 weeks ago
    let closestYoYWeek = null;
    let closestDiff = Infinity;
    for (const wk of historyWeeks) {
      const wkDate = new Date(wk + 'T00:00:00Z');
      const d = Math.abs(wkDate.getTime() - yoyTargetDate.getTime()) / (1000 * 60 * 60 * 24);
      if (d < closestDiff) {
        closestDiff = d;
        closestYoYWeek = wk;
      }
    }

    if (closestYoYWeek && closestDiff <= 7) {
      for (const [slug, data] of Object.entries(grosses.shows)) {
        if (!data.thisWeek || data.thisWeek.grossYoY === null) continue;

        const histYoY = history.weeks[closestYoYWeek] && history.weeks[closestYoYWeek][slug];
        if (histYoY && histYoY.gross !== null) {
          const diff = Math.abs(data.thisWeek.grossYoY - histYoY.gross);
          const pctDiff = histYoY.gross > 0 ? diff / histYoY.gross : 0;
          if (pctDiff > 0.05 && diff > 5000) {
            addIssue('yoy-mismatch', 'low', slug,
              `grossYoY ($${data.thisWeek.grossYoY.toLocaleString()}) differs from history YoY week (${closestYoYWeek}) gross ($${histYoY.gross.toLocaleString()}) by ${(pctDiff * 100).toFixed(1)}%`);
          }
        }
      }
    }
  }

  // Check: capacityPrevWeek should roughly match history prev week capacity
  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek || data.thisWeek.capacityPrevWeek === null) continue;

    const histPrev = history.weeks[prevWeek] && history.weeks[prevWeek][slug];
    if (histPrev && histPrev.capacity !== null) {
      const diff = Math.abs(data.thisWeek.capacityPrevWeek - histPrev.capacity);
      if (diff > 2) {
        addIssue('capacity-prev-mismatch', 'low', slug,
          `capacityPrevWeek (${data.thisWeek.capacityPrevWeek}%) differs from history prev week (${histPrev.capacity}%) by ${diff.toFixed(1)} pts`);
      }
    }
  }
}

// ==========================================================================
// 6. AllTime Consistency
// ==========================================================================
function checkAllTimeConsistency() {
  for (const [slug, data] of Object.entries(grosses.shows)) {
    const at = data.allTime;
    if (!at) {
      addIssue('missing-alltime', 'medium', slug, 'No allTime data');
      continue;
    }

    // allTime gross should be >= thisWeek gross
    if (data.thisWeek && data.thisWeek.gross !== null && at.gross !== null) {
      if (at.gross < data.thisWeek.gross) {
        addIssue('alltime-less-than-thisweek', 'high', slug,
          `allTime gross ($${at.gross.toLocaleString()}) < thisWeek gross ($${data.thisWeek.gross.toLocaleString()})`);
      }
    }

    // allTime attendance should be >= thisWeek attendance
    if (data.thisWeek && data.thisWeek.attendance !== null && at.attendance !== null) {
      if (at.attendance < data.thisWeek.attendance) {
        addIssue('alltime-attendance-less-than-thisweek', 'high', slug,
          `allTime attendance (${at.attendance.toLocaleString()}) < thisWeek attendance (${data.thisWeek.attendance.toLocaleString()})`);
      }
    }

    // allTime performances should be >= thisWeek performances
    if (data.thisWeek && data.thisWeek.performances !== null && at.performances !== null) {
      if (at.performances < data.thisWeek.performances) {
        addIssue('alltime-perfs-less-than-thisweek', 'high', slug,
          `allTime performances (${at.performances}) < thisWeek performances (${data.thisWeek.performances})`);
      }
    }

    // Reasonableness: allTime performances vs show duration
    // NOTE: allTime data from BWW can span original + revival productions, while
    // shows.json openingDate refers to the LATEST production only. We check only for
    // shows whose allTime performances would be impossible even for the longest-running
    // shows (>50 years at 8 perfs/week). Also skip shows whose allTime is clearly
    // cumulative across productions (allTime gross >> what current run could generate).
    const show = showsBySlug.get(slug);
    if (show && show.openingDate && at.performances !== null && data.thisWeek) {
      const openDate = new Date(show.openingDate);
      const endDate = show.closingDate ? new Date(show.closingDate) : new Date();
      const weeksOpen = (endDate - openDate) / (1000 * 60 * 60 * 24 * 7);
      const maxReasonablePerfs = Math.ceil(weeksOpen * 9); // Max ~9 performances per week

      // Only flag if the show has thisWeek data (actively reporting) AND allTime perfs
      // are more than 2x what's possible for the current production run.
      // This avoids false positives from cumulative BWW allTime data for revivals.
      if (at.performances > maxReasonablePerfs * 2 && weeksOpen > 8) {
        addIssue('alltime-perfs-suspicious', 'low', slug,
          `allTime performances (${at.performances}) is >2x max for ~${Math.round(weeksOpen)} weeks open (max: ~${maxReasonablePerfs}) — likely cumulative across productions`);
      }
    }

    // Average gross per performance sanity
    if (at.gross !== null && at.performances !== null && at.performances > 0) {
      const avgGrossPerPerf = at.gross / at.performances;
      if (avgGrossPerPerf > 500000) {
        addIssue('alltime-avg-gross-high', 'low', slug,
          `allTime avg gross/performance: $${Math.round(avgGrossPerPerf).toLocaleString()} (unusually high)`);
      }
      if (avgGrossPerPerf < 5000 && at.performances > 10) {
        addIssue('alltime-avg-gross-low', 'low', slug,
          `allTime avg gross/performance: $${Math.round(avgGrossPerPerf).toLocaleString()} (unusually low)`);
      }
    }
  }
}

// ==========================================================================
// 7. Capacity Outliers
// ==========================================================================
function checkCapacityOutliers() {
  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek || data.thisWeek.capacity === null) continue;
    const cap = data.thisWeek.capacity;

    if (cap > 105) {
      addIssue('capacity-high', 'low', slug,
        `High capacity: ${cap}% (>105% — possible standing room or data issue)`);
    }
    if (cap < 30) {
      addIssue('capacity-low', 'medium', slug,
        `Very low capacity: ${cap}% (<30% — unusual for open Broadway show)`);
    } else if (cap < 50) {
      addIssue('capacity-low', 'low', slug,
        `Low capacity: ${cap}% (<50%)`);
    }
  }
}

// ==========================================================================
// 8. ATP Outliers
// ==========================================================================
function checkATPOutliers() {
  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek || data.thisWeek.atp === null) continue;
    const atp = data.thisWeek.atp;

    if (atp > 400) {
      addIssue('atp-high', 'medium', slug,
        `Very high ATP: $${atp} (>$400 — verify this is correct)`);
    } else if (atp > 300) {
      addIssue('atp-high', 'low', slug,
        `High ATP: $${atp} (>$300)`);
    }
    if (atp < 30) {
      addIssue('atp-low', 'medium', slug,
        `Very low ATP: $${atp} (<$30 — unusual for Broadway)`);
    } else if (atp < 50) {
      addIssue('atp-low', 'low', slug,
        `Low ATP: $${atp} (<$50)`);
    }
  }
}

// ==========================================================================
// 9. Gross vs Attendance Consistency (ATP cross-check)
// ==========================================================================
function checkGrossAttendanceConsistency() {
  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek) continue;
    const tw = data.thisWeek;

    if (tw.gross !== null && tw.attendance !== null && tw.atp !== null && tw.attendance > 0) {
      const computedATP = tw.gross / tw.attendance;
      const diff = Math.abs(computedATP - tw.atp);
      const pctDiff = tw.atp > 0 ? diff / tw.atp : 0;

      // ATP = gross/attendance should match closely (within 5%)
      if (pctDiff > 0.05 && diff > 3) {
        addIssue('atp-inconsistency', 'medium', slug,
          `Computed ATP ($${computedATP.toFixed(2)}) differs from reported ATP ($${tw.atp}) by ${(pctDiff * 100).toFixed(1)}% — gross=$${tw.gross.toLocaleString()}, attendance=${tw.attendance.toLocaleString()}`);
      }
    }
  }
}

// ==========================================================================
// 10. History Gaps — check for missing weeks
// ==========================================================================
function checkHistoryGaps() {
  if (historyWeeks.length < 2) {
    addIssue('history-insufficient', 'medium', '_global',
      `Only ${historyWeeks.length} weeks of history data`);
    return;
  }

  // Check for missing weeks in the sequence
  const missingWeeks = [];
  for (let i = 1; i < historyWeeks.length; i++) {
    const prev = new Date(historyWeeks[i - 1] + 'T00:00:00Z');
    const curr = new Date(historyWeeks[i] + 'T00:00:00Z');
    const daysBetween = (curr - prev) / (1000 * 60 * 60 * 24);
    if (daysBetween > 10) {
      // Gap detected (more than 10 days between weekly entries)
      const gapWeeks = Math.round(daysBetween / 7);
      missingWeeks.push({
        after: historyWeeks[i - 1],
        before: historyWeeks[i],
        gapDays: Math.round(daysBetween),
        missingWeekCount: gapWeeks - 1
      });
    }
  }

  if (missingWeeks.length > 0) {
    for (const gap of missingWeeks) {
      addIssue('history-gap', 'medium', '_global',
        `Missing ${gap.missingWeekCount} week(s) in history between ${gap.after} and ${gap.before} (${gap.gapDays} days)`);
    }
  }

  // Check per-show continuity for shows with thisWeek data
  // A show reporting thisWeek data should ideally appear in recent history weeks
  const recentWeeks = historyWeeks.slice(-8); // last 8 weeks
  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek) continue;

    const presentWeeks = recentWeeks.filter(w => history.weeks[w] && history.weeks[w][slug]);
    const missingCount = recentWeeks.length - presentWeeks.length;

    if (missingCount > 3 && recentWeeks.length > 3) {
      addIssue('show-history-gap', 'low', slug,
        `Show has thisWeek data but is missing from ${missingCount}/${recentWeeks.length} recent history weeks`);
    }
  }
}

// ==========================================================================
// 11. Closed Show Data Anomalies
// ==========================================================================
function checkClosedShowData() {
  const closedSlugs = showsData.shows.filter(s => s.status === 'closed').map(s => s.slug);

  for (const slug of closedSlugs) {
    const data = grosses.shows[slug];
    if (!data) continue;

    if (data.thisWeek) {
      const show = showsBySlug.get(slug);
      const closingDate = show && show.closingDate ? show.closingDate : 'unknown';
      addIssue('closed-show-thisweek', 'medium', slug,
        `Closed show (closingDate: ${closingDate}) still has thisWeek data — gross: $${(data.thisWeek.gross || 0).toLocaleString()}`);
    }
  }

  // Shows with status "previews" that have allTime but very high allTime — may have wrong status
  const previewShows = showsData.shows.filter(s => s.status === 'previews');
  for (const show of previewShows) {
    const data = grosses.shows[show.slug];
    if (!data || !data.allTime) continue;
    if (data.allTime.performances !== null && data.allTime.performances > 100) {
      addIssue('preview-high-alltime', 'low', show.slug,
        `Preview show has ${data.allTime.performances} allTime performances — may need status update`);
    }
  }
}

// ==========================================================================
// 12. History Data Value Checks
// ==========================================================================
function checkHistoryDataValues() {
  let totalChecked = 0;
  let totalIssues = 0;

  for (const [weekKey, weekData] of Object.entries(history.weeks)) {
    for (const [slug, entry] of Object.entries(weekData)) {
      totalChecked++;

      // Negative values
      if (entry.gross !== null && entry.gross < 0) {
        addIssue('history-negative-gross', 'high', slug,
          `Negative gross ($${entry.gross}) in history week ${weekKey}`);
        totalIssues++;
      }
      if (entry.capacity !== null && entry.capacity < 0) {
        addIssue('history-negative-capacity', 'high', slug,
          `Negative capacity (${entry.capacity}%) in history week ${weekKey}`);
        totalIssues++;
      }
      if (entry.atp !== null && entry.atp < 0) {
        addIssue('history-negative-atp', 'high', slug,
          `Negative ATP ($${entry.atp}) in history week ${weekKey}`);
        totalIssues++;
      }

      // Extreme capacity
      if (entry.capacity !== null && entry.capacity > 110) {
        addIssue('history-capacity-extreme', 'low', slug,
          `Capacity ${entry.capacity}% (>110%) in history week ${weekKey}`);
        totalIssues++;
      }

      // Extreme ATP
      if (entry.atp !== null && entry.atp > 500) {
        addIssue('history-atp-extreme', 'low', slug,
          `ATP $${entry.atp} (>$500) in history week ${weekKey}`);
        totalIssues++;
      }

      // Zero gross with positive attendance
      if (entry.gross === 0 && entry.attendance !== null && entry.attendance > 0) {
        addIssue('history-zero-gross-positive-attendance', 'medium', slug,
          `Zero gross with ${entry.attendance} attendance in history week ${weekKey}`);
        totalIssues++;
      }
    }
  }

  return { totalChecked, totalIssues };
}

// ==========================================================================
// 13. WoW Anomaly Detection (extreme swings)
// ==========================================================================
function checkWoWAnomalies() {
  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek) continue;
    const tw = data.thisWeek;

    // Gross WoW swing
    if (tw.gross !== null && tw.grossPrevWeek !== null && tw.grossPrevWeek > 0) {
      const pctChange = (tw.gross - tw.grossPrevWeek) / tw.grossPrevWeek;
      if (Math.abs(pctChange) > 0.75) {
        const direction = pctChange > 0 ? 'increase' : 'decrease';
        addIssue('wow-anomaly-gross', 'low', slug,
          `${Math.abs(Math.round(pctChange * 100))}% gross ${direction} WoW ($${tw.grossPrevWeek.toLocaleString()} → $${tw.gross.toLocaleString()})`);
      }
    }

    // Capacity WoW swing
    if (tw.capacity !== null && tw.capacityPrevWeek !== null && tw.capacityPrevWeek > 0) {
      const capSwing = Math.abs(tw.capacity - tw.capacityPrevWeek);
      if (capSwing > 20) {
        addIssue('wow-anomaly-capacity', 'low', slug,
          `${capSwing.toFixed(1)}pt capacity swing WoW (${tw.capacityPrevWeek}% → ${tw.capacity}%)`);
      }
    }

    // ATP WoW swing
    if (tw.atp !== null && tw.atpPrevWeek !== null && tw.atpPrevWeek > 0) {
      const atpPctChange = Math.abs(tw.atp - tw.atpPrevWeek) / tw.atpPrevWeek;
      if (atpPctChange > 0.50) {
        addIssue('wow-anomaly-atp', 'low', slug,
          `${Math.round(atpPctChange * 100)}% ATP swing WoW ($${tw.atpPrevWeek} → $${tw.atp})`);
      }
    }
  }
}

// ==========================================================================
// 14. Null value density check
// ==========================================================================
function checkNullDensity() {
  let totalFields = 0;
  let nullFields = 0;
  const nullByField = {};

  for (const [slug, data] of Object.entries(grosses.shows)) {
    if (!data.thisWeek) continue;
    const tw = data.thisWeek;
    const fields = ['gross', 'grossPrevWeek', 'grossYoY', 'capacity', 'capacityPrevWeek',
      'capacityYoY', 'atp', 'atpPrevWeek', 'atpYoY', 'attendance', 'performances'];

    for (const f of fields) {
      totalFields++;
      if (tw[f] === null || tw[f] === undefined) {
        nullFields++;
        nullByField[f] = (nullByField[f] || 0) + 1;
      }
    }
  }

  return { totalFields, nullFields, nullByField };
}

// ==========================================================================
// Run all checks
// ==========================================================================
console.log('Starting grosses data audit...\n');

checkImpossibleValues();
console.log('  [1/13] Impossible values checked');

checkOrphanEntries();
console.log('  [2/13] Orphan entries checked');

checkMissingOpenShows();
console.log('  [3/13] Missing open shows checked');

checkStaleData();
console.log('  [4/13] Stale data checked');

checkYoYWoWSanity();
console.log('  [5/13] YoY/WoW sanity checked');

checkAllTimeConsistency();
console.log('  [6/13] AllTime consistency checked');

checkCapacityOutliers();
console.log('  [7/13] Capacity outliers checked');

checkATPOutliers();
console.log('  [8/13] ATP outliers checked');

checkGrossAttendanceConsistency();
console.log('  [9/13] Gross/attendance consistency checked');

checkHistoryGaps();
console.log('  [10/13] History gaps checked');

checkClosedShowData();
console.log('  [11/13] Closed show data checked');

const histStats = checkHistoryDataValues();
console.log(`  [12/13] History data values checked (${histStats.totalChecked} entries, ${histStats.totalIssues} issues)`);

checkWoWAnomalies();
console.log('  [13/13] WoW anomalies checked');

const nullStats = checkNullDensity();

// ==========================================================================
// Build summary
// ==========================================================================
const severityCounts = { high: 0, medium: 0, low: 0 };
const typeCounts = {};
for (const issue of issues) {
  severityCounts[issue.severity]++;
  typeCounts[issue.type] = (typeCounts[issue.type] || 0) + 1;
}

const showsWithThisWeek = Object.values(grosses.shows).filter(s => s.thisWeek).length;
const showsAllTimeOnly = Object.values(grosses.shows).filter(s => !s.thisWeek).length;

const report = {
  _meta: {
    description: 'Grosses data audit report',
    generatedAt: new Date().toISOString(),
    generatedBy: 'scripts/audit-grosses-data.js'
  },
  summary: {
    grossesJson: {
      totalShows: allGrossesSlugs.length,
      showsWithThisWeek,
      showsAllTimeOnly,
      weekEnding: grosses.weekEnding,
      lastUpdated: grosses.lastUpdated
    },
    history: {
      totalWeeks: historyWeeks.length,
      earliestWeek: historyWeeks[0] || null,
      latestWeek: historyWeeks[historyWeeks.length - 1] || null,
      showsInLatestWeek: historyWeeks.length > 0
        ? Object.keys(history.weeks[historyWeeks[historyWeeks.length - 1]]).length
        : 0,
      historyEntriesChecked: histStats.totalChecked
    },
    showsJson: {
      totalShows: showsData.shows.length,
      openShows: showsData.shows.filter(s => s.status === 'open').length,
      previewShows: showsData.shows.filter(s => s.status === 'previews').length,
      closedShows: showsData.shows.filter(s => s.status === 'closed').length
    },
    nullDensity: {
      totalThisWeekFields: nullStats.totalFields,
      nullFields: nullStats.nullFields,
      nullPercentage: nullStats.totalFields > 0
        ? parseFloat(((nullStats.nullFields / nullStats.totalFields) * 100).toFixed(1))
        : 0,
      nullByField: nullStats.nullByField
    },
    issuesSummary: {
      total: issues.length,
      bySeverity: severityCounts,
      byType: typeCounts
    }
  },
  issues
};

// Ensure output directory exists
const outputDir = path.dirname(OUTPUT_PATH);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(report, null, 2) + '\n');

// ==========================================================================
// Console output
// ==========================================================================
console.log('\n========================================');
console.log('         GROSSES DATA AUDIT REPORT');
console.log('========================================\n');

console.log('DATA OVERVIEW:');
console.log(`  grosses.json: ${allGrossesSlugs.length} shows (${showsWithThisWeek} with thisWeek, ${showsAllTimeOnly} allTime-only)`);
console.log(`  grosses-history.json: ${historyWeeks.length} weeks (${historyWeeks[0] || 'N/A'} to ${historyWeeks[historyWeeks.length - 1] || 'N/A'})`);
console.log(`  shows.json: ${showsData.shows.length} total (${report.summary.showsJson.openShows} open, ${report.summary.showsJson.previewShows} previews, ${report.summary.showsJson.closedShows} closed)`);
console.log(`  Week ending: ${grosses.weekEnding}`);
console.log(`  Last updated: ${grosses.lastUpdated}`);

console.log(`\nNULL DENSITY (thisWeek fields):`);
console.log(`  ${nullStats.nullFields}/${nullStats.totalFields} fields are null (${report.summary.nullDensity.nullPercentage}%)`);
if (Object.keys(nullStats.nullByField).length > 0) {
  for (const [field, count] of Object.entries(nullStats.nullByField)) {
    console.log(`    ${field}: ${count} null`);
  }
}

console.log(`\nISSUES FOUND: ${issues.length}`);
console.log(`  HIGH:   ${severityCounts.high}`);
console.log(`  MEDIUM: ${severityCounts.medium}`);
console.log(`  LOW:    ${severityCounts.low}`);

console.log(`\nBY TYPE:`);
const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]);
for (const [type, count] of sortedTypes) {
  console.log(`  ${type}: ${count}`);
}

// Print high/medium severity issues in detail
const highMed = issues.filter(i => i.severity === 'high' || i.severity === 'medium');
if (highMed.length > 0) {
  console.log(`\nHIGH/MEDIUM SEVERITY ISSUES (${highMed.length}):`);
  for (const issue of highMed) {
    const icon = issue.severity === 'high' ? 'HIGH' : 'MED ';
    console.log(`  [${icon}] ${issue.type} | ${issue.showId} | ${issue.detail}`);
  }
}

// Print a sample of low severity issues
const lowIssues = issues.filter(i => i.severity === 'low');
if (lowIssues.length > 0) {
  const sample = lowIssues.slice(0, 20);
  console.log(`\nLOW SEVERITY ISSUES (showing ${sample.length}/${lowIssues.length}):`);
  for (const issue of sample) {
    console.log(`  [LOW ] ${issue.type} | ${issue.showId} | ${issue.detail}`);
  }
  if (lowIssues.length > 20) {
    console.log(`  ... and ${lowIssues.length - 20} more (see full report)`);
  }
}

console.log(`\nReport written to: ${OUTPUT_PATH}`);
