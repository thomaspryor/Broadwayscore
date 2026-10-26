'use strict';
// BRO-6303: the Codex run summary's format, builder and parser. The trust ladder
// (codex-trust-ladder.js) grades Codex from these summaries, so this file is on its protected-path
// list: the runner never lands a Codex edit to it. A leaf module (no requires), so codex-runner.js,
// the lane alarm and the ladder can all load it without a cycle.

/**
 * Codex lanes (BRO-5730). Each lane owns its own slots, so the cloud routine (cloud) and the
 * GitHub runner (gha) run at the same time without sharing a slot's lock or worktrees.
 */
const LANES = Object.freeze({ cloud: Object.freeze({ base: 0, max: 3 }), gha: Object.freeze({ base: 3, max: 2 }) });

/**
 * The run summary heading (BRO-6139). Before it, a single-slot launch of EITHER lane posted no
 * "(slot N)" and readers took it for the cloud lane; now every summary names its slot and the
 * lane that launched it (a gha launch that fell back to slot 0 is still lane gha).
 */
function summaryHeading({ date, worked, mins, slot = 0, lane = 'cloud' }) {
  return `## Codex runner ${date}: ${worked} card(s) worked in ${mins} min (slot ${Number(slot) || 0}) (lane ${lane})`;
}
const SUMMARY_HEADING_RE = /^## Codex runner (\d{4}-\d{2}-\d{2}): (\d+) card\(s\) worked in (\d+) min/;
/**
 * -> { date, worked, mins, slot, lane } or null (not a run summary). slot is null when the heading
 * has none; lane is null for a summary from before the lane marker (laneOfSummary decides those).
 */
function parseSummaryHeading(body) {
  const head = String(body || '').split('\n')[0];
  const m = head.match(SUMMARY_HEADING_RE);
  if (!m) return null;
  const slot = head.match(/\(slot (\d+)\)/);
  const lane = head.match(/\(lane (cloud|gha)\)/);
  return { date: m[1], worked: Number(m[2]), mins: Number(m[3]), slot: slot ? Number(slot[1]) : null, lane: lane ? lane[1] : null };
}

/**
 * Which lane posted a summary. The marker when present; else slot 3+ is gha and an explicit slot
 * 0-2 is cloud (a gha fallback to slot 0 always ran one slot, so it had no slot). A legacy
 * slotless summary is gha only when a codex-runner.yml run covered its whole "worked in M min"
 * span (ghRuns [{ startMs, endMs }]); a cloud run that merely ended near a 3-min gha stand-down
 * must not count. Without ghRuns it stays cloud, as before. -> 'cloud' | 'gha' | null
 */
function laneOfSummary(body, createdAtMs, ghRuns = null) {
  const h = parseSummaryHeading(body);
  if (!h) return null;
  if (h.lane) return h.lane;
  if (h.slot !== null) return h.slot >= LANES.gha.base ? 'gha' : 'cloud';
  const startedMs = createdAtMs - h.mins * 60_000;
  const SLACK = 5 * 60_000;
  const inGha = Array.isArray(ghRuns) && ghRuns.some((r) => Number.isFinite(r.startMs) && r.startMs <= startedMs + SLACK
    && createdAtMs <= (Number.isFinite(r.endMs) ? r.endMs : Infinity) + SLACK);
  return inGha ? 'gha' : 'cloud';
}

/** The counts one "## Codex runner" summary body reports (the lane alarm, the daily row, the trust ladder). */
function runnerSummaryFacts(body) {
  const list = (label) => {
    const v = (String(body || '').match(new RegExp(`^- ${label}: (.*)$`, 'm')) || [])[1] || 'none';
    return v.trim() === 'none' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
  };
  const landedIds = [...list('Landed and Done'), ...list('Landed part, back to Todo with what is left')];
  return {
    landed: landedIds.length,
    landedIds, // BRO-5671: the ids, for cost per landed card
    rejected: list('Did not pass the Claude check, back to Todo').length, // BRO-6263: rejection rate for the trust ladder
    hasCheckLine: /^- Claude check: \d+ review\(s\), \$[\d.]+/m.test(String(body || '')),
    crashed: list('Runner error mid-card \\(back to Todo\\)').length,
    stop: (String(body || '').match(/^- Stopped early: (.*)$/m) || [])[1] || '',
    checkUsd: Number((String(body || '').match(/^- Claude check: \d+ review\(s\), \$([\d.]+)/m) || [])[1]) || 0,
  };
}

