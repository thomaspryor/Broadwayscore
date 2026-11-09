/**
 * health-first-seen.js — how long has each health warning been there? (BRO-7040)
 *
 * The morning digest used to list a warning the first morning it appeared. Two
 * of the three warnings on 2026-11-05 were self-latching conditions that
 * cleared on their own, so the owner was told about problems that were gone by
 * the next day. The digest now holds a WARNING back until it has lasted
 * SETTLE_HOURS, and says so when something it showed has cleared.
 *
 * This module is the pure bookkeeping. health-check.js calls updateFirstSeen()
 * once per run and stores the result in health-check-history.json
 * (`firstSeen`, `cleared`); the digest snapshot then carries `firstSeen` on
 * each row and a `cleared` list.
 *
 * Fail-safe direction: unknown age means SHOW. A row with no firstSeen, a
 * missing state file or an unparseable date is never held back. Errors are
 * never held back at all (see isSettling).
 */
'use strict';

const SETTLE_HOURS = 48;
// A cleared row that comes back within this window keeps its ORIGINAL clock,
// so a condition that flaps every few days cannot hide behind the hold
// (it is shown at once, the fail-safe direction).
const REAPPEAR_KEEP_HOURS = 7 * 24;
// "Cleared since yesterday" only mentions rows that cleared this recently.
const CLEAR_REPORT_HOURS = 36;
const HOUR_MS = 60 * 60 * 1000;

// A very old date used to seed rows the first time this runs: everything that
// is already a warning on rollout day is treated as old, so nothing is hidden.
const LEGACY_SEED = '1970-01-01T00:00:00.000Z';

function isOpen(r) {
  return !!r && typeof r.name === 'string' && (r.status === 'warn' || r.status === 'error');
}

/**
 * @param {{firstSeen?: Object<string,string>, cleared?: Object<string,{at:string,firstSeen:string,status?:string}>}} prev
 * @param {Array<{name:string,status:string}>} results  this run's health results
 * @param {string} nowIso
 * @returns {{firstSeen: Object<string,string>, cleared: Object<string,{at:string,firstSeen:string,status:string}>, openStatus: Object<string,string>}}
 *   the result has the same shape as the persisted history keys, so it can be fed back as `prev`
 */
function updateFirstSeen(prev, results, nowIso) {
  const now = Date.parse(nowIso);
  const bootstrap = !prev || typeof prev.firstSeen !== 'object' || prev.firstSeen === null;
  const prevSeen = bootstrap ? {} : prev.firstSeen;
  const prevCleared = (prev && typeof prev.cleared === 'object' && prev.cleared) || {};
  // history.openStatus: name -> 'warn'|'error' as of the previous run.
  const prevStatus = (prev && typeof prev.openStatus === 'object' && prev.openStatus) || {};

  const open = new Map();
  for (const r of Array.isArray(results) ? results : []) if (isOpen(r)) open.set(r.name, r.status);

  const firstSeen = {};
  const status = {};
  for (const [name, st] of open) {
    status[name] = st;
    if (bootstrap) { firstSeen[name] = LEGACY_SEED; continue; }
    if (prevSeen[name]) { firstSeen[name] = prevSeen[name]; continue; }
    const c = prevCleared[name];
    if (c && Number.isFinite(now) && now - Date.parse(c.at) <= REAPPEAR_KEEP_HOURS * HOUR_MS && c.firstSeen) {
      firstSeen[name] = c.firstSeen; // flapped back: keep the original clock
    } else {
      firstSeen[name] = nowIso;
    }
  }

  const cleared = {};
  // Newly cleared this run: was open before, is not now.
  for (const name of Object.keys(prevSeen)) {
    if (!open.has(name)) cleared[name] = { at: nowIso, firstSeen: prevSeen[name], status: prevStatus[name] || 'warn' };
  }
  // Earlier clears stay listed for REAPPEAR_KEEP_HOURS, unless they are open again.
  for (const [name, c] of Object.entries(prevCleared)) {
    if (open.has(name) || cleared[name] || !c || !c.at) continue;
    if (Number.isFinite(now) && now - Date.parse(c.at) <= REAPPEAR_KEEP_HOURS * HOUR_MS) cleared[name] = c;
  }
  return { firstSeen, cleared, openStatus: status };
}

function ageHours(firstSeenIso, nowMs) {
  const t = Date.parse(firstSeenIso);
  if (!Number.isFinite(t) || !Number.isFinite(nowMs)) return null;
  return (nowMs - t) / HOUR_MS;
}

/** True only for a WARNING whose known age is under SETTLE_HOURS. */
function isSettling(row, severity, nowMs) {
  if (severity === 'error') return false;
  // An expired login only the owner can fix is never held back.
  if (row && (row.loginSource === true || /^Login expired:/.test(String(row.name || '')))) return false;
  const age = ageHours(row && row.firstSeen, nowMs);
  return age !== null && age >= 0 && age < SETTLE_HOURS;
}

/**
 * Which cleared rows are worth telling the owner about: only ones the email
 * could have shown (an error, or a warning that outlasted the hold).
 * @returns {Array<{name:string, daysOpen:number}>}
 */
function reportableCleared(cleared, nowMs) {
  const out = [];
  for (const [name, c] of Object.entries(cleared || {})) {
    if (!c || !c.at) continue;
    const sinceClear = (nowMs - Date.parse(c.at)) / HOUR_MS;
    if (Number.isFinite(sinceClear) && sinceClear > CLEAR_REPORT_HOURS) continue;
    const open = Date.parse(c.at) - Date.parse(c.firstSeen);
    const wasShown = c.status === 'error' || !(open >= 0 && open < SETTLE_HOURS * HOUR_MS);
    if (wasShown) out.push({ name, daysOpen: Number.isFinite(open) && open > 0 ? Math.max(1, Math.round(open / (24 * HOUR_MS))) : 0 });
  }
  return out;
}

module.exports = { SETTLE_HOURS, REAPPEAR_KEEP_HOURS, CLEAR_REPORT_HOURS, LEGACY_SEED, updateFirstSeen, ageHours, isSettling, reportableCleared };
