/**
 * Past-week showtime archive (BRO-6877).
 *
 * data/show-schedules.json is a rolling window (current week + ~7 future
 * weeks); every refresh drops the week that just ended. This module keeps
 * those weeks in data/show-schedule-history.json, append-only, so a diary
 * entry for a past date can still show the real curtain time.
 *
 * Shape (same per-show shape as show-schedules.json, past weeks only):
 *   { lastUpdated, firstWeek, throughMonday, shows: { id: { weeks: { YYYYMMDD: [7 x {m,e}] } } } }
 * throughMonday is exclusive: every archived week starts before it.
 *
 * Merge rule: a snapshot is authoritative for weeks on or after its own
 * currentMonday (those were live schedule data when it was taken), so a later
 * snapshot overwrites them. Weeks before a snapshot's currentMonday are
 * leftovers (TodayTix-sourced shows keep old weeks); they only fill gaps.
 */
const fs = require('fs');
const path = require('path');

const HISTORY_PATH = path.join(__dirname, '..', '..', 'data', 'show-schedule-history.json');
const WEEK_KEY = /^\d{8}$/;

function emptyHistory() {
  return { lastUpdated: null, firstWeek: null, throughMonday: null, shows: {} };
}

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

/**
 * Merge one show-schedules.json snapshot into history (mutates and returns it).
 * Returns { added, updated } counts of show-weeks.
 */
function mergeSnapshot(history, snapshot) {
  const stats = { added: 0, updated: 0 };
  if (!snapshot || !snapshot.shows) return stats;
  const snapMonday = WEEK_KEY.test(String(snapshot.currentMonday || '')) ? snapshot.currentMonday : null;
  for (const [showId, sched] of Object.entries(snapshot.shows)) {
    if (!sched || !sched.weeks) continue;
    for (const [key, week] of Object.entries(sched.weeks)) {
      if (!WEEK_KEY.test(key) || !isValidWeek(week)) continue;
      const authoritative = snapMonday ? key >= snapMonday : false;
      const target = (history.shows[showId] ||= { weeks: {} });
      const existing = target.weeks[key];
      if (existing && !authoritative) continue;
      const next = normaliseWeek(week);
      if (!existing) stats.added++;
      else if (JSON.stringify(existing) !== JSON.stringify(next)) stats.updated++;
      else continue;
      target.weeks[key] = next;
    }
  }
  return stats;
}

/**
 * Drop weeks on/after cutoffMonday (they are still in the live file) and
 * refresh metadata. Never prunes below an earlier throughMonday: the two
 * writers compute "this Monday" differently (bwayrush in ET, TodayTix in the
 * runner's UTC), so a cutoff can step back a week and must not delete
 * weeks the archive already owns.
 */
function pruneFrom(history, cutoffMonday) {
  if (history.throughMonday && cutoffMonday && cutoffMonday < history.throughMonday) {
    cutoffMonday = history.throughMonday;
  }
  let first = null;
  for (const [showId, sched] of Object.entries(history.shows)) {
    for (const key of Object.keys(sched.weeks)) {
      if (cutoffMonday && key >= cutoffMonday) delete sched.weeks[key];
      else if (!first || key < first) first = key;
    }
    if (!Object.keys(sched.weeks).length) delete history.shows[showId];
  }
  history.firstWeek = first;
  if (cutoffMonday && (!history.throughMonday || cutoffMonday > history.throughMonday)) {
    history.throughMonday = cutoffMonday;
  }
  return history;
}

/**
 * The refresh hook: before a writer replaces show-schedules.json, fold the
 * outgoing file's weeks into the archive. Weeks before newCurrentMonday are
 * kept; the rest are still live in the new file.
 */
function archiveOutgoingSchedule(oldSnapshot, newCurrentMonday, { file = HISTORY_PATH, dryRun = false } = {}) {
  const history = loadHistory(file);
  // Only weeks the new file no longer carries; counts then mean "archived".
  const cutoff = history.throughMonday && history.throughMonday > newCurrentMonday ? history.throughMonday : newCurrentMonday;
  const ended = { currentMonday: oldSnapshot && oldSnapshot.currentMonday, shows: {} };
  for (const [id, sched] of Object.entries((oldSnapshot && oldSnapshot.shows) || {})) {
    const weeks = Object.fromEntries(Object.entries((sched && sched.weeks) || {}).filter(([k]) => k < cutoff));
    if (Object.keys(weeks).length) ended.shows[id] = { weeks };
  }
  const stats = mergeSnapshot(history, ended);
  pruneFrom(history, newCurrentMonday);
  if (stats.added || stats.updated || !fs.existsSync(file)) {
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
    + `  "throughMonday": ${JSON.stringify(history.throughMonday)},\n`
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
  pruneFrom,
  archiveOutgoingSchedule,
  serialise,
  writeHistory,
};