/**
 * The summary body daily-runner.js posts on the runner card. Every line runnerSummaryFacts reads is
 * written here, so the writer and the parser cannot drift apart.
 */
function runnerSummaryText({ heading, stats, worked, skipped, picks, stop, settingsLine, weeklyPct, checkCount, checkSpentUsd, checkByModel, slotShortfall, landedPerLane, ladderLine }) {
  const list = (a) => (a.length ? a.join(', ') : 'none');
  const landedCount = stats.landed.length + stats.landedPartial.length;
  return [
    heading,
    `- Landed and Done: ${list(stats.landed)}`,
    `- Landed part, back to Todo with what is left: ${list(stats.landedPartial)}`,
    `- Already fixed, closed: ${list(stats.alreadyFixed)}`,
    `- Did not pass the Claude check, back to Todo: ${list(stats.bounced)}`,
    `- In Review (the Done gate would not close it): ${list(stats.inReview)}`,
    `- Landing did not finish (left In Progress for resume): ${list(stats.landFailed)}`,
    `- Runner error mid-card (back to Todo): ${list(stats.crashed)}`,
    ...stats.recoveredStops.map((details) => `- Recovered stopped session: ${details}`),
    ...(stats.carried.length ? [`- SHIP-WITH-FIXES, fix round carried to the next run: ${list(stats.carried)}`] : []),
    ...(stats.outOfTime.length ? [`- Out of time before review, not judged (back to Todo): ${list(stats.outOfTime)}`] : []),
    ...(stats.wouldLand.length ? [`- Passed, not landed (--no-land): ${list(stats.wouldLand)}`] : []),
    settingsLine,
    `- Codex weekly allowance used: ${weeklyPct ?? 'unknown'}%`,
    `- Claude check: ${checkCount} review(s), $${checkSpentUsd.toFixed(2)} API cost`,
    // BRO-5384 savings line: what the Codex lane costs in Claude, by model and per landed card.
    `- Claude check by model: ${Object.entries(checkByModel).map(([k, v]) => `${k} ${v.n} ($${v.usd.toFixed(2)})`).join(', ') || 'none'}; per landed card: ${landedCount ? `$${(checkSpentUsd / landedCount).toFixed(2)}` : 'n/a (nothing landed)'}`,
    // A pinned lane shows in the next summary instead of days later (BRO-6129: one slot for 13 h unnoticed).
    ...(slotShortfall ? [`- Slots: ${slotShortfall}`] : []),
    ...(landedPerLane ? [`- Landed on main, last 24h: ${landedPerLane}`] : []),
    ...(ladderLine ? [ladderLine] : []), // BRO-6303: the access the trust ladder gave this run
    `- Stopped early: ${stop || 'no'}`,
    // A run that did no work says why (BRO-6139), so "0 worked, stopped early: no" is never the whole story.
    ...(worked ? [] : [`- Why nothing was worked: ${!picks.length ? 'the picker returned no Codex-fit card' : stop ? 'stopped early (above)' : `all ${picks.length} picked card(s) were skipped (taken by another slot, no longer Todo, or unfit now; see the run log)`}${skipped ? ` (${skipped} skipped)` : ''}`]),
  ].join('\n');
}

module.exports = { LANES, laneOfSummary, summaryHeading, SUMMARY_HEADING_RE, parseSummaryHeading, runnerSummaryFacts, runnerSummaryText };
