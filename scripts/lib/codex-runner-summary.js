'use strict';
// BRO-6303: the Codex runner summary's heading and the facts read back from it (landed, rejected,
// crashed, ...). The trust ladder grades Codex on these, so this file is on the ladder's protected
// list (codex-trust-ladder.js isProtectedPath): the runner never lands a Codex edit to it.
// Moved verbatim from codex-runner.js, which re-exports them.

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

module.exports = { summaryHeading, SUMMARY_HEADING_RE, parseSummaryHeading, runnerSummaryFacts };
