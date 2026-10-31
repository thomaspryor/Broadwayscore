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

/**
 * BRO-2320: measure how often the explainExclusion() MIRROR disagrees with
 * what rebuild-all-reviews.js actually did. Ground truth is the rebuild's own
 * per-show exclusion list (data/audit/rebuild-exclusions-{showId}.json,
 * written by the same job, same snapshot of review-texts): a file listed
 * there was excluded by the real gate, with the real statKey.
 *
 * A show is compared only when the rebuild demonstrably processed it: it has
 * an exclusions list, or it appears in the rebuild's output (processedShowIds,
 * shows present in reviews.json, whose files with no exclusion entry were
 * included). Shows skipped wholesale (no output, no list) are not compared.
 *
 * BRO-5129: a record may carry `alignedRule`, explainExclusion() run with the
 * rebuild's own list (opts.rebuildExclusions) so the cross-file dedup and
 * score-state passes a per-file mirror cannot see are not counted as
 * disagreements. When present it is what gets compared; `rule` (the plain
 * mirror) still feeds buildCensus, so the committed per-rule counts stay
 * continuous.
 *
 * @param {Array<{showId: string, file: string, rule: string|null, alignedRule?: string|null}>} records
 * @param {{ rebuildExcludedByShow: Record<string, Record<string, string>>,
 *           processedShowIds?: Set<string>|string[], exampleLimit?: number }} opts
 *   rebuildExcludedByShow: { showId: { file: statKey } }
 */
function compareToRebuildExclusions(records, { rebuildExcludedByShow = {}, processedShowIds = [], exampleLimit = 5 } = {}) {
  const processed = processedShowIds instanceof Set ? processedShowIds : new Set(processedShowIds);
  const mirrorOnlyByRule = Object.create(null);
  const rebuildOnlyByReason = Object.create(null);
  const disagreeByShow = Object.create(null);
  const examples = { mirrorOnly: [], rebuildOnly: [] };
  const comparedShows = new Set();
  const seen = new Set();
  const notComparedShows = new Set();
  let notComparedFiles = 0;
  let compared = 0;
  let agreeExcluded = 0;
  let agreeIncluded = 0;
  let mirrorOnly = 0;
  let rebuildOnly = 0;

  for (const rec of records) {
    const { showId, file } = rec;
    const rule = rec.alignedRule !== undefined ? rec.alignedRule : rec.rule;
    const showList = Object.prototype.hasOwnProperty.call(rebuildExcludedByShow, showId)
      ? rebuildExcludedByShow[showId] : null;
    if (!showList && !processed.has(showId)) {
      // Reported, not silently dropped: a show the rebuild left no trace of
      // (whole-show skip, or a missing artifact) is outside the comparison.
      notComparedShows.add(showId);
      notComparedFiles++;
      continue;
    }
    comparedShows.add(showId);
    compared++;
    seen.add(`${showId}/${file}`);
    const reason = showList && Object.prototype.hasOwnProperty.call(showList, file) ? showList[file] : null;
    const mirrorExcluded = rule !== null && rule !== undefined;
    if (mirrorExcluded && reason) { agreeExcluded++; continue; }
    if (!mirrorExcluded && !reason) { agreeIncluded++; continue; }
    disagreeByShow[showId] = (disagreeByShow[showId] || 0) + 1;
    if (mirrorExcluded) {
      mirrorOnly++;
      mirrorOnlyByRule[rule] = (mirrorOnlyByRule[rule] || 0) + 1;
      if (examples.mirrorOnly.length < exampleLimit) examples.mirrorOnly.push({ showId, file, rule });
    } else {
      rebuildOnly++;
      rebuildOnlyByReason[reason] = (rebuildOnlyByReason[reason] || 0) + 1;
      if (examples.rebuildOnly.length < exampleLimit) examples.rebuildOnly.push({ showId, file, reason });
    }
  }

  // Rebuild exclusions for files the census never scanned (e.g. a file the
  // rebuild read that failed to parse here): reported, not counted as compared.
  let rebuildEntriesUnscanned = 0;
  for (const [showId, files] of Object.entries(rebuildExcludedByShow)) {
    for (const file of Object.keys(files)) if (!seen.has(`${showId}/${file}`)) rebuildEntriesUnscanned++;
  }

  const sortCounts = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const disagreements = mirrorOnly + rebuildOnly;
  return {
    comparedShows: comparedShows.size,
    comparedFiles: compared,
    agreeExcluded,
    agreeIncluded,
    mirrorOnly,
    rebuildOnly,
    disagreements,
    disagreementRate: compared ? Number((disagreements / compared).toFixed(4)) : 0,
    mirrorOnlyByRule: sortCounts(mirrorOnlyByRule),
    rebuildOnlyByReason: sortCounts(rebuildOnlyByReason),
    topShows: Object.entries(disagreeByShow).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
      .map(([showId, count]) => ({ showId, count })),
    rebuildEntriesUnscanned,
    notComparedShows: notComparedShows.size,
    notComparedFiles,
    examples,
  };
}

