#!/usr/bin/env node
/**
 * analyze-traffic-sources.js — Weekly traffic-source comparison across GA4 and
 * PostHog, with automatic spike detection per source/channel.
 *
 * Why: the owner cannot watch every referrer in two dashboards. This pulls the
 * last N days from both tools, buckets by ISO week, and flags any channel,
 * source/medium, referring domain, campaign, country or landing page whose
 * weekly volume jumped well above its own prior median (or appeared from
 * nothing). Both tools are reported side by side because GA4's Direct channel
 * is bot-inflated (~2.5x PostHog) — see memory/feedback_analytics_real_users_lens.md.
 * Vercel Web Analytics has no query API (all endpoints 404) and is omitted.
 *
 * Both tools are queried over the SAME explicit [startDate, endDate] window,
 * and startDate is snapped back to a Monday so every baseline week is a full
 * week (ship-check: a partial first week deflated the median for week 2).
 *
 * PostHog sessions are attributed by their ENTRY properties (session.$entry_*
 * via the lazy sessions join) and bucketed by session start, so a session that
 * crosses midnight or visits several pages counts once, under the referrer /
 * landing page it actually arrived through — the same thing GA4's session-
 * scoped dimensions measure.
 *
 * Env: GA4_PROPERTY_ID + GA_SERVICE_ACCOUNT_KEY (base64 JSON) or GA_KEY_FILE;
 *      POSTHOG_PERSONAL_API_KEY. Either tool may be missing — the other still
 *      runs. Any query that FAILS is reported at the top of the report and the
 *      process exits 1 after writing it, so CI goes red instead of shipping a
 *      half-empty report as green.
 *
 * Usage:
 *   node scripts/analyze-traffic-sources.js [--days=91] [--out=DIR]
 *
 * Writes <out>/traffic-sources-report.md and <out>/traffic-sources-raw.json.
 * Default out dir: traffic-analysis/ (gitignored scratch, uploaded as a CI artifact).
 */

const fs = require('fs');
const path = require('path');

require('./lib/load-env').loadEnv();
const { getGaClient, hasGaCredentials } = require('./lib/ga4-client');
const { phQuery, REAL_USERS_WHERE } = require('./lib/posthog-query');

// GA4 runReport returns at most 250k rows per call; rowCount is the size of
// the COMPLETE result regardless of limit, so rowCount > limit means the rows
// we got are a prefix. Checked per dimension so one oversized report (date ×
// landingPage) fails alone instead of taking the other four with it.
const GA_ROW_LIMIT = 250000;
// HogQL has no rowCount; rows come back oldest-first, so hitting the LIMIT
// would silently drop the most RECENT days (which then read as zero traffic).
// Treat a full page as truncation.
const PH_ROW_LIMIT = 100000;

// ---------- pure helpers (exported for tests) ----------

/** ISO week start (Monday) as YYYY-MM-DD for a YYYYMMDD or YYYY-MM-DD date. */
function weekStart(dateStr) {
  const s = String(dateStr).replace(/-/g, '');
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  const day = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() - (day - 1));
  return d.toISOString().slice(0, 10);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Build { key -> { week -> value } } from rows of { date, key, value }.
 */
function bucketWeekly(rows) {
  const out = {};
  for (const r of rows) {
    const w = weekStart(r.date);
    out[r.key] = out[r.key] || {};
    out[r.key][w] = (out[r.key][w] || 0) + r.value;
  }
  return out;
}

/**
 * Detect spikes in weekly series.
 * A week is a spike when value >= minAbs AND either
 *   - the source is brand new: every prior week was below minAbs/3, or
 *   - value >= ratio * median(prior weeks), with >= 2 prior weeks and a
 *     POSITIVE median. A zero median never qualifies on its own — otherwise a
 *     source that appeared mid-window would be flagged every week until its
 *     nonzero weeks outnumbered its zero weeks (ship-check P1).
 * `weeks` is the full ordered list of week starts for the window, so a source
 * with no rows in a week is treated as 0 (not missing).
 * The partial current week is excluded from spike detection but kept in the series.
 */
function detectSpikes(series, weeks, { minAbs = 30, ratio = 3, currentWeek = null } = {}) {
  const spikes = [];
  for (const [key, byWeek] of Object.entries(series)) {
    const values = weeks.map((w) => byWeek[w] || 0);
    for (let i = 1; i < weeks.length; i++) {
      if (currentWeek && weeks[i] === currentWeek) continue;
      const v = values[i];
      if (v < minAbs) continue;
      const prior = values.slice(0, i);
      const med = median(prior);
      const isNew = prior.every((p) => p < minAbs / 3);
      if (isNew || (prior.length >= 2 && med > 0 && v >= ratio * med)) {
        spikes.push({
          key,
          week: weeks[i],
          value: v,
          priorMedian: med,
          multiple: med > 0 ? +(v / med).toFixed(1) : null,
          isNew,
          next: values[i + 1] ?? null,
          total: values.reduce((a, b) => a + b, 0),
        });
      }
    }
  }
  // Rank by how far above baseline (absolute excess), so big new sources lead.
  spikes.sort((a, b) => (b.value - b.priorMedian) - (a.value - a.priorMedian));
  return spikes;
}

