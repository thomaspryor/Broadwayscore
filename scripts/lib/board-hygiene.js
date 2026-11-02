'use strict';
/**
 * board-hygiene.js (BRO-6857) — PURE planners behind scripts/board-hygiene-sweep.js.
 *   planProseStamps  parked cards whose reason waits on time in words -> the RECHECK-AFTER date to stamp
 *   planMachineLogs  machine-filed records ("routine audit log") sitting in Backlog -> close with a reason
 *   planAgeSweep     open cards created more than 30 days ago -> dispatch / needs-VERIFY / reconfirm, each with a reason
 * Nothing here talks to Linear. Cards are board-categories OPEN_BOARD_QUERY rows.
 */
const { proseDateWait } = require('./prose-date-wait.js');
const { parseRecheckAfterFromCard } = require('./recheck-stamp.js');

const DAY = 86400e3;
const AGE_DAYS = 30;
const PARKED_RE = /^\s*PARKED\s*:(.*)$/gim;
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, several: 3, few: 3 };
const UNIT_DAYS = { hour: 1, day: 1, night: 1, week: 7, month: 30, run: 1 };
// Cards that are storage or trackers, never work: the sweep leaves them alone.
const KEEP_RE = /\b(?:do not close|automation storage|tracker card|not work)\b/i;
const AUDIT_LOG_RE = /\broutine audit log\b/i;

const parkReasons = (d) => [...String(d || '').matchAll(PARKED_RE)].map((m) => m[1].trim());
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const bodies = (c) => ((c.comments && c.comments.nodes) || []).map((x) => String(x.body || ''));
const stampOf = (c) => parseRecheckAfterFromCard({ comments: bodies(c), notes: String(c.description || '') });
const stateName = (c) => String(c.state && c.state.name || '');

/** -> ms of the day a prose wait ends. A written date wins (the latest one); else "N units" from the card's last touch. */
function waitEnd(reason, anchorMs) {
  const dates = [...String(reason).matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((m) => Date.parse(`${m[1]}T00:00:00Z`)).filter(Number.isFinite);
  if (dates.length) return Math.max(...dates);
  const m = /\b(?:about |around |at least |another |roughly )?(\d+|an?|one|two|three|four|five|six|seven|several|few)\s+(hour|day|night|week|month|run)s?\b/i.exec(reason);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUM[m[1].toLowerCase()];
    return anchorMs + n * UNIT_DAYS[m[2].toLowerCase()] * DAY;
  }
  return anchorMs + 7 * DAY;
}

/** -> [{identifier, date, reason}] one per open card that waits on prose time and carries no stamp. */
function planProseStamps(cards, nowMs) {
  const out = [];
  for (const c of cards) {
    if (!/^(Backlog|Paused|Todo)$/.test(stateName(c))) continue;
    const reason = parkReasons(c.description).find((r) => proseDateWait(r));
    if (!reason || stampOf(c) != null) continue;
    const anchor = Date.parse(c.updatedAt) || Date.parse(c.createdAt) || nowMs;
    // Never earlier than tomorrow: a stamp on today would fire the recheck before the wait is over.
    const end = Math.max(waitEnd(reason, anchor), nowMs + DAY);
    out.push({ identifier: c.identifier, title: c.title, date: isoDay(end), reason: reason.slice(0, 140) });
  }
  return out;
}

/** -> [{identifier, reason}] Backlog records that are logs, not work. */
function planMachineLogs(cards) {
  return cards
    .filter((c) => stateName(c) === 'Backlog' && !KEEP_RE.test(String(c.description || '')) && (parkReasons(c.description).some((r) => AUDIT_LOG_RE.test(r)) || AUDIT_LOG_RE.test(c.title || '')))
    .map((c) => ({ identifier: c.identifier, title: c.title, reason: 'Closed by the board age rules (BRO-6857): a routine audit log is a record of one run, not work; the audit files a new one each run and its ledger holds this one.' }));
}

const RECONFIRM_RE = /^AGE-SWEEP-RECONFIRMED:\s*(\d{4}-\d{2}-\d{2})/m;
/** ms of the newest reconfirm comment on the card, or null. */
function lastReconfirm(c) {
  const ts = bodies(c).map((b) => RECONFIRM_RE.exec(b)).filter(Boolean).map((m) => Date.parse(`${m[1]}T00:00:00Z`)).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : null;
}

/**
 * Age sweep. -> { dispatch, needsVerify, reconfirm, skipped } of {identifier, title, reason, ...}.
 * Old = created more than AGE_DAYS ago (updatedAt is no use: automation comments bump it on every card). Never touches a
 * started card, a card with a stamp, storage/tracker cards, or one reconfirmed in the last AGE_DAYS. The sweep never closes:
 * a stale card is usually a real defect, and closing one is a per-card judgment a session makes with the card open.
 *   dispatch     Backlog, no park reason, a VERIFY line, Medium priority or better -> Todo (a worker can take it)
 *   needsVerify  Backlog/Todo, no park reason, no VERIFY: technical work nobody can pick up until it has a VERIFY (or is closed)
 *   reconfirm    everything else (parked, Paused, ...): a dated comment says it was looked at and why it stays
 */
function planAgeSweep(cards, nowMs, { verifyOf = (c) => (/^\s*VERIFY:\s*(\S.*)$/im.exec(String(c.description || '')) || [])[1] || '' } = {}) {
  const out = { dispatch: [], needsVerify: [], reconfirm: [], skipped: [] };
  for (const c of cards) {
    const created = Date.parse(c.createdAt);
    if (!(nowMs - created > AGE_DAYS * DAY)) continue;
    const row = { identifier: c.identifier, title: c.title, state: stateName(c), priority: Number(c.priority) || 0, ageDays: Math.round((nowMs - created) / DAY) };
    const re = lastReconfirm(c);
    if ((c.state && c.state.type) === 'started') { out.skipped.push({ ...row, reason: 'being worked' }); continue; }
    if (KEEP_RE.test(String(c.description || ''))) { out.skipped.push({ ...row, reason: 'storage or tracker card' }); continue; }
    if (stampOf(c) != null) { out.skipped.push({ ...row, reason: 'has a RECHECK-AFTER stamp' }); continue; }
    if (re != null && nowMs - re < AGE_DAYS * DAY) { out.skipped.push({ ...row, reason: 'reconfirmed in the last 30 days' }); continue; }
    const parked = parkReasons(c.description).length > 0;
    const verify = verifyOf(c);
    const open = /^(Backlog|Todo)$/.test(stateName(c));
    if (stateName(c) === 'Todo' && verify) { out.skipped.push({ ...row, reason: 'in the worker queue with a VERIFY' }); continue; }
    if (stateName(c) === 'Backlog' && !parked && verify && row.priority >= 1 && row.priority <= 3) {
      out.dispatch.push({ ...row, reason: `Backlog for ${row.ageDays} days with a VERIFY and no block: moved to Todo so a worker takes it.` });
    } else if (open && !parked && !verify) {
      out.needsVerify.push({ ...row, reason: 'technical work with no VERIFY line, so no worker can pick it up: add a VERIFY command or close it with a reason.' });
    } else {
      out.reconfirm.push({ ...row, reason: parked ? 'has a park reason' : 'Paused or otherwise held' });
    }
  }
  return out;
}

module.exports = { planProseStamps, planMachineLogs, planAgeSweep, waitEnd, lastReconfirm, AGE_DAYS, KEEP_RE };
