/**
 * traffic-metrics.js — the headline numbers of the weekly traffic report, in
 * the shape Google Analytics / Vercel Analytics show them: this week vs last
 * week (WoW), month to date vs the same days last month, last full month vs
 * the month before (MoM), year over year (YoY), plus the chart configs for
 * the email and the JSON the /admin/traffic dashboard reads (BRO-4136).
 *
 * Owner, 2026-09-24: "Traffic this week vs last week vs same week last year
 * (e.g. WoW, and YoY). Traffic this month vs last month vs same month last
 * year. Some charts, etc."
 *
 * Numbers are PostHog visits (sessions) through the Real Users lens. The
 * long-window series come from `history` (fetchHistory in
 * analyze-traffic-sources.js: daily totals, daily channel, weekly + monthly
 * distinct visitors). Older raw artifacts have no `history`; then the daily
 * visit series is rebuilt from the 13-week `ph.channelType` rows (or
 * `ph.country` when channelType failed) and visitor / pages-per-visit tiles
 * read "—" rather than a guess.
 *
 * YoY is honest: PostHog data starts 2026-03-13, so a same-week-last-year
 * number does not exist until March 2027. Until then the tile says when it
 * becomes available instead of showing a made-up comparison.
 *
 * Pure: no I/O except the optional shows map passed in for page names.
 */

const DAY = 86400000;
// First day of PostHog data for this site (rows start 2026-03-13). Used for
// "year over year available from…" when only the 13-week rows are at hand and
// the real start of tracking is not in the data.
const TRACKING_START = '2026-03-13';

