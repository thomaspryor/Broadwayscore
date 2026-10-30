'use strict';
/**
 * Renders the morning email's "Last night's openings" block (BRO-6645) from the snapshot that
 * produce-press-night-grade-snapshot.js writes. Kept apart from press-night-digest-line.js on purpose:
 * the morning-digest workflow skips npm ci, and the grading module reaches the scrapers through
 * press-night-record.js -> review-census.js. This file must load only node built-ins
 * (tests/unit/morning-digest-action.test.mjs walks the digest's require graph).
 */

function joinAnd(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The morning email's "Last night's openings" block from the snapshot. Nothing when no night is in the window.
 * Lines are plain text; `esc` escapes them for HTML.
 */
function renderPressNightGradesBlock(snapshot, { esc = (x) => String(x) } = {}) {
  const items = (snapshot && Array.isArray(snapshot.items)) ? snapshot.items : [];
  const board = snapshot && snapshot.scoreboard && snapshot.scoreboard.line;
  if (!items.length) return ''; // the scoreboard alone is not news
  const color = { PASS: '#1a7f37', FAIL: '#b42318' };
  const quiet = items.filter((it) => it.quiet);
  const graded = items.filter((it) => !it.quiet);
  const quietLine = quiet.length
    ? `<p style="font-size:13px;color:#666;margin:0 0 8px;padding-left:11px;">No reviews came out overnight for ${esc(joinAnd(quiet.map((it) => it.title)))}, so there was nothing to grade.</p>`
    : '';
  const rows = graded.map((it) => `<p style="font-size:14px;margin:0 0 8px;${color[it.verdict] ? `border-left:3px solid ${color[it.verdict]};padding-left:8px;` : 'padding-left:11px;'}">${esc(it.line)}</p>`).join('\n');
  return `<div style="margin:0 0 16px;">
    <p style="font-size:14px;font-weight:700;margin:0 0 8px;">Last night's openings <span style="font-weight:400;color:#666;">(times Eastern)</span></p>
    ${board ? `<p style="font-size:14px;margin:0 0 8px;">${esc(board)}</p>` : ''}
    ${rows}
    ${quietLine}
  </div>`;
}

module.exports = { joinAnd, renderPressNightGradesBlock };