function allWeeks(startDate, endDate) {
  const weeks = [];
  let w = weekStart(startDate);
  const last = weekStart(endDate);
  while (w <= last) {
    weeks.push(w);
    const d = new Date(w + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 7);
    w = d.toISOString().slice(0, 10);
  }
  return weeks;
}

/** Referrers / UTMs can contain '|', which would split a markdown cell. */
function mdCell(v) {
  return String(v ?? '—').replace(/\|/g, '\\|');
}

function fmtTable(headers, rows) {
  if (!rows.length) return '_No data_\n';
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) lines.push(`| ${r.map(mdCell).join(' | ')} |`);
  return lines.join('\n') + '\n';
}

/** Weekly matrix table: rows = top keys by total, columns = weeks (short labels). */
function fmtWeeklyMatrix(series, weeks, topN = 12) {
  const totals = Object.entries(series).map(([k, bw]) => [k, weeks.reduce((s, w) => s + (bw[w] || 0), 0)]);
  totals.sort((a, b) => b[1] - a[1]);
  const top = totals.slice(0, topN);
  const headers = ['Source', ...weeks.map((w) => w.slice(5)), 'Total'];
  const rows = top.map(([k, t]) => [k, ...weeks.map((w) => series[k][w] || 0), t]);
  return fmtTable(headers, rows);
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// ---------- GA4 ----------

async function gaRows(client, propertyId, dateRange, dimension, metrics) {
  const [res] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'date' }, { name: dimension }],
    metrics: metrics.map((m) => ({ name: m })),
    limit: GA_ROW_LIMIT,
  });
  const rowCount = Number(res.rowCount || 0);
  if (rowCount > GA_ROW_LIMIT) {
    throw new Error(`GA4 date×${dimension} has ${rowCount} rows, over the ${GA_ROW_LIMIT} limit — results would be silently truncated`);
  }
  return (res.rows || []).map((r) => {
    const o = { date: r.dimensionValues[0].value, key: r.dimensionValues[1].value || '(not set)' };
    metrics.forEach((m, i) => { o[m] = parseInt(r.metricValues[i].value || '0', 10); });
    return o;
  });
}

async function fetchGa4(dateRange) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId || !hasGaCredentials()) {
    return { skipped: 'GA4_PROPERTY_ID / GA credentials not set' };
  }
  const client = getGaClient();
  const metrics = ['sessions', 'engagedSessions', 'totalUsers'];
  const specs = {
    channel: ['sessionDefaultChannelGroup', metrics],
    sourceMedium: ['sessionSourceMedium', metrics],
    campaign: ['sessionCampaignName', metrics],
    landing: ['landingPage', ['sessions', 'engagedSessions']],
    country: ['country', ['sessions', 'engagedSessions']],
  };
  const out = { errors: {} };
  const settled = await Promise.allSettled(
    Object.values(specs).map(([dim, m]) => gaRows(client, propertyId, dateRange, dim, m)),
  );
  Object.keys(specs).forEach((name, i) => {
    const r = settled[i];
    if (r.status === 'fulfilled') out[name] = r.value;
    else { out[name] = []; out.errors[name] = r.reason.message; }
  });
  if (Object.keys(out.errors).length === Object.keys(specs).length) {
    return { skipped: `GA4: every query failed — ${Object.values(out.errors)[0]}` };
  }
  return out;
}

// ---------- PostHog ----------

/**
 * Run `fn` again once if it fails with a transient PostHog error. The second
 * live run (GHA 35021340158) lost its first query to a bare "504 Gateway
 * Time-out" that succeeded on the next dispatch; one retry after a pause is
 * cheaper than a red run. Non-transient errors (400 bad HogQL, 401/403) are
 * rethrown immediately.
 */