function addDays(iso, n) {
  return new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
}
function mondayOf(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  const dow = d.getUTCDay() || 7;
  return addDays(iso, -(dow - 1));
}
function monthOf(iso) { return iso.slice(0, 7); }
function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function pct(now, before) {
  if (now == null || before == null || before <= 0) return null;
  return Math.round(((now - before) / before) * 100);
}
const fmtN = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
function fmtPct(p) { return p == null ? null : `${p > 0 ? '+' : p < 0 ? '−' : '±'}${Math.abs(p)}%`; }
function fmtDay(iso) { return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
function fmtMonthName(ym, opts = { month: 'long' }) { return new Date(ym + '-01T00:00:00Z').toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' }); }

/**
 * Daily visits/pageviews map + the first date that the numbers cover.
 * @returns {{ daily: Map<string,{visits:number,pageviews:number|null}>, coverFrom: string, dataStart: string|null, hasHistory: boolean }}
 */
function dailySeries({ history, ph, startDate, endDate }) {
  const daily = new Map();
  if (history && Array.isArray(history.daily) && history.daily.length) {
    for (const r of history.daily) daily.set(r.date, { visits: r.sessions || 0, pageviews: r.pageviews ?? null });
    return { daily, coverFrom: history.startDate, coverTo: history.endDate, dataStart: firstNonZero(daily), hasHistory: true };
  }
  const rows = ph && !ph.skipped && Array.isArray(ph.channelType) && ph.channelType.length ? ph.channelType
    : ph && !ph.skipped && Array.isArray(ph.country) ? ph.country : [];
  for (const r of rows) {
    const cur = daily.get(r.date) || { visits: 0, pageviews: null };
    cur.visits += r.sessions || 0;
    daily.set(r.date, cur);
  }
  return { daily, coverFrom: startDate, coverTo: endDate, dataStart: firstNonZero(daily), hasHistory: false };
}
function firstNonZero(daily) {
  const ds = [...daily.entries()].filter(([, v]) => v.visits > 0).map(([d]) => d).sort();
  return ds[0] || null;
}

function sumRange(daily, from, to) {
  // inclusive range; `missing` counts days with no row at all (an ingestion or
  // query gap), which span() treats as unknown rather than as zero traffic.
  let visits = 0; let pageviews = 0; let pvKnown = true; let missing = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = daily.get(d);
    if (!v) { missing++; continue; }
    visits += v.visits;
    if (v.pageviews == null) pvKnown = false; else pageviews += v.pageviews;
  }
  return { visits, pageviews: pvKnown ? pageviews : null, missing };
}
/**
 * A window [from, to] counts only when the data covers all of it: the query
 * window and the tracking had both started by `from`, and the data runs to `to`.
 * Otherwise the number is unknown (null), never a falsely low partial sum.
 */
function covered(cov, from, to) {
  return !!cov.coverFrom && from >= cov.coverFrom && !!cov.dataStart && from >= cov.dataStart && (!cov.coverTo || to <= cov.coverTo);
}

function topOf(rows, from, to, { exclude } = {}) {
  const agg = {};
  for (const r of rows || []) {
    if (r.date < from || r.date > to) continue;
    if (exclude && exclude(r.key)) continue;
    agg[r.key] = (agg[r.key] || 0) + (r.sessions || 0);
  }
  return Object.entries(agg).sort((a, b) => b[1] - a[1]).map(([key, visits]) => ({ key, visits }));
}

/**
 * Headline metrics.
 * @param {object} p
 * @param {object} [p.history]   fetchHistory() output (optional)
 * @param {object} p.ph          the 13-week PostHog rows (landing, referringDomain, country, channelType)
 * @param {string} p.startDate   first date of the 13-week window
 * @param {string} p.endDate     run date (the current, partial day)
 * @param {string} p.currentWeek Monday of the current (partial) week
 * @param {object} p.naming      { pageName(path), sourceName(domain), isSearch, isOwnTooling, isDirect }
 */
function computeTrafficMetrics({ history, ph, startDate, endDate, currentWeek, naming }) {
  const cov = dailySeries({ history, ph, startDate, endDate });
  const { daily, dataStart, hasHistory } = cov;
  const lastWeek = addDays(currentWeek, -7);
  const span = (from, to) => {
    if (!covered(cov, from, to)) return null;
    const r = sumRange(daily, from, to);
    return r.missing ? null : r;
  };
  const weekTotal = (w) => span(w, addDays(w, 6));
  const visitorsByWeek = new Map((history && history.weeklyVisitors || []).map((r) => [r.week, r.visitors]));
  const visitorsByMonth = new Map((history && history.monthlyVisitors || []).map((r) => [r.month, r.visitors]));

  // ---- week ----
  const lw = weekTotal(lastWeek);
  const pw = weekTotal(addDays(lastWeek, -7));
  const base4 = [1, 2, 3, 4].map((i) => weekTotal(addDays(lastWeek, -7 * i)));
  const avg4 = base4.every(Boolean) ? base4.reduce((t, x) => t + x.visits, 0) / 4 : null;
  const lyWeek = addDays(lastWeek, -364); // same weekday, 52 weeks back
  const ly = weekTotal(lyWeek);
  const week = {
    start: lastWeek,
    end: addDays(lastWeek, 6),
    visits: lw ? lw.visits : null,
    prevVisits: pw ? pw.visits : null,
    wowPct: pct(lw && lw.visits, pw && pw.visits),
    avg4: avg4 == null ? null : Math.round(avg4),
    vsAvg4Pct: pct(lw && lw.visits, avg4),
    visitors: visitorsByWeek.get(lastWeek) ?? null,
    prevVisitors: visitorsByWeek.get(addDays(lastWeek, -7)) ?? null,
    pagesPerVisit: lw && lw.pageviews != null && lw.visits ? +(lw.pageviews / lw.visits).toFixed(1) : null,
  };
  week.visitorsWowPct = pct(week.visitors, week.prevVisitors);

  // ---- YoY ----
  // First Monday whose same-week-last-year is fully tracked. Without history
  // the 13-week window's first day is not when tracking began.
  const trackedFrom = hasHistory && dataStart ? dataStart : TRACKING_START;
  const firstFullWeek = mondayOf(trackedFrom) === trackedFrom ? trackedFrom : addDays(mondayOf(trackedFrom), 7);
  const availableFrom = addDays(firstFullWeek, 364);
  const yoy = ly && ly.visits > 0
    ? { available: true, lastYearWeek: lyWeek, lastYearVisits: ly.visits, pct: pct(week.visits, ly.visits) }
    // Past the date but no history this run (refresh failed): unknown, not "not yet".
    : { available: false, availableFrom, notLoaded: lastWeek >= availableFrom };

  // ---- month to date (through yesterday; today is partial) ----
  // The month is the RUN date's month; yesterday is only the cutoff. On the
  // 1st, the month so far has 0 days and the month that just ended is the
  // "last full month" (a Mar 1 run must not call February "so far").
  const through = addDays(endDate, -1);
  const thisMonth = monthOf(endDate);
  const dayN = through >= `${thisMonth}-01` ? Number(through.slice(8, 10)) : 0;
  const prevMonth = addMonths(thisMonth, -1);
  const pad = (n) => String(n).padStart(2, '0');
  const mtdNow = dayN ? span(`${thisMonth}-01`, through) : null;
  const mtdPrev = dayN ? span(`${prevMonth}-01`, `${prevMonth}-${pad(Math.min(dayN, daysInMonth(prevMonth)))}`) : null;
  const lyMonth = addMonths(thisMonth, -12);
  const mtdLy = dayN ? span(`${lyMonth}-01`, `${lyMonth}-${pad(Math.min(dayN, daysInMonth(lyMonth)))}`) : null;
  // One or two days make a noisy percentage; compare from the 3rd on.
  const MIN_MTD_DAYS = 3;
  const mtd = {
    month: thisMonth, days: dayN, through,
    visits: mtdNow ? mtdNow.visits : null,
    prevMonth, prevVisits: mtdPrev ? mtdPrev.visits : null,
    momPct: dayN >= MIN_MTD_DAYS ? pct(mtdNow && mtdNow.visits, mtdPrev && mtdPrev.visits) : null,
    lastYearVisits: mtdLy && mtdLy.visits > 0 ? mtdLy.visits : null,
  };
  mtd.yoyPct = dayN >= MIN_MTD_DAYS ? pct(mtd.visits, mtd.lastYearVisits) : null;

  // ---- last full month vs the month before ----
  const monthTotal = (ym) => span(`${ym}-01`, `${ym}-${daysInMonth(ym)}`);
  const lfm = prevMonth;
  const lfmT = monthTotal(lfm);
  const mbT = monthTotal(addMonths(lfm, -1));
  const lyT = monthTotal(addMonths(lfm, -12));
  const lastMonth = {
    month: lfm,
    visits: lfmT ? lfmT.visits : null,
    prevMonth: addMonths(lfm, -1),
    prevVisits: mbT ? mbT.visits : null,
    momPct: pct(lfmT && lfmT.visits, mbT && mbT.visits),
    visitors: visitorsByMonth.get(lfm) ?? null,
    lastYearVisits: lyT && lyT.visits > 0 ? lyT.visits : null,
  };
  lastMonth.yoyPct = pct(lastMonth.visits, lastMonth.lastYearVisits);

  // ---- top page / referrer / country, last full week ----
  const n = naming;
  const phOk = ph && !ph.skipped;
  const lwEnd = addDays(lastWeek, 6);
  const pages = phOk ? topOf(ph.landing, lastWeek, lwEnd) : [];
  // Named sources merged (www.reddit.com + the Reddit app = Reddit); direct and our own tools are not referrers.
  const refRaw = phOk ? topOf(ph.referringDomain, lastWeek, lwEnd, { exclude: (k) => n.isDirect(k) || n.isOwnTooling(k) }) : [];
  const refMerged = {};
  for (const r of refRaw) { const name = n.sourceName(r.key); refMerged[name] = (refMerged[name] || 0) + r.visits; }
  const referrers = Object.entries(refMerged).sort((a, b) => b[1] - a[1]).map(([key, visits]) => ({ key, visits }));
  const countries = phOk ? topOf(ph.country, lastWeek, lwEnd, { exclude: (k) => k === '(unknown)' }) : [];
  const top = {
    pages: pages.slice(0, 10).map((p) => ({ path: p.key, name: n.pageName(p.key), visits: p.visits })),
    referrers: referrers.slice(0, 10),
    countries: countries.slice(0, 10),
  };

  return { week, yoy, mtd, lastMonth, top, dataStart, trackedFrom, hasHistory, generatedFor: endDate };
}

// ---------- email tiles ----------

/** Capitalise the first letter ("the homepage" → "The homepage") for a tile headline. */
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function vs(p, what) { return p == null ? null : `${fmtPct(p)} vs ${what}`; }

/**
 * Nine tiles, three rows: the WoW / MoM / YoY headline, then visitors,
 * pages per visit and last full month, then top page / referrer / country.
 * Each tile is { label, value, lines: [..] }.
 */
function buildTiles(m) {
  const t = [];
  t.push({ label: `Visits, week of ${fmtDay(m.week.start)}`, value: fmtN(m.week.visits), lines: [vs(m.week.wowPct, 'week before'), vs(m.week.vsAvg4Pct, '4-week average')].filter(Boolean) });
  if (!m.mtd.days) {
    t.push({ label: `${fmtMonthName(m.mtd.month)} so far`, value: '—', lines: ['The month starts today'] });
  } else {
    const range = m.mtd.days === 1 ? `${fmtMonthName(m.mtd.month, { month: 'short' })} 1` : `${fmtMonthName(m.mtd.month, { month: 'short' })} 1–${m.mtd.days}`;
    t.push({ label: `${fmtMonthName(m.mtd.month)} so far`, value: fmtN(m.mtd.visits), lines: [range, vs(m.mtd.momPct, `${fmtMonthName(m.mtd.prevMonth, { month: 'short' })} 1–${Math.min(m.mtd.days, daysInMonth(m.mtd.prevMonth))}`)].filter(Boolean) });
  }
  if (m.yoy.available) {
    t.push({ label: 'Same week last year', value: fmtN(m.yoy.lastYearVisits), lines: [vs(m.yoy.pct, `week of ${fmtDay(m.yoy.lastYearWeek)}, ${m.yoy.lastYearWeek.slice(0, 4)}`)].filter(Boolean) });
  } else if (m.yoy.notLoaded) {
    t.push({ label: 'Year over year', value: '—', lines: ['History did not load this week'] });
  } else {
    const when = fmtMonthName(monthOf(m.yoy.availableFrom), { month: 'long', year: 'numeric' });
    // Reason first, so "Not yet" reads as expected rather than broken (UX review).
    t.push({ label: 'Year over year', value: 'Not yet', lines: [`Tracking began ${fmtMonthName(monthOf(m.trackedFrom), { month: 'long', year: 'numeric' })}`, `First comparison: ${when}`] });
  }
  t.push({ label: 'Visitors (people)', value: fmtN(m.week.visitors), lines: [vs(m.week.visitorsWowPct, 'week before') || (m.week.visitors == null ? 'Not in this data' : null)].filter(Boolean) });
  t.push({ label: 'Pages per visit', value: m.week.pagesPerVisit == null ? '—' : String(m.week.pagesPerVisit), lines: [m.week.pagesPerVisit == null ? 'Not in this data' : 'Last week'] });
  t.push({ label: `${fmtMonthName(m.lastMonth.month)} (full month)`, value: fmtN(m.lastMonth.visits), lines: [vs(m.lastMonth.momPct, fmtMonthName(m.lastMonth.prevMonth)), m.lastMonth.yoyPct != null ? vs(m.lastMonth.yoyPct, `${fmtMonthName(m.lastMonth.month, { month: 'short' })} last year`) : null].filter(Boolean) });
  const tp = m.top.pages[0]; const tr = m.top.referrers[0]; const tc = m.top.countries[0];
  t.push({ label: 'Top landing page', value: tp ? cap(tp.name.replace(/ page$/, '')) : '—', lines: tp ? [`${fmtN(tp.visits)} visits last week`] : [] });
  t.push({ label: 'Top referrer', value: tr ? tr.key : '—', lines: tr ? [`${fmtN(tr.visits)} visits last week`] : [] });
  t.push({ label: 'Top country', value: tc ? tc.key : '—', lines: tc ? [`${fmtN(tc.visits)} visits last week`] : [] });
  return t;
}

/** Tiles as the renderer's tile lines: [[tile|label|value|line|line]]. Pipes stripped from values. */
function tilesMarkdown(tiles) {
  const clean = (s) => String(s).replace(/[|\]\n]/g, ' ');
  return tiles.map((t) => `[[tile|${[t.label, t.value, ...t.lines].map(clean).join('|')}]]`).join('\n');
}

