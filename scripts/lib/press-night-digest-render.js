'use strict';
/**
 * press-night-digest-render.js — "Last night's openings" in the owner's morning email (BRO-6645), plus the
 * New York time helpers it shares with scripts/lib/press-night-digest.js. Node built-ins only: it is loaded
 * by send-morning-digest.js, whose workflow runs without npm ci (tests/unit/morning-digest-action.test.mjs).
 */

const TZ = 'America/New_York';

/** "1:24am" in New York time. */
function etTime(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '?';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get('hour')}:${get('minute')}${String(get('dayPeriod') || '').toLowerCase()}`;
}

/** YYYY-MM-DD of `ms` in New York. */
function etDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** The press night a morning email on `nowMs` reports: yesterday, New York time. */
function lastNight(nowMs) {
  const d = new Date(`${etDate(nowMs)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Morning email block ──────────────────────────────────────────────────────

const defaultEsc = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Each line already ends in its verdict, so the marker is only a colored dot.
const DOT = { PASS: '#15803d', FAIL: '#b91c1c', UNKNOWN: '#999', PENDING: '#999' };

/**
 * "Last night's openings" for send-morning-digest.js, from the press-night-digest snapshot. Renders nothing on
 * a night with no openings, or when the snapshot is about an older night than the email's last night.
 */
function renderPressNightBlock(snapshot, { esc = defaultEsc, nowMs = Date.now() } = {}) {
  if (!snapshot || !Array.isArray(snapshot.lines)) return '';
  if (snapshot.night !== lastNight(nowMs)) {
    // The hourly grade has not run since yesterday (GitHub delays the schedule): say so, never go quiet.
    return `<div style="margin:0 0 16px;font-size:14px;"><b>Last night's openings:</b> not checked yet (the hourly check has not run since yesterday).</div>`;
  }
  if (!snapshot.lines.length) return '';
  const rows = snapshot.lines.map((l) => {
    return `<div style="margin:0 0 8px;font-size:14px;"><span style="color:${DOT[l.verdict] || DOT.UNKNOWN};">&#9679;</span> ${esc(l.line)}</div>`;
  }).join('\n');
  return `<div style="margin:0 0 16px;">
    <p style="font-size:14px;font-weight:700;margin:0 0 8px;">Last night's openings</p>
    ${rows}
  </div>`;
}

module.exports = { etTime, etDate, lastNight, renderPressNightBlock };
