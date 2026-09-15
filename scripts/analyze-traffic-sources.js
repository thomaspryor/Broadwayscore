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
 * Env: GA4_PROPERTY_ID + GA_SERVICE_ACCOUNT_KEY (base64 JSON) or GA_KEY_FILE;
 *      POSTHOG_PERSONAL_API_KEY. Either tool may be missing — the other still runs.
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

// GA4 runReport hard-caps at 100k rows per call; date × landingPage over 91
// days can plausibly exceed it. rowCount is checked so truncation is loud, not
// silent (same failure class as the HogQL ~100-row cap).
const GA_ROW_LIMIT = 100000;

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
 * A week is a spike when value >= minAbs AND
 *   - prior weeks have a median of 0 (new source), or
 *   - value >= ratio * median(prior weeks) with at least 2 prior weeks.
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
      const isNew = med === 0 && prior.every((p) => p < minAbs / 3);
      if (isNew || (prior.length >= 2 && v >= ratio * med)) {
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

function fmtTable(headers, rows) {
  if (!rows.length) return '_No data_\n';
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const r of rows) lines.push(`| ${r.map((v) => String(v ?? '—')).join(' | ')} |`);
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
  const [channel, sourceMedium, campaign, landing, country] = await Promise.all([
    gaRows(client, propertyId, dateRange, 'sessionDefaultChannelGroup', metrics),
    gaRows(client, propertyId, dateRange, 'sessionSourceMedium', metrics),
    gaRows(client, propertyId, dateRange, 'sessionCampaignName', metrics),
    gaRows(client, propertyId, dateRange, 'landingPage', ['sessions', 'engagedSessions']),
    gaRows(client, propertyId, dateRange, 'country', ['sessions', 'engagedSessions']),
  ]);
  return { channel, sourceMedium, campaign, landing, country };
}

// ---------- PostHog ----------

async function phDaily(expr, days, extraWhere = '') {
  // Explicit LIMIT — HogQL silently caps GROUP BY results at ~100 rows
  // (memory/feedback_posthog_hogql_default_row_limit.md).
  const rows = await phQuery(`
    SELECT toDate(timestamp) AS d, ${expr} AS k,
           count() AS pageviews, count(DISTINCT $session_id) AS sessions, count(DISTINCT person_id) AS users
    FROM events
    WHERE event = '$pageview' AND timestamp > now() - interval ${days} day
      AND ${REAL_USERS_WHERE} ${extraWhere}
    GROUP BY d, k
    ORDER BY d
    LIMIT 100000`);
  return rows.map(([d, k, pageviews, sessions, users]) => ({
    date: String(d).slice(0, 10), key: k === null || k === '' ? '(none)' : String(k), pageviews, sessions, users,
  }));
}

async function fetchPostHog(days) {
  if (!process.env.POSTHOG_PERSONAL_API_KEY) return { skipped: 'POSTHOG_PERSONAL_API_KEY not set' };
  const out = {};
  const q = async (name, fn) => { try { out[name] = await fn(); } catch (e) { out[name + 'Error'] = e.message; out[name] = []; } };
  await q('referringDomain', () => phDaily(`coalesce(nullIf(properties.$referring_domain, ''), '$direct')`, days));
  await q('utmSource', () => phDaily(`concat(coalesce(properties.utm_source, ''), ' / ', coalesce(properties.utm_medium, ''))`, days, `AND properties.utm_source IS NOT NULL AND properties.utm_source != ''`));
  await q('country', () => phDaily(`coalesce(properties.$geoip_country_name, '(unknown)')`, days));
  await q('landing', () => phDaily(`coalesce(properties.$pathname, '(none)')`, days, `AND (properties.$referring_domain IS NULL OR properties.$referring_domain NOT LIKE '%broadwayscorecard.com%')`));
  // Session-level channel type (PostHog's own classification, mirrors GA4 channel groups).
  await q('channelType', () => phDaily(`coalesce(session.$channel_type, '(unknown)')`, days));
  return out;
}

// ---------- report ----------

function seriesFor(rows, metric) {
  return bucketWeekly(rows.map((r) => ({ date: r.date, key: r.key, value: r[metric] })));
}

function sectionFor(title, rows, metric, weeks, currentWeek, opts = {}) {
  if (!rows || !rows.length) return `### ${title}\n_No data_\n\n`;
  const series = seriesFor(rows, metric);
  const spikes = detectSpikes(series, weeks, { currentWeek, ...opts });
  let md = `### ${title} (${metric}/week)\n\n`;
  md += fmtWeeklyMatrix(series, weeks, opts.topN || 12) + '\n';
  if (spikes.length) {
    md += `**Spikes** (≥${opts.minAbs || 30}/week and ≥${opts.ratio || 3}x prior median, or brand new):\n\n`;
    md += fmtTable(['Source', 'Week', metric, 'Prior median', 'Multiple', 'Following week', 'New?'],
      spikes.slice(0, 15).map((s) => [s.key, s.week, s.value, s.priorMedian, s.multiple ?? '∞', s.next ?? '(current)', s.isNew ? 'yes' : '']));
  } else {
    md += '_No spikes detected._\n';
  }
  return md + '\n';
}