// ---------- charts (QuickChart renders Chart.js to a PNG; no JS needed in the inbox) ----------

const INK = '#111827';
const BLUE = '#2563eb';
const GOLD = '#b8956a';

/** Weekly visits for the last `n` full weeks: all visits + visits from search. */
function weeklyChartConfig({ history, ph, startDate, endDate, currentWeek, n = 13 }) {
  const cov = dailySeries({ history, ph, startDate, endDate });
  const { daily } = cov;
  const weeks = [];
  for (let i = n; i >= 1; i--) weeks.push(addDays(currentWeek, -7 * i));
  const inRange = (w) => covered(cov, w, addDays(w, 6));
  const total = weeks.map((w) => (inRange(w) ? sumRange(daily, w, addDays(w, 6)).visits : null));
  const chRows = history && Array.isArray(history.channelDaily) && history.channelDaily.length ? history.channelDaily : (ph && ph.channelType) || [];
  const search = weeks.map((w) => (inRange(w) && chRows.length ? chRows.filter((r) => r.key === 'Organic Search' && r.date >= w && r.date <= addDays(w, 6)).reduce((t, r) => t + r.sessions, 0) : null));
  return {
    type: 'line',
    data: {
      labels: weeks.map(fmtDay),
      datasets: [
        { label: 'All visits', data: total, borderColor: BLUE, backgroundColor: 'rgba(37,99,235,0.08)', fill: true, lineTension: 0.25, pointRadius: 2, borderWidth: 2 },
        ...(chRows.length ? [{ label: 'From search', data: search, borderColor: GOLD, fill: false, lineTension: 0.25, pointRadius: 2, borderWidth: 2 }] : []),
      ],
    },
    options: {
      title: { display: true, text: `Visits per week, last ${n} weeks`, fontColor: INK, fontSize: 14 },
      legend: { position: 'bottom', labels: { fontColor: INK, boxWidth: 12 } },
      scales: { yAxes: [{ ticks: { beginAtZero: true, fontColor: '#6b7280' }, gridLines: { color: '#f3f4f6' } }], xAxes: [{ ticks: { fontColor: '#6b7280' }, gridLines: { display: false } }] },
    },
  };
}

