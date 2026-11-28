/**
 * traffic-history.js — the long-running PostHog visit history behind the
 * traffic tiles, the 13-week chart and /admin/traffic (BRO-4136).
 *
 * Why a stored history instead of one long query:
 *   - A 400-day HogQL query over sessions + persons hits PostHog's max
 *     execution time (504, run 36073833190), so long windows are chunked.
 *   - Year over year needs numbers from 12-13 months ago; PostHog may not
 *     keep raw events that long. So each Monday refreshes only the recent
 *     weeks and merges them into a store kept in the PRIVATE data repo
 *     (broadway-scorecard-data: analytics/traffic-history.json). The store,
 *     not PostHog, is the long-term record.
 *
 * Four series, each on its own chunk grid (distinct visitors are not
 * additive, so a chunk must never split the bucket it counts):
 *   daily          per day: visits (sessions) + pageviews   — any 91-day chunks
 *   channelDaily   per day × PostHog channel type: visits   — any 91-day chunks
 *   weeklyVisitors per Monday-week: distinct people         — 13-week, Monday-aligned
 *   monthlyVisitors per calendar month: distinct people     — 3-month, month-aligned
 * Sessions are bucketed by session START but filtered by event time, so a
 * session crossing a chunk edge shows up in both chunks; every chunk keeps
 * only buckets inside its own range, which counts each SESSION once. The
 * pageviews such a session had after midnight fall in the next chunk and are
 * dropped with its row: a handful at each 91-day edge, which only the first
 * backfill has (a weekly refresh is one chunk).
 *
 * The store is replaced wholesale for every bucket at or after the refresh
 * start, and only when ALL four refreshes succeeded (mergeHistory refuses a
 * partial refresh), so a bad Monday never overwrites good history.
 */

const { addDays, mondayOf, addMonths, TRACKING_START } = require('./traffic-metrics');

// Backfill floor: the Monday of the week PostHog tracking began, so the
// first week is whole on the Monday grid.
const TRACKING_FLOOR = mondayOf(TRACKING_START);
// Re-query the last 6 weeks each run: late-ingested events and the current
// partial week settle, everything older is final.
const REFRESH_DAYS = 42;
const CHUNK_DAYS = 91;

function monthStart(iso) { return iso.slice(0, 7) + '-01'; }
function lastDayOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Where this run's refresh starts: the floor for an empty store, else 6 weeks before the store's last day. */
function refreshStart(store, endDate) {
  if (!store || !store.endDate) return TRACKING_FLOOR;
  const from = mondayOf(addDays(store.endDate < endDate ? store.endDate : endDate, -REFRESH_DAYS));
  return from < TRACKING_FLOOR ? TRACKING_FLOOR : from;
}

/** Chunk [from, to] into consecutive ranges of `days` (inclusive ends). */
function dayChunks(from, to, days = CHUNK_DAYS) {
  const out = [];
  for (let s = from; s <= to; s = addDays(s, days)) {
    const e = addDays(s, days - 1);
    out.push({ startDate: s, endDate: e < to ? e : to });
  }
  return out;
}
/** 13-week chunks starting on the Monday of `from`. */
function weekChunks(from, to) { return dayChunks(mondayOf(from), to, 7 * 13); }
/** 3-calendar-month chunks starting on the 1st of `from`'s month. */
function monthChunks(from, to, months = 3) {
  const out = [];
  for (let ym = from.slice(0, 7); `${ym}-01` <= to; ym = addMonths(ym, months)) {
    const e = lastDayOfMonth(addMonths(ym, months - 1));
    out.push({ startDate: `${ym}-01`, endDate: e < to ? e : to });
  }
  return out;
}

function sql({ bucket, select, startDate, endDate, where, groupBy }) {
  return `
    SELECT ${bucket} AS b, ${select}
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= toDateTime('${startDate} 00:00:00')
      AND timestamp < toDateTime('${endDate} 00:00:00') + interval 1 day
      AND $session_id != ''
      AND ${where}
    GROUP BY ${groupBy || 'b'}
    ORDER BY b
    LIMIT 100000`;
}

const d = (v) => String(v).slice(0, 10);

/**
 * Query one series over [from, to]. `phQuery` and `withRetry` are injected
 * (the ones analyze-traffic-sources.js uses) so this is testable offline.
 */
async function fetchSeries(name, { from, to, phQuery, withRetry, where, deadline = Infinity, now = () => Date.now() }) {
  const DAY_BUCKET = 'toDate(session.$start_timestamp)';
  const specs = {
    daily: {
      chunks: dayChunks(from, to),
      q: (c) => sql({ bucket: DAY_BUCKET, select: 'count(DISTINCT $session_id) AS s, count() AS pv', ...c, where }),
      row: ([b, s, pv]) => ({ date: d(b), sessions: s, pageviews: pv }),
      key: (r) => r.date,
    },
    channelDaily: {
      chunks: dayChunks(from, to),
      q: (c) => sql({ bucket: DAY_BUCKET, select: `coalesce(session.$channel_type, '(unknown)') AS k, count(DISTINCT $session_id) AS s`, ...c, where, groupBy: 'b, k' }),
      row: ([b, k, s]) => ({ date: d(b), key: k === null || k === '' ? '(unknown)' : String(k), sessions: s }),
      key: (r) => r.date,
    },
    weeklyVisitors: {
      chunks: weekChunks(from, to),
      // mode 1 = weeks start on Monday (ISO), matching weekStart() in the report.
      q: (c) => sql({ bucket: `toStartOfWeek(toDate(session.$start_timestamp), 1)`, select: 'count(DISTINCT person_id) AS v', ...c, where }),
      row: ([b, v]) => ({ week: d(b), visitors: v }),
      key: (r) => r.week,
    },
    monthlyVisitors: {
      chunks: monthChunks(from, to),
      q: (c) => sql({ bucket: `toStartOfMonth(toDate(session.$start_timestamp))`, select: 'count(DISTINCT person_id) AS v', ...c, where }),
      row: ([b, v]) => ({ month: d(b).slice(0, 7), visitors: v }),
      key: (r) => (r.month + '-01'),
    },
  };
  const spec = specs[name];
  const out = [];
  for (const c of spec.chunks) {
    // Checked per chunk, not per series: a backfill series is several chunks,
    // each of which can take minutes on a slow PostHog day.
    if (now() > deadline) throw new Error(`skipped at ${c.startDate}: history time budget used up`);
    const rows = await withRetry(() => phQuery(spec.q(c)));
    if (rows.length >= 100000) throw new Error(`${name} ${c.startDate}..${c.endDate} hit the 100000-row limit`);
    // Keep only buckets that START inside this chunk (see header): a session
    // that began on the chunk's last day and ran past midnight appears in the
    // next chunk dated to this one; the epoch rows of sessions with no start
    // timestamp are dropped the same way.
    for (const r of rows.map(spec.row)) {
      const k = spec.key(r);
      if (k >= c.startDate && k <= c.endDate) out.push(r);
    }
  }
  return out;
}

