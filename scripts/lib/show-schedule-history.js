/**
 * Past-week showtime archive (BRO-6877).
 *
 * data/show-schedules.json is a rolling window (current week + ~7 future
 * weeks); every refresh drops the week that just ended, and a show that
 * closes is removed outright. This module keeps every week that has started
 * in data/show-schedule-history.json, append-only, so a diary entry for a
 * past date can still show the real curtain time.
 *
 * Shape (same per-show shape as show-schedules.json):
 *   { lastUpdated, firstWeek, lastWeek, shows: { id: { weeks: { YYYYMMDD: [7 x {m,e}] } } } }
 * lastWeek is inclusive: no archived week starts after it. The current week
 * is archived too (a show removed mid-week, e.g. on closing, keeps its final
 * week); later refreshes overwrite it until it ends.
 *
 * Merge rule (per day): a snapshot is authoritative for days on or after the
 * day it was taken, so a later snapshot overwrites them. For days already past
 * when it was taken it only fills missing times, never blanks or replaces one. An
 * empty day in the archive therefore means "no performance known", which the
 * client never treats as a confirmed dark day.
 */
const fs = require('fs');
const path = require('path');

// Pure merge helpers live in a write-free module so the push audits can load
// them (safe-form-allowlist.test.mjs).
const { emptyHistory, pruneAfter, mergeShowScheduleHistory } = require('./merge-show-schedule-history');

const HISTORY_PATH = path.join(__dirname, '..', '..', 'data', 'show-schedule-history.json');
const WEEK_KEY = /^\d{8}$/;

function loadHistory(file = HISTORY_PATH) {
  if (!fs.existsSync(file)) return emptyHistory();
  const h = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!h || typeof h !== 'object' || !h.shows) throw new Error(`${file}: not a schedule history file`);
  return h;
}

function isValidWeek(week) {
  return Array.isArray(week) && week.length === 7
    && week.every((d) => d && typeof d === 'object' && 'm' in d && 'e' in d);
}

function normaliseWeek(week) {
  return week.map((d) => ({ m: d.m || null, e: d.e || null }));
}

/** YYYYMMDD of the day `i` days after week key `key` (calendar math, no timezone). */
function dayKey(key, i) {
  const d = new Date(Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8) + i));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** The calendar day a snapshot was taken (YYYYMMDD), or null if it doesn't say. */
function snapshotDay(snapshot) {
  const iso = String(snapshot.lastUpdated || '');
  if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10).replace(/-/g, '');
  return WEEK_KEY.test(String(snapshot.currentMonday || '')) ? snapshot.currentMonday : null;
}

/**
 * Merge one show-schedules.json snapshot into history (mutates it), day by
 * day. Only weeks starting on/before uptoMonday are taken (default: all).
 *
 * A snapshot is authoritative for days on/after the day it was taken (its
 * latest knowledge of upcoming performances, including "dark"). For days
 * already past when it was taken it only fills a missing time, never blanks
 * or replaces one: TodayTix-sourced shows are rebuilt mid-week from today's
 * listings, so their past days come through empty (BRO-6877 review P1).
 * Returns { added, updated } counts of show-weeks.
 */
function mergeSnapshot(history, snapshot, uptoMonday = null) {
  const stats = { added: 0, updated: 0 };
  if (!snapshot || !snapshot.shows) return stats;
  const asOf = snapshotDay(snapshot);
  for (const [showId, sched] of Object.entries(snapshot.shows)) {
    if (!sched || !sched.weeks) continue;
    for (const [key, week] of Object.entries(sched.weeks)) {
      if (!WEEK_KEY.test(key) || !isValidWeek(week)) continue;
      if (uptoMonday && key > uptoMonday) continue;
      const incoming = normaliseWeek(week);
      const existing = history.shows[showId]?.weeks[key];
      const next = existing ? existing.map((d) => ({ ...d })) : incoming.map(() => ({ m: null, e: null }));
      incoming.forEach((d, i) => {
        if (asOf && dayKey(key, i) >= asOf) next[i] = d;
        else next[i] = { m: next[i].m || d.m, e: next[i].e || d.e };
      });
      if (!existing) stats.added++;
      else if (JSON.stringify(existing) !== JSON.stringify(next)) stats.updated++;
      else continue;
      (history.shows[showId] ||= { weeks: {} }).weeks[key] = next;
    }
  }
  return stats;
}

/**
 * The refresh hook: before a writer replaces show-schedules.json, fold the
 * outgoing file's started weeks (on/before newCurrentMonday) into the archive.
 */
function archiveOutgoingSchedule(oldSnapshot, newCurrentMonday, { file = HISTORY_PATH, dryRun = false } = {}) {
  const history = loadHistory(file);
  const upto = history.lastWeek && history.lastWeek > newCurrentMonday ? history.lastWeek : newCurrentMonday;
  const stats = mergeSnapshot(history, oldSnapshot, upto);
  const lastBefore = history.lastWeek;
  pruneAfter(history, newCurrentMonday);
  if (stats.added || stats.updated || history.lastWeek !== lastBefore || !fs.existsSync(file)) {
    history.lastUpdated = new Date().toISOString();
    if (!dryRun) writeHistory(history, file);
  }
  return { ...stats, shows: Object.keys(history.shows).length };
}

/** One week per line: readable, small git diffs, still plain JSON. */
function serialise(history) {
  const ids = Object.keys(history.shows).sort();
  const showBlocks = ids.map((id) => {
    const weeks = history.shows[id].weeks;
    const lines = Object.keys(weeks).sort().map((k) => `        ${JSON.stringify(k)}: ${JSON.stringify(weeks[k])}`);
    return `    ${JSON.stringify(id)}: {\n      "weeks": {\n${lines.join(',\n')}\n      }\n    }`;
  });
  return '{\n'
    + `  "lastUpdated": ${JSON.stringify(history.lastUpdated)},\n`
    + `  "firstWeek": ${JSON.stringify(history.firstWeek)},\n`
    + `  "lastWeek": ${JSON.stringify(history.lastWeek)},\n`
    + `  "shows": {\n${showBlocks.join(',\n')}\n  }\n}\n`;
}

function writeHistory(history, file = HISTORY_PATH) {
  const text = serialise(history);
  JSON.parse(text); // never write a file we can't read back
  fs.writeFileSync(file, text);
}

module.exports = {
  HISTORY_PATH,
  emptyHistory,
  loadHistory,
  mergeSnapshot,
  dayKey,
  pruneAfter,
  archiveOutgoingSchedule,
  mergeShowScheduleHistory,
  serialise,
  writeHistory,
};