function topPagesChartConfig(pages, { n = 8, weekStart } = {}) {
  const top = pages.slice(0, n);
  const label = (s) => { const x = cap(s.replace(/ page$/, '')); return x.length > 34 ? x.slice(0, 33) + '…' : x; };
  return {
    type: 'horizontalBar',
    data: { labels: top.map((p) => label(p.name)), datasets: [{ label: 'Visits', data: top.map((p) => p.visits), backgroundColor: BLUE }] },
    options: {
      title: { display: true, text: `Top landing pages${weekStart ? `, week of ${fmtDay(weekStart)}` : ''}`, fontColor: INK, fontSize: 14 },
      legend: { display: false },
      scales: { xAxes: [{ ticks: { beginAtZero: true, fontColor: '#6b7280' }, gridLines: { color: '#f3f4f6' } }], yAxes: [{ ticks: { fontColor: INK }, gridLines: { display: false } }] },
    },
  };
}

// ---------- dashboard JSON ----------

const CHANNEL_GROUPS = [
  ['Search', ['Organic Search', 'Paid Search']],
  ['Direct', ['Direct']],
  ['Social', ['Organic Social', 'Paid Social', 'Organic Video']],
  ['Email', ['Email']],
  ['AI assistants', ['AI']],
  ['Other sites', ['Referral']],
];
function channelGroup(k) {
  for (const [g, keys] of CHANNEL_GROUPS) if (keys.includes(k)) return g;
  return 'Other';
}