const SERIES = ['daily', 'channelDaily', 'weeklyVisitors', 'monthlyVisitors'];

/**
 * Shape check for a stored file: a store that parses but is not four arrays
 * (hand edit, truncated write) must be refused, not merged — merging keeps
 * only rows before the refresh start, so a missing `daily` would silently
 * replace months of history with six weeks. Returns an error string or null.
 */
function validateStore(store) {
  if (store == null) return null; // first run
  if (typeof store !== 'object' || Array.isArray(store)) return 'store is not an object';
  if (typeof store.endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(store.endDate)) return 'store.endDate missing or not YYYY-MM-DD';
  for (const k of SERIES) if (!Array.isArray(store[k])) return `store.${k} is not a list`;
  return null;
}

/**
 * Refresh the store. Returns { store, refreshed, errors, from }.
 * `store` is the merged store when every series refreshed, else the old one
 * untouched (and `errors` names what failed). Series run sequentially: each
 * joins sessions + persons, and parallel queries are how HogQL timeouts happen.
 */
async function refreshHistory({ store, endDate, phQuery, withRetry, where, timeBudgetMs = 12 * 60000, now = () => Date.now() }) {
  const bad = validateStore(store);
  if (bad) return { store, refreshed: false, errors: { store: `refusing to merge into a malformed store (${bad}); fix or restore analytics/traffic-history.json` }, from: null };
  const from = refreshStart(store, endDate);
  const monthFrom = monthStart(from);
  const deadline = now() + timeBudgetMs;
  const fresh = {};
  const errors = {};
  for (const name of SERIES) {
    if (now() > deadline) { errors[name] = `skipped: history time budget (${Math.round(timeBudgetMs / 60000)} min) used up`; continue; }
    try {
      fresh[name] = await fetchSeries(name, { from: name === 'monthlyVisitors' ? monthFrom : from, to: endDate, phQuery, withRetry, where, deadline, now });
    } catch (e) { errors[name] = String(e.message || e).split('\n')[0].slice(0, 300); }
  }
  if (Object.keys(errors).length) return { store, refreshed: false, errors, from };
  const merged = mergeHistory(store, fresh, { from, monthFrom, endDate });
  // Last line of defence: a refresh can add days, never lose them.
  if (store && merged.daily.length < store.daily.length) {
    return { store, refreshed: false, errors: { merge: `merged store would shrink from ${store.daily.length} to ${merged.daily.length} days; not saved` }, from };
  }
  return { store: merged, refreshed: true, errors, from };
}

/**
 * Replace every bucket at or after the refresh start with the fresh rows.
 * Pure; exported for tests. `fresh` must carry all four series.
 */
function mergeHistory(store, fresh, { from, monthFrom, endDate }) {
  for (const name of SERIES) if (!Array.isArray(fresh[name])) throw new Error(`mergeHistory: missing ${name} — refusing a partial merge`);
  const old = store || {};
  const keep = (rows, keyOf, cut) => (rows || []).filter((r) => keyOf(r) < cut);
  const byKey = (a, b, k) => (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0);
  const merged = {
    version: 1,
    note: 'PostHog visits (sessions) and distinct visitors, Real Users lens. Written by scripts/analyze-traffic-sources.js (BRO-4136).',
    startDate: old.startDate && old.startDate < from ? old.startDate : from,
    endDate,
    updatedAt: new Date().toISOString(),
    daily: [...keep(old.daily, (r) => r.date, from), ...fresh.daily].sort((a, b) => byKey(a, b, (r) => r.date)),
    channelDaily: [...keep(old.channelDaily, (r) => r.date, from), ...fresh.channelDaily].sort((a, b) => byKey(a, b, (r) => r.date + r.key)),
    weeklyVisitors: [...keep(old.weeklyVisitors, (r) => r.week, from), ...fresh.weeklyVisitors].sort((a, b) => byKey(a, b, (r) => r.week)),
    monthlyVisitors: [...keep(old.monthlyVisitors, (r) => r.month, monthFrom.slice(0, 7)), ...fresh.monthlyVisitors].sort((a, b) => byKey(a, b, (r) => r.month)),
  };
  return merged;
}

module.exports = { refreshHistory, mergeHistory, validateStore, refreshStart, dayChunks, weekChunks, monthChunks, fetchSeries, TRACKING_FLOOR, REFRESH_DAYS };