function buildReport({ ga, ph, startDate, endDate, weeks, currentWeek }) {
  let md = `# Traffic source analysis — ${startDate} to ${endDate}\n\n`;
  md += `Weeks are ISO weeks starting Monday; the current partial week (${currentWeek}) is shown but excluded from spike detection. `;
  md += `Vercel Web Analytics has no query API and is not included. GA4 counts include bot traffic in Direct; PostHog uses the Real Users lens (owner + SG/CN/VN excluded). `;
  md += `GA4 days are in the property's timezone and PostHog days in the project's, so week edges can differ by a few hours.\n\n`;

  md += `## PostHog (Real Users lens)\n\n`;
  if (ph.skipped) md += `_Skipped: ${ph.skipped}_\n\n`;
  else {
    for (const k of Object.keys(ph).filter((k) => k.endsWith('Error'))) md += `_${k}: ${ph[k]}_\n\n`;
    md += sectionFor('Channel type', ph.channelType, 'sessions', weeks, currentWeek);
    md += sectionFor('Referring domain', ph.referringDomain, 'sessions', weeks, currentWeek, { topN: 20, minAbs: 20 });
    md += sectionFor('UTM source / medium', ph.utmSource, 'sessions', weeks, currentWeek, { minAbs: 10, ratio: 2.5 });
    md += sectionFor('Country', ph.country, 'sessions', weeks, currentWeek, { topN: 15 });
    md += sectionFor('External landing page', ph.landing, 'sessions', weeks, currentWeek, { topN: 20, minAbs: 25 });
  }

  md += `## GA4\n\n`;
  if (ga.skipped) md += `_Skipped: ${ga.skipped}_\n\n`;
  else {
    md += sectionFor('Default channel group', ga.channel, 'engagedSessions', weeks, currentWeek);
    md += sectionFor('Default channel group (raw sessions, bot-inflated)', ga.channel, 'sessions', weeks, currentWeek);
    md += sectionFor('Source / medium', ga.sourceMedium, 'engagedSessions', weeks, currentWeek, { topN: 20, minAbs: 20 });
    md += sectionFor('Campaign', ga.campaign, 'sessions', weeks, currentWeek, { minAbs: 10, ratio: 2.5 });
    md += sectionFor('Country', ga.country, 'engagedSessions', weeks, currentWeek, { topN: 15 });
    md += sectionFor('Landing page', ga.landing, 'engagedSessions', weeks, currentWeek, { topN: 20, minAbs: 25 });
  }
  return md;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('='); return [k, v ?? true];
  }));
  const days = parseInt(args.days || '91', 10);
  if (!Number.isInteger(days) || days < 14 || days > 400) {
    console.error(`--days must be an integer between 14 and 400 (got ${args.days})`);
    process.exit(2);
  }
  const outDir = args.out || 'traffic-analysis';
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const endDate = end.toISOString().slice(0, 10);
  const startDate = start.toISOString().slice(0, 10);
  const weeks = allWeeks(startDate, endDate);
  const currentWeek = weekStart(endDate);

  console.log(`Range ${startDate}..${endDate} (${weeks.length} weeks)`);
  const [ga, ph] = await Promise.all([
    fetchGa4({ startDate, endDate }).catch((e) => ({ skipped: `GA4 error: ${e.message}` })),
    fetchPostHog(days).catch((e) => ({ skipped: `PostHog error: ${e.message}` })),
  ]);
  for (const [name, r] of [['GA4', ga], ['PostHog', ph]]) {
    if (r.skipped) console.log(`${name}: SKIPPED — ${r.skipped}`);
    else console.log(`${name}: ${Object.entries(r).map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v}`).join(', ')}`);
  }

  const report = buildReport({ ga, ph, startDate, endDate, weeks, currentWeek });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'traffic-sources-report.md'), report);
  fs.writeFileSync(path.join(outDir, 'traffic-sources-raw.json'), JSON.stringify({ startDate, endDate, weeks, ga, ph }, null, 1));
  console.log(`Wrote ${path.join(outDir, 'traffic-sources-report.md')} (${report.length} chars)`);
  if (ga.skipped && ph.skipped) { console.error('Both sources skipped'); process.exit(1); }
}

module.exports = { weekStart, median, bucketWeekly, detectSpikes, allWeeks };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