async function withRetry(fn, { attempts = 2, delayMs = 20000, isRetryable = isTransientPostHogError, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      if (i === attempts || !isRetryable(e)) throw e;
      console.error(`retrying after transient error (attempt ${i}/${attempts}): ${String(e.message).split('\n')[0].slice(0, 120)}`);
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

function isTransientPostHogError(e) {
  const msg = String(e && e.message);
  // An HTTP status decides first: a 400 whose body says "timeout exceeded" is a
  // HogQL execution-limit error that fails identically on retry.
  const m = msg.match(/PostHog API (\d{3})/);
  if (m) { const st = +m[1]; return st >= 500 || st === 429 || st === 408; }
  return /time-?out|ECONNRESET|fetch failed/i.test(msg);
}

/**
 * Sessions per day keyed by `expr`, attributed by session ENTRY properties and
 * bucketed by session start. `extraWhere` is appended after the Real Users lens.
 */
async function phDaily(expr, { startDate, endDate }, extraWhere = '') {
  // Explicit LIMIT — HogQL silently caps GROUP BY results at ~100 rows
  // (memory/feedback_posthog_hogql_default_row_limit.md).
  const rows = await phQuery(`
    SELECT toDate(session.$start_timestamp) AS d, ${expr} AS k,
           count(DISTINCT $session_id) AS sessions, count(DISTINCT person_id) AS users
    FROM events
    WHERE event = '$pageview'
      AND timestamp >= toDateTime('${startDate} 00:00:00')
      AND timestamp < toDateTime('${endDate} 00:00:00') + interval 1 day
      AND $session_id != ''
      AND ${REAL_USERS_WHERE} ${extraWhere}
    GROUP BY d, k
    ORDER BY d
    LIMIT ${PH_ROW_LIMIT}`);
  if (rows.length >= PH_ROW_LIMIT) {
    throw new Error(`PostHog query for ${expr} hit the ${PH_ROW_LIMIT}-row limit — recent days would be silently missing`);
  }
  return rows.map(([d, k, sessions, users]) => ({
    date: String(d).slice(0, 10), key: k === null || k === '' ? '(none)' : String(k), sessions, users,
  }))
    // A session with no $start_timestamp dates to the epoch (seen live: two
    // rows in "1969-12-29"); anything outside the window is not ours to bucket.
    .filter((r) => r.date >= startDate && r.date <= endDate);
}

async function fetchPostHog(range) {
  if (!process.env.POSTHOG_PERSONAL_API_KEY) return { skipped: 'POSTHOG_PERSONAL_API_KEY not set' };
  const specs = {
    // PostHog's own session channel classification (mirrors GA4 channel groups).
    channelType: [`coalesce(session.$channel_type, '(unknown)')`, ''],
    referringDomain: [`coalesce(nullIf(session.$entry_referring_domain, ''), '$direct')`, ''],
    utmSource: [`concat(coalesce(session.$entry_utm_source, ''), ' / ', coalesce(session.$entry_utm_medium, ''))`,
      `AND coalesce(session.$entry_utm_source, '') != ''`],
    country: [`coalesce(properties.$geoip_country_name, '(unknown)')`, ''],
    landing: [`coalesce(session.$entry_pathname, '(none)')`,
      `AND coalesce(session.$entry_referring_domain, '') NOT LIKE '%broadwayscorecard.com%'`],
    // Referrer × landing page, for non-search referrers only: this is what
    // ties "Reddit sent 300 visits" to the show page the post was about.
    referralLanding: [`concat(session.$entry_referring_domain, ' → ', coalesce(session.$entry_pathname, '(none)'))`,
      `AND coalesce(session.$entry_referring_domain, '') != ''
       AND session.$entry_referring_domain NOT LIKE '%broadwayscorecard.com%'
       AND session.$entry_referring_domain NOT LIKE '%google.%'
       AND session.$entry_referring_domain NOT LIKE '%bing.com%'
       AND session.$entry_referring_domain NOT LIKE '%yahoo.%'
       AND session.$entry_referring_domain NOT LIKE '%duckduckgo.%'
       AND session.$entry_referring_domain NOT LIKE '%ecosia.%'`],
  };
  // Kill switch for the highest-cardinality query (referrer × path) without a
  // code change: the report degrades to "referrer data unavailable" sections.
  if (process.env.TRAFFIC_SKIP_REFERRAL_LANDING === '1') delete specs.referralLanding;
  const out = { errors: {} };
  // Sequential on purpose: each query joins sessions + persons over the whole
  // window; six in parallel is how HogQL query timeouts happen.
  for (const [name, [expr, where]] of Object.entries(specs)) {
    try { out[name] = await withRetry(() => phDaily(expr, range, where)); }
    catch (e) { out[name] = []; out.errors[name] = e.message; }
  }
  if (Object.keys(out.errors).length === Object.keys(specs).length) {
    return { skipped: `PostHog: every query failed — ${Object.values(out.errors)[0]}` };
  }
  return out;
}

// ---------- report ----------

function seriesFor(rows, normalizedRows, metric) {
  return bucketWeekly((normalizedRows || rows).map((r) => ({ date: r.date, key: r.key, value: r[metric] })));
}

/**
 * Newsletter campaigns are date-stamped (weekly-2026-07-12, we-weekly-…,
 * opening-<show>-2026), so every send would read as a brand-new source.
 * Collapse them to their family so the campaign table shows the channel's
 * real trend and only genuinely new campaign families get flagged.
 */
function normalizeCampaign(key) {
  return String(key)
    .replace(/^(we-)?weekly-\d{4}-\d{2}-\d{2}$/, '$1weekly-(dated sends)')
    .replace(/^opening-.+-\d{4}$/, 'opening-(dated sends)');
}

/** One report section: weekly matrix + spike table. Returns md plus the spikes for the summary. */
function sectionFor({ id, tool, title, rows, metric, weeks, currentWeek, opts = {} }) {
  if (!rows || !rows.length) return { id, md: `### ${title}\n_No data_\n\n`, spikes: [], series: {}, tool, metric };
  const series = seriesFor(rows, opts.normalizeKey ? rows.map((r) => ({ ...r, key: opts.normalizeKey(r.key) })) : null, metric);
  const spikes = detectSpikes(series, weeks, { currentWeek, ...opts });
  const minAbs = opts.minAbs || 30;
  const ratio = opts.ratio || 3;
  let md = `### ${title} — ${metric} per week\n\n`;
  md += fmtWeeklyMatrix(series, weeks, opts.topN || 12) + '\n';
  if (spikes.length) {
    md += `**Spikes** (at least ${minAbs} in the week and ${ratio}x the usual weekly level, or a source that had not appeared before):\n\n`;
    md += fmtTable(['Source', 'Week of', metric, 'Usual per week', 'Times usual', 'Following week', 'New source?'],
      spikes.slice(0, 15).map((s) => [s.key, fmtDate(s.week), s.value, s.priorMedian, s.multiple ?? 'new', s.next ?? '(current)', s.isNew ? 'yes' : '']));
  } else {
    md += '_No spikes detected._\n';
  }
  return { id, md, spikes: spikes.map((s) => ({ ...s, tool, dimension: title, metric })), series, tool, metric };
}

/** Last full week vs the average of the 4 full weeks before it, per key. */
function recentChange(series, weeks, currentWeek) {
  const full = weeks.filter((w) => w !== currentWeek);
  if (full.length < 2) return [];
  const last = full[full.length - 1];
  const base = full.slice(-5, -1);
  return Object.entries(series).map(([k, bw]) => {
    const now = bw[last] || 0;
    const avg = base.reduce((s, w) => s + (bw[w] || 0), 0) / base.length;
    return { key: k, last: now, avg: +avg.toFixed(0), pct: avg > 0 ? Math.round(((now - avg) / avg) * 100) : null };
  }).sort((a, b) => b.last - a.last);
}

function sumWeeks(bw, ws) { return ws.reduce((t, w) => t + (bw[w] || 0), 0); }

/**
 * Rising / falling sources: the typical (median) week of the last 4 full
 * weeks vs the typical week of the 4 before. Rising = at least +pct% and at
 * least minWeekly in a typical week now (or brand new at that level);
 * falling = at least -pct% from at least minWeekly before. Ranked by the size
 * of the change. Exported for tests.
 */
function trendsFor(series, weeks, currentWeek, { minWeekly = 20, pct = 40 } = {}) {
  const full = weeks.filter((w) => w !== currentWeek);
  if (full.length < 8) return { rising: [], falling: [], recentWeeks: [], priorWeeks: [] };
  const recentWeeks = full.slice(-4);
  const priorWeeks = full.slice(-8, -4);
  // Medians of the 4 weeks, not means: one big week ([200,0,0,0]) must not read
  // as "rising", and one dead week must not read as "falling" (Codex review).
  const rows = Object.entries(series).map(([key, bw]) => {
    const r = median(recentWeeks.map((w) => bw[w] || 0));
    const p = median(priorWeeks.map((w) => bw[w] || 0));
    return { key, recentPerWeek: Math.round(r), priorPerWeek: Math.round(p), pct: p > 0 ? Math.round(((r - p) / p) * 100) : null };
  });
  const rising = rows
    .filter((x) => x.recentPerWeek >= minWeekly && (x.pct === null || x.pct >= pct))
    .sort((a, b) => (b.recentPerWeek - b.priorPerWeek) - (a.recentPerWeek - a.priorPerWeek));
  const falling = rows
    .filter((x) => x.priorPerWeek >= minWeekly && x.pct !== null && x.pct <= -pct)
    .sort((a, b) => (b.priorPerWeek - b.recentPerWeek) - (a.priorPerWeek - a.recentPerWeek));
  return { rising, falling, recentWeeks, priorWeeks };
}

/**
 * Sources that did not exist in the first half of the window and have at
 * least minTotal visits in the second half — the "new site linking to me"
 * list. Deliberately low threshold: a blog that sent 6 visits is worth a look.
 * Exported for tests.
 */
function newSources(series, weeks, currentWeek, { minTotal = 5 } = {}) {
  const full = weeks.filter((w) => w !== currentWeek);
  const half = Math.floor(full.length / 2);
  const early = full.slice(0, half);
  const late = full.slice(half);
  return Object.entries(series)
    .map(([key, bw]) => ({ key, early: sumWeeks(bw, early), late: sumWeeks(bw, late), lateWeeks: late, firstWeek: full.find((w) => bw[w]) || null, current: bw[currentWeek] || 0 }))
    .filter((x) => x.early === 0 && x.late >= minTotal)
    .sort((a, b) => b.late - a.late);
}

// Search engines and our own domain are not "sites linking to us".
const NOT_A_LINKING_SITE = /google\.|bing\.com|yahoo\.|duckduckgo|ecosia|brave\.com|kagi\.com|yandex|baidu|startpage|qwant|lilo\.org|oceanhero|presearch|metacrawler|lycos|zapmeta|hotbot|search66|webcrawler|dogpile|excite\.|ask\.com|aol\.com|^(www\.)?search\.|broadwayscorecard\.com|^\$direct$|^\(none\)$/i;

/** referralLanding rows are keyed "domain → path"; index them week → domain → {path: sessions}. */
function indexReferralLanding(rows) {
  const byWeek = {};
  const byDomain = {};
  for (const r of rows || []) {
    const cut = r.key.indexOf(' → '); // domains never contain the arrow; paths might
    if (cut === -1) continue;
    const domain = r.key.slice(0, cut);
    const pathname = r.key.slice(cut + 3) || '(none)';
    if (!domain || NOT_A_LINKING_SITE.test(domain)) continue; // same policy as the new-sites list
    const w = weekStart(r.date);
    ((byWeek[w] = byWeek[w] || {})[domain] = byWeek[w][domain] || {})[pathname] = (byWeek[w][domain][pathname] || 0) + r.sessions;
    (byDomain[domain] = byDomain[domain] || {})[pathname] = (byDomain[domain][pathname] || 0) + r.sessions;
  }
  return { byWeek, byDomain };
}

function topPages(pathCounts, n = 3) {
  const short = (p) => (p.length > 60 ? p.slice(0, 57) + '…' : p);
  return Object.entries(pathCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([p, c]) => `${short(p)} (${c})`).join(', ');
}

function plainSpike(s) {
  const when = `week of ${fmtDate(s.week)}`;
  const after = s.next === null ? '' : s.next === 0 ? ', then nothing the week after' : `, then ${s.next} the week after`;
  if (s.isNew) return `**${mdCell(s.key)}** (${s.tool} ${s.dimension.toLowerCase()}): new source, ${s.value} ${s.metric} in the ${when}${after}.`;
  return `**${mdCell(s.key)}** (${s.tool} ${s.dimension.toLowerCase()}): ${s.value} ${s.metric} in the ${when}, about ${s.multiple}x its usual ${s.priorMedian}${after}.`;
}

function buildReport({ ga, ph, startDate, endDate, weeks, currentWeek }) {
  const sections = { ph: [], ga: [] };
  const S = (id, tool, title, rows, metric, opts) => sectionFor({ id, tool, title, rows, metric, weeks, currentWeek, opts });
  if (!ph.skipped) {
    sections.ph.push(S('ph.channel', 'PostHog', 'Channel type', ph.channelType, 'sessions'));
    sections.ph.push(S('ph.referrer', 'PostHog', 'Referring domain', ph.referringDomain, 'sessions', { topN: 20, minAbs: 20 }));
    sections.ph.push(S('ph.utm', 'PostHog', 'UTM source / medium', ph.utmSource, 'sessions', { minAbs: 10, ratio: 2.5 }));
    sections.ph.push(S('ph.country', 'PostHog', 'Country', ph.country, 'sessions', { topN: 15 }));
    sections.ph.push(S('ph.landing', 'PostHog', 'Landing page (external arrivals)', ph.landing, 'sessions', { topN: 20, minAbs: 25 }));
  }
  if (!ga.skipped) {
    sections.ga.push(S('ga.channel', 'GA4', 'Channel group', ga.channel, 'engagedSessions'));
    sections.ga.push(S('ga.channelRaw', 'GA4', 'Channel group (raw sessions, includes bots)', ga.channel, 'sessions'));
    sections.ga.push(S('ga.sourceMedium', 'GA4', 'Source / medium', ga.sourceMedium, 'engagedSessions', { topN: 20, minAbs: 20 }));
    sections.ga.push(S('ga.campaign', 'GA4', 'Campaign', ga.campaign, 'sessions', { minAbs: 10, ratio: 2.5, normalizeKey: normalizeCampaign }));
    sections.ga.push(S('ga.country', 'GA4', 'Country', ga.country, 'engagedSessions', { topN: 15 }));
    sections.ga.push(S('ga.landing', 'GA4', 'Landing page', ga.landing, 'engagedSessions', { topN: 20, minAbs: 25 }));
  }
  const allSections = [...sections.ph, ...sections.ga];
  const bySec = (id) => allSections.find((x) => x.id === id);

  let md = `# Traffic sources — ${fmtDate(startDate)} to ${fmtDate(endDate)}\n\n`;

  // Problems first, so a degraded report never reads as a clean one.
  const problems = [];
  if (ga.skipped) problems.push(`GA4 skipped: ${ga.skipped}`);
  if (ph.skipped) problems.push(`PostHog skipped: ${ph.skipped}`);
  for (const [k, v] of Object.entries(ga.errors || {})) problems.push(`GA4 ${k} query failed: ${v}`);
  for (const [k, v] of Object.entries(ph.errors || {})) problems.push(`PostHog ${k} query failed: ${v}`);
  if (problems.length) md += `> ⚠️ **Incomplete report**\n${problems.map((p) => `> - ${p}`).join('\n')}\n\n`;

  // ---- What changed (plain English) ----
  md += `## What changed\n\n`;
  const allSpikes = [...sections.ph, ...sections.ga].flatMap((s) => s.spikes)
    .filter((s) => !/raw sessions/.test(s.dimension))
    // GA4's "(referral)" / "(direct)" / "(organic)" pseudo-campaigns duplicate the
    // channel rows and read as unfinished in the headline list (reader review).
    .filter((s) => !(s.dimension === 'Campaign' && /^\(/.test(s.key)))
    .sort((a, b) => (b.value - b.priorMedian) - (a.value - a.priorMedian));
  // One line per source per tool: its biggest jump above baseline (allSpikes is
  // sorted by excess). Repeat weeks show in the section tables.
  const seen = new Set();
  const headline = allSpikes.filter((s) => {
    const id = `${s.tool}|${s.dimension}|${s.key}`;
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });
  const refIdx = indexReferralLanding(ph.skipped ? [] : ph.referralLanding);
  if (headline.length) {
    md += `Biggest jumps in the window, across both tools (each is a source that did at least 3x its usual weekly volume, or appeared from nothing):\n\n`;
    for (const s of headline.slice(0, 12)) {
      let line = plainSpike(s);
      const pages = s.dimension === 'Referring domain' && refIdx.byWeek[s.week] && refIdx.byWeek[s.week][s.key];
      if (pages) line = line.replace(/\.$/, '') + `, landing on ${topPages(pages)}.`;
      md += `- ${line}\n`;
    }
    md += `\n`;
  } else {
    md += `No source spiked in the window.\n\n`;
  }

  // ---- Rising / falling over the last month ----
  md += `## Rising and falling\n\n`;
  const trendSeries = [];
  for (const [id, label] of [
    ['ph.referrer', 'referrer'],
    ['ph.channel', 'channel'],
    ['ph.utm', 'campaign source'],
    ['ph.landing', 'landing page'],
    ['ga.sourceMedium', 'GA4 source, engaged sessions'],
  ]) {
    const sec = bySec(id);
    if (sec && Object.keys(sec.series).length) trendSeries.push({ label, ...trendsFor(sec.series, weeks, currentWeek) });
  }
  const fullWeekCount = weeks.filter((w) => w !== currentWeek).length;
  const anyTrend = trendSeries.some((t) => t.rising.length || t.falling.length);
  if (fullWeekCount < 8) {
    md += `Needs 8 full weeks to compare; this report has ${fullWeekCount}.\n\n`;
  } else if (!trendSeries.length) {
    md += `_PostHog and GA4 source data unavailable._\n\n`;
  } else if (!anyTrend) {
    md += `Nothing moved more than 40% between the last 4 full weeks and the 4 before.\n\n`;
  } else {
    const t0 = trendSeries[0];
    md += `Typical week over the last 4 full weeks (from ${fmtDate(t0.recentWeeks[0])}) vs the typical week of the 4 before (from ${fmtDate(t0.priorWeeks[0])}). Medians, so one big week does not count as a trend. Rising needs 20+ visits in a typical week now; falling needs 20+ before.\n\n`;
    const fmtT = (t, x) => `**${mdCell(x.key)}** (${t.label}): ${x.recentPerWeek}/week now vs ${x.priorPerWeek}/week before` + (x.pct === null ? ' (new).' : ` (${x.pct > 0 ? '+' : ''}${x.pct}%).`);
    const rising = trendSeries.flatMap((t) => t.rising.slice(0, 4).map((x) => fmtT(t, x))).slice(0, 10);
    const falling = trendSeries.flatMap((t) => t.falling.slice(0, 4).map((x) => fmtT(t, x))).slice(0, 10);
    md += `**Rising**\n\n` + (rising.length ? rising.map((l) => `- ${l}`).join('\n') : '- nothing rising') + `\n\n`;
    md += `**Falling**\n\n` + (falling.length ? falling.map((l) => `- ${l}`).join('\n') : '- nothing falling') + `\n\n`;
  }

  // ---- New sites linking to you ----
  md += `## New sites linking to you\n\n`;
  const refSec = bySec('ph.referrer');
  if (refSec && Object.keys(refSec.series).length) {
    const fresh = newSources(refSec.series, weeks, currentWeek, { minTotal: 5 }).filter((x) => !NOT_A_LINKING_SITE.test(x.key));
    if (fresh.length) {
      md += `Referrers first seen in the second half of this window with 5+ visits since (a site may be older and only just got clicked, but it is new to these numbers). Worth a look: who are they and what did they link?\n\n`;
      for (const x of fresh.slice(0, 15)) {
        // Landing counts come from the SAME weeks as the visit count (second
        // half of the window, current week excluded), so the two agree.
        const pages = {};
        for (const w of x.lateWeeks) for (const [pth, c] of Object.entries((refIdx.byWeek[w] || {})[x.key] || {})) pages[pth] = (pages[pth] || 0) + c;
        md += `- **${mdCell(x.key)}**: ${x.late} visits since ${fmtDate(x.firstWeek)}` + (x.current ? ` (+${x.current} so far this week)` : '') + (Object.keys(pages).length ? `, landing on ${topPages(pages)}` : '') + `.\n`;
      }
      md += `\n`;
    } else {
      md += `No new referring site in the window.\n\n`;
    }
  } else {
    md += `_PostHog referrer data unavailable._\n\n`;
  }

  // ---- Where social and referral traffic lands ----
  md += `## Where referral traffic lands\n\n`;
  if (Object.keys(refIdx.byDomain).length) {
    const full = weeks.filter((w) => w !== currentWeek);
    const recent = full.slice(-4); // fewer than 4 on a short --days window; the label says how many
    const totals = {};
    for (const w of recent) for (const [d, pages] of Object.entries(refIdx.byWeek[w] || {})) {
      totals[d] = totals[d] || { sessions: 0, pages: {} };
      for (const [pth, c] of Object.entries(pages)) { totals[d].sessions += c; totals[d].pages[pth] = (totals[d].pages[pth] || 0) + c; }
    }
    const top = Object.entries(totals).sort((a, b) => b[1].sessions - a[1].sessions).slice(0, 10);
    if (top.length) {
      md += `Last ${recent.length} full week${recent.length === 1 ? '' : 's'}: everything that is not a search engine (social, forums, AI assistants, email clients) and the pages their visitors arrived on. This shows which page a site's readers came to, not which post or thread sent them; a post that worked shows up as one site sending visitors to one show page.\n\n`;
      md += fmtTable(['Referrer', `Visits (${recent.length} wks)`, 'Where they landed'], top.map(([d, t]) => [d, t.sessions, topPages(t.pages)]));
      md += `\n`;
    } else {
      md += `No non-search referral traffic in the last 4 full weeks.\n\n`;
    }
  } else {
    md += `_PostHog referrer data unavailable._\n\n`;
  }

  const channelSec = sections.ph[0] || sections.ga[0];
  if (channelSec && Object.keys(channelSec.series).length) {
    const rc = recentChange(channelSec.series, weeks, currentWeek);
    const full = weeks.filter((w) => w !== currentWeek);
    md += `**Channels, last full week (${fmtDate(full[full.length - 1])}) vs the average of the 4 weeks before**, ${channelSec.tool} ${channelSec.metric}:\n\n`;
    md += fmtTable(['Channel', 'Last full week', '4-week average', 'Change'],
      rc.map((r) => [r.key, r.last, r.avg, r.pct === null ? 'new' : `${r.pct > 0 ? '+' : ''}${r.pct}%`]));
    md += `\n`;
  }

  md += `## How to read this\n\n`;
  md += `- Weeks start on Monday. The current week (from ${fmtDate(currentWeek)}) is not finished, so it is shown but never counted as a spike.\n`;
  md += `- **PostHog** is the trustworthy count: it uses the Real Users lens (owner and the Singapore/China/Vietnam/Hong Kong bot geos excluded) and counts each visit once, by the referrer and page it arrived through.\n`;
  md += `- **GA4** counts are inflated by bots in Direct; the GA4 tables use "engaged sessions" (visits that stayed 10s+, viewed 2+ pages or converted), which drops most of that. One table shows raw sessions so the bot share is visible.\n`;
  md += `- "Usual per week" is the median of the earlier full weeks; "times usual" is this week divided by that.\n`;
  md += `- "Rising and falling" compares a typical week of the last 4 full weeks with a typical week of the 4 before (medians), so it catches steady drift without being fooled by one big week. "New sites" lists any referrer first seen mid-window with 5+ visits.\n`;
  md += `- Vercel Web Analytics has no query API, so it is not included; check its dashboard by hand if a spike needs a third opinion.\n`;
  md += `- GA4 days are in the property's timezone and PostHog days in the project's, so week edges can differ by a few hours.\n\n`;

  md += `## PostHog (Real Users lens)\n\n`;
  if (ph.skipped) md += `_Skipped: ${ph.skipped}_\n\n`;
  for (const s of sections.ph) md += s.md;

  md += `## GA4\n\n`;
  if (ga.skipped) md += `_Skipped: ${ga.skipped}_\n\n`;
  for (const s of sections.ga) md += s.md;

  return { md, problems, spikes: allSpikes };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('='); return [k, v ?? true];
  }));
  // --from-raw=<traffic-sources-raw.json>: re-render from a previous run's data
  // without querying (fast iteration on the wording, and the way a human
  // summary can be produced locally from a CI artifact).
  const fromRaw = typeof args['from-raw'] === 'string' ? JSON.parse(fs.readFileSync(args['from-raw'], 'utf8')) : null;
  const days = parseInt(args.days || '91', 10);
  if (!Number.isInteger(days) || days < 14 || days > 400) {
    console.error(`--days must be an integer between 14 and 400 (got ${args.days})`);
    process.exit(2);
  }
  const outDir = args.out || 'traffic-analysis';
  const end = new Date();
  const endDate = end.toISOString().slice(0, 10);
  // Snap the start back to a Monday so the first baseline week is complete.
  const startDate = weekStart(new Date(end.getTime() - days * 86400000).toISOString().slice(0, 10));
  const weeks = allWeeks(startDate, endDate);
  const currentWeek = weekStart(endDate);
  const range = { startDate, endDate };

  console.log(`Range ${startDate}..${endDate} (${weeks.length} weeks, current ${currentWeek})`);
  const [ga, ph] = fromRaw ? [fromRaw.ga, fromRaw.ph] : await Promise.all([
    fetchGa4(range).catch((e) => ({ skipped: `GA4 error: ${e.message}` })),
    fetchPostHog(range).catch((e) => ({ skipped: `PostHog error: ${e.message}` })),
  ]);
  if (fromRaw) { weeks.splice(0, weeks.length, ...fromRaw.weeks); }
  for (const [name, r] of [['GA4', ga], ['PostHog', ph]]) {
    if (r.skipped) console.log(`${name}: SKIPPED — ${r.skipped}`);
    else console.log(`${name}: ${Object.entries(r).filter(([k]) => k !== 'errors').map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
  }

  const cw = fromRaw ? fromRaw.currentWeek : currentWeek;
  const sd = fromRaw ? fromRaw.startDate : startDate;
  const ed = fromRaw ? fromRaw.endDate : endDate;

  // ---- long-running visit history (tiles, charts, /admin/traffic; BRO-4136) ----
  // --history=<store.json>: the store kept in the private data repo. It is
  // refreshed (last 6 weeks re-queried) and the merged store is written to
  // <out>/traffic-history.json ONLY when every history query succeeded; the
  // workflow pushes that file back. --from-raw reuses the raw file's history.
  let history = fromRaw ? fromRaw.history || null : null;
  let historyErrors = fromRaw ? fromRaw.historyErrors || {} : {};
  let historyRefreshed = false;
  if (!fromRaw && typeof args.history === 'string') {
    if (!process.env.POSTHOG_PERSONAL_API_KEY) historyErrors = { all: 'POSTHOG_PERSONAL_API_KEY not set' };
    else {
      let store = null;
      try { store = fs.existsSync(args.history) ? JSON.parse(fs.readFileSync(args.history, 'utf8')) : null; }
      catch (e) { historyErrors = { store: `could not read ${args.history}: ${e.message}` }; }
      if (!historyErrors.store) {
        const { refreshHistory } = require('./lib/traffic-history');
        const r = await refreshHistory({ store, endDate: ed, phQuery, withRetry, where: REAL_USERS_WHERE });
        historyErrors = r.errors;
        historyRefreshed = r.refreshed;
        // A failed refresh must not feed stale weeks into the tiles: fall back
        // to the 13-week rows (metrics mark what they cannot compute as "—").
        history = r.refreshed ? r.store : null;
        console.log(`History: ${r.refreshed ? `refreshed from ${r.from}, ${r.store.daily.length} days stored` : `NOT refreshed — ${JSON.stringify(r.errors)}`}`);
      }
    }
  }

  const { md, problems, spikes } = buildReport({ ga, ph, startDate: sd, endDate: ed, weeks, currentWeek: cw });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'traffic-sources-report.md'), md);
  // The owner-facing summary (what the email body is made of).
  const { buildHumanSummary, loadShows, pageName, sourceName, isOwnTooling, isDirect } = require('./lib/traffic-report-human');
  const showsPath = typeof args.shows === 'string' ? args.shows : [path.join(__dirname, '..', 'data', 'shows.json'), '/tmp/core-data-checkout/shows.json'].find((p) => fs.existsSync(p));
  const summary = buildHumanSummary({ ga, ph, weeks, currentWeek: cw, problems, showsPath });
  fs.writeFileSync(path.join(outDir, 'traffic-sources-summary.md'), summary);

  // Headline tiles + chart configs for the email, and the dashboard payload.
  const TM = require('./lib/traffic-metrics');
  const shows = loadShows(showsPath);
  const naming = { pageName: (p) => pageName(p, shows), sourceName, isOwnTooling, isDirect };
  const mctx = { history, ph, startDate: sd, endDate: ed, currentWeek: cw };
  const metrics = TM.computeTrafficMetrics({ ...mctx, naming });
  const charts = {
    weekly: TM.weeklyChartConfig(mctx),
    topPages: metrics.top.pages.length ? TM.topPagesChartConfig(metrics.top.pages, { weekStart: metrics.week.start }) : null,
  };
  fs.writeFileSync(path.join(outDir, 'traffic-metrics.json'), JSON.stringify({ metrics, tiles: TM.buildTiles(metrics), charts, historyErrors }, null, 1));
  if (historyRefreshed || (fromRaw && history)) {
    const dash = TM.buildDashboardData({ ...mctx, naming, metrics, generatedAt: new Date().toISOString() });
    fs.writeFileSync(path.join(outDir, 'traffic-dashboard.json'), JSON.stringify(dash));
    // Only a successful live refresh produces a store for the workflow to push back.
    if (historyRefreshed) fs.writeFileSync(path.join(outDir, 'traffic-history.json'), JSON.stringify(history));
    console.log(`Wrote traffic-dashboard.json (${dash.weeks.length} weeks, ${dash.months.length} months)${historyRefreshed ? ' + traffic-history.json' : ''}`);
  }

  fs.writeFileSync(path.join(outDir, 'traffic-sources-raw.json'), JSON.stringify({ startDate: sd, endDate: ed, weeks, currentWeek: cw, spikes, ga, ph, history, historyErrors }, null, 1));
  console.log(`Wrote ${path.join(outDir, 'traffic-sources-report.md')} (${md.length} chars, ${spikes.length} spikes) + traffic-sources-summary.md (${summary.length} chars) + traffic-metrics.json`);
  // History failures are reported apart from `problems` so the email subject
  // does not say "partial data" when only the tiles/charts history failed,
  // but they still turn the run red so the digest shows them.
  const historyProblems = Object.entries(historyErrors).map(([k, v]) => `history ${k}: ${v}`);
  for (const p of historyProblems) console.error(`::warning::${p}`);
  if (problems.length || historyProblems.length) {
    for (const p of problems) console.error(`::warning::${p}`);
    console.error(`${problems.length + historyProblems.length} problem(s) — report written but incomplete`);
    process.exit(1);
  }
}

module.exports = { weekStart, median, bucketWeekly, detectSpikes, allWeeks, recentChange, trendsFor, newSources, indexReferralLanding, buildReport, mdCell, normalizeCampaign, withRetry, isTransientPostHogError };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