/**
 * Everything /admin/traffic renders: 52 weekly points (visits, visitors,
 * visits by channel group), monthly totals, the headline metrics, and top
 * pages / referrers / countries for last week and the last 4 weeks.
 */
function buildDashboardData({ history, ph, startDate, endDate, currentWeek, naming, metrics, generatedAt }) {
  const { daily, coverFrom } = dailySeries({ history, ph, startDate, endDate });
  const visitorsByWeek = new Map((history && history.weeklyVisitors || []).map((r) => [r.week, r.visitors]));
  const visitorsByMonth = new Map((history && history.monthlyVisitors || []).map((r) => [r.month, r.visitors]));
  const chRows = history && Array.isArray(history.channelDaily) && history.channelDaily.length ? history.channelDaily : (ph && !ph.skipped && ph.channelType) || [];
  const chByWeek = {};
  for (const r of chRows) {
    const w = mondayOf(r.date);
    const g = channelGroup(r.key);
    ((chByWeek[w] = chByWeek[w] || {})[g] = (chByWeek[w][g] || 0) + r.sessions);
  }
  const weeks = [];
  for (let i = 52; i >= 1; i--) {
    const w = addDays(currentWeek, -7 * i);
    if (w < coverFrom || (metrics.dataStart && addDays(w, 6) < metrics.dataStart)) continue;
    const s = sumRange(daily, w, addDays(w, 6));
    weeks.push({ week: w, visits: s.visits, pageviews: s.pageviews, visitors: visitorsByWeek.get(w) ?? null, channels: chByWeek[w] || {}, partialStart: !!(metrics.dataStart && w < metrics.dataStart) });
  }
  const months = [];
  const through = addDays(endDate, -1);
  for (let ym = monthOf(metrics.dataStart || coverFrom); ym <= monthOf(through); ym = addMonths(ym, 1)) {
    const from = `${ym}-01`;
    const to = ym === monthOf(through) ? through : `${ym}-${daysInMonth(ym)}`;
    const s = sumRange(daily, from, to);
    const current = ym === monthOf(endDate); // the run's month is unfinished; a month that ended yesterday is not
    months.push({ month: ym, visits: s.visits, pageviews: s.pageviews, visitors: current ? null : visitorsByMonth.get(ym) ?? null, partial: current || (metrics.dataStart && from < metrics.dataStart) || from < coverFrom });
  }
  const phOk = ph && !ph.skipped;
  const last4From = addDays(currentWeek, -28);
  // A short --days run (14) does not hold 4 full weeks: no "last 4 weeks" rankings then.
  const has4 = phOk && startDate <= last4From;
  const last4To = addDays(currentWeek, -1);
  const merge = (rows) => { const o = {}; for (const r of rows) { const k = naming.sourceName(r.key); o[k] = (o[k] || 0) + r.visits; } return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([key, visits]) => ({ key, visits })); };
  const refExclude = { exclude: (k) => naming.isDirect(k) || naming.isOwnTooling(k) };
  const pages4 = has4 ? topOf(ph.landing, last4From, last4To) : [];
  return {
    generatedAt,
    through,
    dataStart: metrics.dataStart,
    source: 'PostHog visits (sessions), Real Users lens: owner and known bot countries excluded',
    metrics,
    tiles: buildTiles(metrics), // the same nine tiles as the email, so the two never disagree
    weeks,
    months,
    channelGroups: [...CHANNEL_GROUPS.map(([g]) => g), 'Other'],
    top: {
      lastWeek: metrics.top,
      last4Weeks: has4 ? {
        from: last4From,
        pages: pages4.slice(0, 15).map((p) => ({ path: p.key, name: naming.pageName(p.key), visits: p.visits })),
        referrers: merge(topOf(ph.referringDomain, last4From, last4To, refExclude)).slice(0, 15),
        countries: topOf(ph.country, last4From, last4To, { exclude: (k) => k === '(unknown)' }).slice(0, 15),
      } : null,
    },
  };
}

module.exports = {
  computeTrafficMetrics, buildTiles, tilesMarkdown, weeklyChartConfig, topPagesChartConfig,
  buildDashboardData, channelGroup, addDays, mondayOf, addMonths, daysInMonth, TRACKING_START,
};
