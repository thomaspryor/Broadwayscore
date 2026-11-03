/**
 * Pure (write-free) helpers for data/show-schedule-history.json (BRO-6877):
 * the push-conflict union merger used by core-data-merge-registry.js and
 * push-with-retry.sh, plus the pruning it shares with
 * scripts/lib/show-schedule-history.js. No fs access here: the push audits
 * load the registry, and their require graph must stay write-free.
 */
function emptyHistory() {
  return { lastUpdated: null, firstWeek: null, lastWeek: null, shows: {} };
}

/**
 * Drop weeks that have not started yet (after lastMonday) and refresh
 * metadata. Never prunes below an earlier lastWeek: the two writers compute
 * "this Monday" differently (bwayrush in ET, TodayTix in the runner's UTC), so
 * a cutoff can step back a week and must not delete weeks already archived.
 */
function pruneAfter(history, lastMonday) {
  if (history.lastWeek && (!lastMonday || lastMonday < history.lastWeek)) lastMonday = history.lastWeek;
  let first = null;
  for (const [showId, sched] of Object.entries(history.shows)) {
    for (const key of Object.keys(sched.weeks)) {
      if (lastMonday && key > lastMonday) delete sched.weeks[key];
      else if (!first || key < first) first = key;
    }
    if (!Object.keys(sched.weeks).length) delete history.shows[showId];
  }
  history.firstWeek = first;
  history.lastWeek = lastMonday || history.lastWeek || null;
  return history;
}

/**
 * Push-conflict merge (core-data-merge-registry.js, push-with-retry.sh): the
 * two writers race on a Monday rollover. Union per show-week; ours (this run)
 * wins on a shared week. Returns { merged } (registry contract).
 */
function mergeShowScheduleHistory(ours, remote) {
  ours = ours && ours.shows ? ours : emptyHistory();
  remote = remote && remote.shows ? remote : emptyHistory();
  const merged = { ...remote, ...ours, shows: {} };
  for (const id of new Set([...Object.keys(remote.shows), ...Object.keys(ours.shows)])) {
    merged.shows[id] = { weeks: { ...(remote.shows[id]?.weeks || {}), ...(ours.shows[id]?.weeks || {}) } };
  }
  const max = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
  merged.lastUpdated = max(ours.lastUpdated, remote.lastUpdated);
  merged.lastWeek = max(ours.lastWeek, remote.lastWeek);
  pruneAfter(merged, merged.lastWeek);
  return { merged };
}

/**
 * Whole weeks the archive's lastWeek trails the live file's currentMonday
 * (both YYYYMMDD Mondays). 0 when current; null when either is missing or
 * not a real date. Positive: the writers stopped archiving. Negative: the
 * live file's currentMonday went backwards (a stale writer). validate-data.js
 * warns on anything but 0.
 */
function archiveLagWeeks(history, currentMonday) {
  const last = history && history.lastWeek;
  if (!/^\d{8}$/.test(String(last || '')) || !/^\d{8}$/.test(String(currentMonday || ''))) return null;
  const t = (k) => {
    const ms = Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
    return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '') === k ? ms : NaN;
  };
  const weeks = Math.round((t(currentMonday) - t(last)) / (7 * 864e5));
  return Number.isFinite(weeks) ? weeks : null;
}

module.exports = { emptyHistory, pruneAfter, mergeShowScheduleHistory, archiveLagWeeks };