function formatMirrorReport(cmp, { limit = 5 } = {}) {
  const pct = (cmp.disagreementRate * 100).toFixed(2);
  const lines = [
    `Compared ${cmp.comparedFiles} files across ${cmp.comparedShows} shows: ${cmp.disagreements} disagreements (${pct}%)`,
    `  mirror excludes, rebuild included: ${cmp.mirrorOnly}`,
    ...Object.entries(cmp.mirrorOnlyByRule).slice(0, limit).map(([r, n]) => `      ${r}: ${n}`),
    `  rebuild excluded, mirror includes: ${cmp.rebuildOnly}`,
    ...Object.entries(cmp.rebuildOnlyByReason).slice(0, limit).map(([r, n]) => `      ${r}: ${n}`),
  ];
  if (cmp.topShows.length) lines.push(`  top shows: ${cmp.topShows.map((s) => `${s.showId} (${s.count})`).join(', ')}`);
  for (const e of cmp.examples.mirrorOnly) lines.push(`  e.g. mirror-only ${e.rule}: ${e.showId}/${e.file}`);
  for (const e of cmp.examples.rebuildOnly) lines.push(`  e.g. rebuild-only ${e.reason}: ${e.showId}/${e.file}`);
  if (cmp.notComparedFiles) lines.push(`  not compared (no rebuild output or exclusion list): ${cmp.notComparedFiles} files across ${cmp.notComparedShows} shows`);
  if (cmp.rebuildEntriesUnscanned) lines.push(`  rebuild exclusions for files the census did not scan: ${cmp.rebuildEntriesUnscanned}`);
  return lines.join('\n');
}

/**
 * BRO-2321: the small, committed mirror summary (counts only, no filenames)
 * that check-corpus-drift.js reads without rescanning the corpus. `previous`
 * is the prior summary; per-rule deltas are computed against its counts.
 */
function buildMirrorSummary(census, comparison, previous, now = new Date()) {
  const ruleCounts = Object.fromEntries(Object.entries(census.byRule || {})
    .map(([rule, v]) => [rule, v.count]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  const prevCounts = (previous && previous.ruleCounts) || null;
  let ruleDeltas = null;
  if (prevCounts) {
    ruleDeltas = {};
    for (const rule of new Set([...Object.keys(prevCounts), ...Object.keys(ruleCounts)])) {
      const d = (ruleCounts[rule] || 0) - (prevCounts[rule] || 0);
      if (d !== 0) ruleDeltas[rule] = d;
    }
  }
  const mirror = comparison ? (({ examples, topShows, ...rest }) => rest)(comparison) : null; // eslint-disable-line no-unused-vars
  return {
    generatedAt: now.toISOString(),
    totalScanned: census.totalScanned,
    totalExcluded: census.totalExcluded,
    ruleCounts,
    ruleDeltas,
    previousGeneratedAt: previous ? previous.generatedAt || null : null,
    mirror,
    previousDisagreementRate: previous && previous.mirror ? previous.mirror.disagreementRate : null,
  };
}

/**
 * Exit-contract check for check-corpus-drift.js's AUDITS entry. Returns the
 * list of breaches (empty = ok). Thresholds are deltas against the previous
 * summary, so a long-standing, stable disagreement does not alarm daily.
 */
function checkMirrorSummary(summary, { maxRuleDelta = Infinity, maxRateRise = Infinity, maxAgeDays = 3, now = Date.now() } = {}) {
  const breaches = [];
  if (!summary) return ['no mirror summary found (has rebuild-reviews run the census?)'];
  const ageDays = (now - Date.parse(summary.generatedAt)) / 86400000;
  if (!(ageDays <= maxAgeDays)) breaches.push(`mirror summary is stale (generated ${summary.generatedAt}, > ${maxAgeDays}d old)`);
  for (const [rule, d] of Object.entries(summary.ruleDeltas || {})) {
    if (Math.abs(d) > maxRuleDelta) breaches.push(`rule ${rule} moved ${d > 0 ? '+' : ''}${d} (> ${maxRuleDelta})`);
  }
  const rate = summary.mirror ? summary.mirror.disagreementRate : null;
  const prev = summary.previousDisagreementRate;
  if (rate !== null && prev !== null && prev !== undefined && rate - prev > maxRateRise) {
    breaches.push(`mirror disagreement rate rose ${(prev * 100).toFixed(2)}% -> ${(rate * 100).toFixed(2)}% (> +${(maxRateRise * 100).toFixed(2)} pts)`);
  }
  return breaches;
}

function signed(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

module.exports = {
  buildCensus,
  diffCensus,
  formatCensusReport,
  formatDriftReport,
  compareToRebuildExclusions,
  formatMirrorReport,
  buildMirrorSummary,
  checkMirrorSummary,
};
