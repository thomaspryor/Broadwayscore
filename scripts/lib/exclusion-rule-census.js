'use strict';

/**
 * BRO-176: explainExclusion() (review-guards.js) is the single implementation
 * of the includability rule chain and names a stable rule for every excluded
 * review, but nothing consumed those names — corpus-count drift monitors
 * (check-review-count-drift.js, check-corpus-drift.js) only see "N fewer
 * reviews", never "wrongProduction spiked on 12 shows". This module is that
 * consumer: it aggregates (showId, rule) pairs — already computed by a caller
 * via explainExclusion() — into counts by rule and, per rule, the shows
 * driving that count, then diffs two such aggregates so a change in the
 * excluded/included totals can be attributed to a specific rule instead of
 * read as an undifferentiated count.
 *
 * Pure — no fs, no explainExclusion call. The corpus walk and the
 * explainExclusion(data, show, filePath) call live in the CLI
 * (scripts/exclusion-rule-census.js); this only aggregates and reports on
 * whatever rule names it's handed.
 */

/**
 * @param {Array<{showId: string, file: string, rule: string|null}>} records
 *   one entry per review-text file scanned; `rule` is explainExclusion()'s
 *   return value — a stable rule name, or null when the file is includable.
 * @returns {{
 *   totalScanned: number, totalIncluded: number, totalExcluded: number,
 *   byRule: Record<string, {count: number, shows: Record<string, number>}>,
 *   byShow: Record<string, {scanned: number, excluded: number, byRule: Record<string, number>}>,
 * }}
 */
function buildCensus(records) {
  // Object.create(null): showId is directory-name-derived (pipeline-controlled
  // today, but not validated here) and rule is a string key either way — a
  // showId of '__proto__'/'constructor' must not silently write onto
  // Object.prototype instead of being tracked as a normal entry.
  const byRule = Object.create(null);
  const byShow = Object.create(null);
  let totalIncluded = 0;

  for (const { showId, rule } of records) {
    const showKey = showId || 'unknown-show';
    if (!byShow[showKey]) byShow[showKey] = { scanned: 0, excluded: 0, byRule: Object.create(null) };
    byShow[showKey].scanned++;

    if (rule === null || rule === undefined) {
      totalIncluded++;
      continue;
    }

    byShow[showKey].excluded++;
    byShow[showKey].byRule[rule] = (byShow[showKey].byRule[rule] || 0) + 1;

    if (!byRule[rule]) byRule[rule] = { count: 0, shows: Object.create(null) };
    byRule[rule].count++;
    byRule[rule].shows[showKey] = (byRule[rule].shows[showKey] || 0) + 1;
  }

  const totalScanned = records.length;
  return {
    totalScanned,
    totalIncluded,
    totalExcluded: totalScanned - totalIncluded,
    byRule,
    byShow,
  };
}

/**
 * Diff two census snapshots (same shape as buildCensus's return) and
 * attribute the change in each rule's count to the shows that moved most.
 * This is the "attribute corpus drift to a rule" half of BRO-176: instead of
 * "reviews.json shrank by 9", the caller learns "wrongProduction +14 (12 on
 * show X, 2 on show Y), showNotMentioned -5".
 */
function diffCensus(baseline, current) {
  const baseRules = (baseline && baseline.byRule) || {};
  const curRules = (current && current.byRule) || {};
  const ruleNames = new Set([...Object.keys(baseRules), ...Object.keys(curRules)]);

  const perRule = [];
  for (const rule of ruleNames) {
    const before = (baseRules[rule] && baseRules[rule].count) || 0;
    const after = (curRules[rule] && curRules[rule].count) || 0;
    const delta = after - before;
    if (delta === 0) continue;

    const beforeShows = (baseRules[rule] && baseRules[rule].shows) || {};
    const afterShows = (curRules[rule] && curRules[rule].shows) || {};
    const showIds = new Set([...Object.keys(beforeShows), ...Object.keys(afterShows)]);
    const topShows = [...showIds]
      .map((showId) => ({
        showId,
        before: beforeShows[showId] || 0,
        after: afterShows[showId] || 0,
        delta: (afterShows[showId] || 0) - (beforeShows[showId] || 0),
      }))
      .filter((s) => s.delta !== 0)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    perRule.push({ rule, before, after, delta, topShows });
  }

  perRule.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    scannedDelta: (current?.totalScanned || 0) - (baseline?.totalScanned || 0),
    excludedDelta: (current?.totalExcluded || 0) - (baseline?.totalExcluded || 0),
    perRule,
  };
}

function formatCensusReport(census, { limit = 5 } = {}) {
  const lines = [];
  lines.push(
    `Scanned ${census.totalScanned} review file(s): ${census.totalIncluded} included, ${census.totalExcluded} excluded.`
  );
  const rules = Object.entries(census.byRule).sort((a, b) => b[1].count - a[1].count);
  for (const [rule, info] of rules) {
    const topShows = Object.entries(info.shows)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([showId, count]) => `${showId} (${count})`)
      .join(', ');
    lines.push(`  ${rule}: ${info.count}${topShows ? ` — top shows: ${topShows}` : ''}`);
  }
  return lines.join('\n');
}

function formatDriftReport(diff, { limit = 5 } = {}) {
  if (diff.perRule.length === 0) {
    return `No change in excluded-review counts by rule (scanned delta ${signed(diff.scannedDelta)}).`;
  }
  const lines = [
    `Excluded-review count changed by ${signed(diff.excludedDelta)} (scanned delta ${signed(diff.scannedDelta)}). Attribution by rule:`,
  ];
  for (const r of diff.perRule.slice(0, limit)) {
    const shownDrivers = r.topShows
      .slice(0, limit)
      .map((s) => `${s.showId} (${signed(s.delta)})`)
      .join(', ');
    lines.push(
      `  ${r.rule}: ${signed(r.delta)} (${r.before} -> ${r.after})${shownDrivers ? ` — driven by ${shownDrivers}` : ''}`
    );
  }
  return lines.join('\n');
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

module.exports = { buildCensus, diffCensus, formatCensusReport, formatDriftReport };
