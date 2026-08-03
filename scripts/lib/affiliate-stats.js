/**
 * Affiliate stats module
 *
 * Fetches and aggregates performance data from Impact, Partnerize, and PostHog
 * for the affiliate report (scripts/affiliate-report.js) and the admin dashboard
 * (src/app/api/admin/affiliate-stats). Single source of truth for inference logic.
 *
 * Usage:
 *   const { getAffiliateStats } = require('./lib/affiliate-stats');
 *   const stats = await getAffiliateStats({ days: 7 });
 *
 * Returns a structured object (see buildEmptyStats). Partial provider failures
 * are captured in `errors[]` so callers can decide whether to cache/display.
 */

const PROVIDER_TIMEOUT_MS = 8000; // Each provider must return within 8s (Vercel 10s route cap)
const IMPACT_MAX_DAYS = 45;       // Impact API rejects date ranges > 45 days
const RATE_BUMP_DATE = new Date('2026-04-07T00:00:00Z'); // TodayTix 2% -> 5% cutover

// Platforms we have an affiliate program for — used to flag rows in the
// per-platform table as revenue-producing vs unmonetized, even when a
// platform has zero conversions in the current window. Derived from the
// shared config (src/config/affiliate-platforms.json) so it can never drift
// from what the site actually renders — `revenueReporting: true` covers the
// StubHub case (links hidden 2026-04-11, historical clicks still affiliate).
const AFFILIATE_PLATFORM_CONFIG = require('../../src/config/affiliate-platforms.json').platforms;
const AFFILIATE_PLATFORMS = new Set(
  Object.entries(AFFILIATE_PLATFORM_CONFIG)
    .filter(([, cfg]) => cfg.revenueReporting)
    .map(([name]) => name)
);

function fmtISO(d) {
  // Impact rejects millisecond precision
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ── Impact ─────────────────────────────────────────────────────────────

async function fetchImpact(startDate, endDate) {
  const sid = process.env.IMPACT_ACCOUNT_SID;
  const token = process.env.IMPACT_AUTH_TOKEN;
  if (!sid || !token) {
    return { skipped: true, reason: 'missing credentials' };
  }

  const url = `https://api.impact.com/Mediapartners/${sid}/Actions.json?StartDate=${fmtISO(startDate)}&EndDate=${fmtISO(endDate)}`;
  const { ok, data } = await fetchWithTimeout(url, {
    headers: { Authorization: basicAuth(sid, token), Accept: 'application/json' },
  });

  if (!ok || data.Status === 'ERROR') {
    const msg = data.Message || `HTTP error`;
    throw new Error(`Impact API error: ${msg}`);
  }

  return { actions: data.Actions || [] };
}

/**
 * Daily Impact performance series (clicks + actions + payout + sales per day)
 * via the partner_performance_by_day report. Actions.json cannot supply click
 * counts at all — this report is the only per-day click source (affiliate
 * hardening plan 2026-08-03, Codex review finding).
 *
 * Monitor-grade: THROWS on missing credentials instead of returning
 * {skipped} — a missing secret must surface as an auth failure, never as a
 * healthy-looking zero series.
 *
 * @param {number} days lookback (max 45)
 * @param {{now?: Date}} [opts] injectable clock for tests/replays
 * @returns {Promise<Array<{date:string, clicks:number, conversions:number, payout:number, sales:number}>>}
 */
async function fetchImpactDaily(days, opts = {}) {
  const sid = process.env.IMPACT_ACCOUNT_SID;
  const token = process.env.IMPACT_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('Impact credentials missing (IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN)');
  }
  const now = opts.now || new Date();
  const clamped = Math.min(Math.max(1, Math.floor(days)), IMPACT_MAX_DAYS);
  const start = new Date(now.getTime() - clamped * 24 * 60 * 60 * 1000);
  const url =
    `https://api.impact.com/Mediapartners/${sid}/Reports/partner_performance_by_day.json` +
    `?START_DATE=${fmtDate(start)}&END_DATE=${fmtDate(now)}&PageSize=${IMPACT_MAX_DAYS + 5}`;
  const { ok, status, data } = await fetchWithTimeout(url, {
    headers: { Authorization: basicAuth(sid, token), Accept: 'application/json' },
  });
  if (!ok) throw new Error(`Impact performance-by-day error: HTTP ${status}`);
  const records = data.Records || [];
  return records
    .map((r) => {
      // date_display is e.g. "Aug 3, 2026" — normalize to YYYY-MM-DD (UTC).
      const parsed = new Date(`${r.date_display} UTC`);
      if (Number.isNaN(parsed.getTime())) return null;
      return {
        date: parsed.toISOString().slice(0, 10),
        clicks: parseInt(r.Clicks, 10) || 0,
        conversions: parseInt(r.Actions, 10) || 0,
        payout: parseFloat(r.Action_Cost) || 0,
        sales: parseFloat(r.Sale_zzzAmount) || 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Raw Impact actions for a trailing window (monitor/report-grade: throws on
 * missing credentials). One fetch serves payout-anomaly checks, outlier
 * annotations AND the WoW/baseline maths — never two calls whose partial
 * failure can render a misleading "normal" report (Codex review finding).
 */
async function fetchImpactActionsWindow(days, opts = {}) {
  const sid = process.env.IMPACT_ACCOUNT_SID;
  const token = process.env.IMPACT_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('Impact credentials missing (IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN)');
  }
  const now = opts.now || new Date();
  const clamped = Math.min(Math.max(1, Math.floor(days)), IMPACT_MAX_DAYS);
  const start = new Date(now.getTime() - clamped * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const result = await fetchImpact(start, end);
  if (result.skipped) throw new Error(`Impact actions fetch skipped: ${result.reason}`);
  return result.actions;
}

/**
 * Daily PostHog ticket_click series with the REAL-USERS lens (owner + known
 * bot geos excluded — the same lens as memory/feedback_analytics_real_users_lens).
 * The legacy fetchPosthog() above deliberately keeps its unfiltered queries:
 * the weekly report and /admin/affiliate have shipped those numbers for
 * months and changing their basis silently would break every comparison.
 * The monitor needs the filtered series because bot clicks are one of the
 * exact anomalies it watches for.
 *
 * Monitor-grade: throws on missing credentials.
 *
 * @param {number} days lookback
 * @returns {Promise<Array<{date:string, clicks:number, ttClicks:number}>>}
 */
async function fetchPosthogDailyClicks(days, opts = {}) {
  const phKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const phProject = process.env.POSTHOG_PROJECT_ID;
  if (!phKey || !phProject) {
    throw new Error('PostHog credentials missing (POSTHOG_PERSONAL_API_KEY / POSTHOG_PROJECT_ID)');
  }
  const now = opts.now || new Date();
  const start = new Date(now.getTime() - Math.max(1, Math.floor(days)) * 24 * 60 * 60 * 1000);
  const hogql = `
    SELECT toDate(timestamp) AS d,
      count() AS clicks,
      countIf(properties.platform = 'TodayTix') AS tt_clicks
    FROM events
    WHERE event = 'ticket_click'
      AND timestamp >= toDateTime('${start.toISOString()}')
      AND timestamp <= toDateTime('${now.toISOString()}')
      AND coalesce(JSONExtractString(person.properties, 'is_owner'), '') != 'true'
      AND properties.$geoip_country_code NOT IN ('SG', 'CN', 'VN')
    GROUP BY d ORDER BY d
  `;
  const { ok, status, data } = await fetchWithTimeout(
    `https://us.posthog.com/api/projects/${phProject}/query/`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${phKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
    }
  );
  if (!ok) throw new Error(`PostHog daily clicks error: HTTP ${status}`);
  return (data.results || []).map(([d, clicks, tt]) => ({
    date: String(d).slice(0, 10),
    clicks: Number(clicks) || 0,
    ttClicks: Number(tt) || 0,
  }));
}

/**
 * TodayTix customer mix is inferred from payout/sale ratio since Impact API
 * does not expose CustomerStatus on Actions. Contract terms:
 *   1% = existing (all contracts)
 *   2% = new, old contract (before 2026-04-07)
 *   5% = new, current contract "5%/1%" template 243224 (from 2026-04-07)
 * See memory/feedback_todaytix_affiliate_tracking.md
 */
function analyzeTodaytixMix(ttActions) {
  let newCount = 0, existingCount = 0, unknownCount = 0;
  let newRevenue = 0, existingRevenue = 0;
  let newPayout = 0, existingPayout = 0;
  let uplift = 0;

  const near = (r, t) => Math.abs(r - t) < 0.2;

  for (const a of ttActions) {
    const amount = parseFloat(a.Amount || 0);
    const payout = parseFloat(a.Payout || 0);
    if (amount <= 0) { unknownCount++; continue; }
    const ratePct = (payout / amount) * 100;
    const isNew = near(ratePct, 5) || near(ratePct, 2);
    const isExisting = near(ratePct, 1);
    if (isNew) {
      newCount++;
      newRevenue += amount;
      newPayout += payout;
      if (new Date(a.EventDate) >= RATE_BUMP_DATE && near(ratePct, 5)) {
        uplift += amount * 0.03; // 5% - 2% = 3pp vs old contract
      }
    } else if (isExisting) {
      existingCount++;
      existingRevenue += amount;
      existingPayout += payout;
    } else {
      unknownCount++;
    }
  }

  return {
    newCount, existingCount, unknownCount,
    newRevenue, existingRevenue,
    newPayout, existingPayout,
    rateBumpUplift: uplift,
  };
}

function summarizeImpact(actions) {
  const byCampaign = {};
  let totalRevenue = 0, totalPayout = 0;

  for (const a of actions) {
    const name = a.CampaignName || 'Unknown';
    if (!byCampaign[name]) {
      byCampaign[name] = { name, count: 0, revenue: 0, payout: 0 };
    }
    const amount = parseFloat(a.Amount || 0);
    const payout = parseFloat(a.Payout || 0);
    byCampaign[name].count++;
    byCampaign[name].revenue += amount;
    byCampaign[name].payout += payout;
    totalRevenue += amount;
    totalPayout += payout;
  }

  const ttActions = actions.filter(a => a.CampaignName === 'TodayTix');
  const todaytixMix = ttActions.length > 0 ? analyzeTodaytixMix(ttActions) : null;

  return {
    conversions: actions.length,
    totalRevenue,
    totalPayout,
    byCampaign: Object.values(byCampaign).sort((a, b) => b.payout - a.payout),
    todaytixMix,
  };
}

// ── Partnerize ─────────────────────────────────────────────────────────

async function fetchPartnerize(startDate, endDate) {
  const appKey = process.env.PARTNERIZE_APP_KEY;
  const apiKey = process.env.PARTNERIZE_API_KEY;
  const pubId = process.env.PARTNERIZE_PUBLISHER_ID;
  if (!appKey || !apiKey || !pubId) {
    return { skipped: true, reason: 'missing credentials' };
  }

  const auth = { headers: { Authorization: basicAuth(appKey, apiKey), Accept: 'application/json' } };
  const base = `https://api.partnerize.com/reporting/report_publisher/publisher/${pubId}`;
  const qs = `?start_date=${fmtISO(startDate)}&end_date=${fmtISO(endDate)}`;

  const [clicks, conversions] = await Promise.all([
    fetchWithTimeout(`${base}/click.json${qs}`, auth),
    fetchWithTimeout(`${base}/conversion.json${qs}`, auth),
  ]);

  if (!clicks.ok) throw new Error(`Partnerize clicks error: ${clicks.status}`);
  if (!conversions.ok) throw new Error(`Partnerize conversions error: ${conversions.status}`);

  const clickCount = clicks.data.count || 0;
  const convCount = conversions.data.count || 0;

  return {
    clicks: clickCount,
    conversions: convCount,
    conversionRate: clickCount > 0 ? convCount / clickCount : 0,
  };
}

// ── PostHog ────────────────────────────────────────────────────────────

/**
 * Single HogQL query returns the entire funnel in one round-trip:
 *   total pageviews, show pageviews, ticket clicks, plus per-platform clicks.
 *
 * Why HogQL not /events: scanning raw events for a 7-day window is O(thousands)
 * and breaks the 8s timeout. HogQL aggregates server-side and returns scalars.
 */
async function fetchPosthog(startDate, endDate) {
  const phKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const phProject = process.env.POSTHOG_PROJECT_ID;
  if (!phKey || !phProject) {
    return { skipped: true, reason: 'missing credentials' };
  }

  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();
  const queryUrl = `https://us.posthog.com/api/projects/${phProject}/query/`;
  const headers = {
    Authorization: `Bearer ${phKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Funnel scalars: pageviews + show pageviews + ticket clicks
  const scalarsHogQL = `
    SELECT
      countIf(event = '$pageview') AS pageviews,
      countIf(event = '$pageview' AND properties.$pathname LIKE '/show/%') AS show_pageviews,
      countIf(event = 'ticket_click') AS ticket_clicks
    FROM events
    WHERE timestamp >= toDateTime('${startISO}') AND timestamp <= toDateTime('${endISO}')
      AND (event = '$pageview' OR event = 'ticket_click')
  `;
  // Per-platform click breakdown
  const platformsHogQL = `
    SELECT properties.platform AS platform, count() AS clicks
    FROM events
    WHERE event = 'ticket_click'
      AND timestamp >= toDateTime('${startISO}') AND timestamp <= toDateTime('${endISO}')
    GROUP BY platform
    ORDER BY clicks DESC
  `;

  const [scalarsRes, platformsRes] = await Promise.all([
    fetchWithTimeout(queryUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: scalarsHogQL } }),
    }),
    fetchWithTimeout(queryUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: platformsHogQL } }),
    }),
  ]);

  if (!scalarsRes.ok) throw new Error(`PostHog HogQL scalars error: ${scalarsRes.status}`);
  if (!platformsRes.ok) throw new Error(`PostHog HogQL platforms error: ${platformsRes.status}`);

  const [pageviews = 0, showPageviews = 0, ticketClicks = 0] = scalarsRes.data.results?.[0] || [];
  const byPlatform = (platformsRes.data.results || []).map(([platform, count]) => ({
    platform: platform || 'Unknown',
    count: Number(count) || 0,
  }));

  return {
    pageviews: Number(pageviews) || 0,
    showPageviews: Number(showPageviews) || 0,
    totalClicks: Number(ticketClicks) || 0,
    byPlatform,
  };
}

// ── Orchestration ──────────────────────────────────────────────────────

function clampDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1) return 7;
  return Math.min(Math.floor(n), IMPACT_MAX_DAYS);
}

function buildWindow(days) {
  const end = new Date();
  const endBuffered = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return { start, end, endBuffered };
}

/**
 * Main entry point. Fetches all providers in parallel with per-provider
 * timeouts and captures failures in errors[].
 *
 * @param {object} opts
 * @param {number} opts.days - Lookback window (clamped 1-45)
 * @param {boolean} [opts.includeWoW=false] - Fetch prior equivalent window for delta
 * @returns {Promise<object>} stats
 */
async function getAffiliateStats({ days = 7, includeWoW = false } = {}) {
  const clampedDays = clampDays(days);
  const window = buildWindow(clampedDays);

  const results = await Promise.allSettled([
    fetchImpact(window.start, window.endBuffered),
    fetchPartnerize(window.start, window.end),
    fetchPosthog(window.start, window.end),
  ]);

  const errors = [];
  let impact = null, partnerize = null, posthog = null;
  let rawActions = null; // current-window Impact actions, reused for report context

  if (results[0].status === 'fulfilled') {
    const r = results[0].value;
    if (r.skipped) {
      impact = { skipped: true, reason: r.reason };
    } else {
      impact = summarizeImpact(r.actions);
      rawActions = r.actions;
    }
  } else {
    errors.push({ provider: 'impact', message: results[0].reason?.message || String(results[0].reason) });
  }

  if (results[1].status === 'fulfilled') {
    partnerize = results[1].value;
  } else {
    errors.push({ provider: 'partnerize', message: results[1].reason?.message || String(results[1].reason) });
  }

  if (results[2].status === 'fulfilled') {
    posthog = results[2].value;
  } else {
    errors.push({ provider: 'posthog', message: results[2].reason?.message || String(results[2].reason) });
  }

  // Top-line totals (sum of program commissions)
  let totalCommission = 0, totalRevenue = 0, totalConversions = 0;
  if (impact && !impact.skipped) {
    totalCommission += impact.totalPayout || 0;
    totalRevenue += impact.totalRevenue || 0;
    totalConversions += impact.conversions || 0;
  }
  if (partnerize && !partnerize.skipped) {
    totalConversions += partnerize.conversions || 0;
    // Partnerize API doesn't return revenue/commission on the list endpoints
  }

  // ── Funnel: pageviews -> show pageviews -> ticket clicks -> conversions -> commission ──
  const funnel = {
    showPageviews: posthog && !posthog.skipped ? posthog.showPageviews : null,
    ticketClicks: posthog && !posthog.skipped ? posthog.totalClicks : null,
    conversions: totalConversions,
    commission: totalCommission,
    // Conversion rates between adjacent stages (null when denominator is 0/missing)
    rates: {
      clicksPerShowView: null,    // ticketClicks / showPageviews
      convsPerClick: null,        // conversions / ticketClicks
      epc: null,                  // commission / ticketClicks (earnings per click)
    },
  };
  if (funnel.showPageviews && funnel.showPageviews > 0 && funnel.ticketClicks != null) {
    funnel.rates.clicksPerShowView = funnel.ticketClicks / funnel.showPageviews;
  }
  if (funnel.ticketClicks && funnel.ticketClicks > 0) {
    funnel.rates.convsPerClick = funnel.conversions / funnel.ticketClicks;
    funnel.rates.epc = funnel.commission / funnel.ticketClicks;
  }

  // ── Unit economics ──
  const unitEconomics = {
    avgOrderValue: totalConversions > 0 ? totalRevenue / totalConversions : null,
    avgCommissionPerConv: totalConversions > 0 ? totalCommission / totalConversions : null,
    takeRate: totalRevenue > 0 ? totalCommission / totalRevenue : null,
    earningsPerClick: funnel.rates.epc,
  };

  // ── Per-platform efficiency table ──
  // Joins PostHog clicks (every platform we link to) with Impact campaign data
  // (TodayTix, Ticketmaster, etc.) and Partnerize (StubHub). Platforms with no
  // affiliate program show clicks only — surfacing how much traffic we send for free.
  const perPlatform = [];
  if (posthog && !posthog.skipped) {
    const impactByCampaign = new Map();
    if (impact && !impact.skipped && impact.byCampaign) {
      for (const c of impact.byCampaign) impactByCampaign.set(c.name, c);
    }
    for (const p of posthog.byPlatform) {
      // A platform is an affiliate if we have a program for it, regardless
      // of whether it produced conversions in the current window. The old
      // logic (affiliate: true only when byCampaign had a match) made
      // zero-conversion affiliates like Ticketmaster display as non-affiliate.
      const row = {
        platform: p.platform,
        clicks: p.count,
        conversions: null,
        commission: null,
        revenue: null,
        conversionRate: null,
        epc: null,
        affiliate: AFFILIATE_PLATFORMS.has(p.platform),
      };
      // Impact match (TodayTix, Ticketmaster, Vivid Seats, SeatPlan) —
      // only present if the campaign had conversions in the window
      const impactMatch = impactByCampaign.get(p.platform);
      if (impactMatch) {
        row.conversions = impactMatch.count;
        row.commission = impactMatch.payout;
        row.revenue = impactMatch.revenue;
      } else if (row.affiliate && p.platform !== 'StubHub') {
        // Affiliate with zero conversions in the window — show $0 not —
        // so the EPC column reflects reality (zero, not unknown)
        row.conversions = 0;
        row.commission = 0;
        row.revenue = 0;
      }
      // StubHub comes from Partnerize, not Impact
      if (p.platform === 'StubHub' && partnerize && !partnerize.skipped) {
        row.conversions = partnerize.conversions || 0;
        row.commission = 0; // Partnerize list API doesn't return commission
        row.revenue = null;
      }
      if (row.clicks > 0 && row.conversions != null) {
        row.conversionRate = row.conversions / row.clicks;
      }
      if (row.clicks > 0 && row.commission != null) {
        row.epc = row.commission / row.clicks;
      }
      perPlatform.push(row);
    }
    perPlatform.sort((a, b) => (b.commission || 0) - (a.commission || 0) || b.clicks - a.clicks);
  }

  // WoW delta: fetch prior equivalent window (only if caller requested and window fits)
  let wowDelta = null;
  if (includeWoW && clampedDays * 2 <= IMPACT_MAX_DAYS) {
    const priorEnd = new Date(window.start);
    const priorStart = new Date(priorEnd.getTime() - clampedDays * 24 * 60 * 60 * 1000);
    try {
      const prior = await fetchImpact(priorStart, priorEnd);
      if (!prior.skipped) {
        const priorSummary = summarizeImpact(prior.actions);
        const priorCommission = priorSummary.totalPayout;
        const priorRevenue = priorSummary.totalRevenue;
        const priorConversions = priorSummary.conversions;
        // WoW compares Impact-to-Impact (commission/revenue/conversions all come
        // from Impact; Partnerize returns no revenue and the prior window only
        // fetches Impact). curCommission/Revenue == totals here since Partnerize
        // contributes 0 commission, but curConversions excludes Partnerize so the
        // delta stays apples-to-apples.
        const curCommission = impact && !impact.skipped ? impact.totalPayout : 0;
        const curRevenue = impact && !impact.skipped ? impact.totalRevenue : 0;
        const curConversions = impact && !impact.skipped ? impact.conversions : 0;
        wowDelta = {
          commissionPct: priorCommission > 0
            ? ((curCommission - priorCommission) / priorCommission) * 100
            : null,
          revenuePct: priorRevenue > 0
            ? ((curRevenue - priorRevenue) / priorRevenue) * 100
            : null,
          conversionsPct: priorConversions > 0
            ? ((curConversions - priorConversions) / priorConversions) * 100
            : null,
          priorCommission,
          priorRevenue,
          priorConversions,
          priorStartDate: fmtDate(priorStart),
          priorEndDate: fmtDate(priorEnd),
        };
      }
    } catch (err) {
      errors.push({ provider: 'impact-prior', message: err.message });
    }
  }

  // ── Report context: trailing baseline + outlier annotations ──────────────
  // Panic-proofing (affiliate hardening 2026-08-03): the raw WoW delta once
  // read -77.6% against a prior week inflated by one 11-conversion day, 6 of
  // them a single buyer. This block gives every WoW number its context. All
  // derived from ONE extra performance-report call + the current window's
  // already-fetched raw actions; failure → context.partial so the email can
  // say "PARTIAL DATA" instead of rendering silently-normal numbers.
  let context = null;
  if (includeWoW) {
    context = { partial: false };
    try {
      const {
        baselineComparison,
        findOutlierDays,
        findRepeatBuyers,
      } = require('./affiliate-anomaly');
      // Anchor per-day baseline math on the last COMPLETE day — window.end is
      // "now", and counting a partial day as a whole day deflates "$/day now"
      // every time the report runs midday (Codex ship-check finding).
      const asOf = fmtDate(new Date(window.end.getTime() - 24 * 60 * 60 * 1000));
      if (rawActions) {
        context.outlierDays = findOutlierDays(rawActions, { share: 0.4 });
        context.repeatBuyers = findRepeatBuyers(rawActions, { minConversions: 3 });
      } else {
        context.partial = true;
      }
      const baselineSpan = Math.min(clampedDays + 28, IMPACT_MAX_DAYS);
      const dailyPerf = await fetchImpactDaily(baselineSpan, { now: window.end });
      context.baseline = baselineComparison(dailyPerf, {
        asOf,
        windowDays: clampedDays,
        baselineDays: baselineSpan - clampedDays,
      });
      // Bot-divergence note: Impact-recorded clicks vs real PostHog clicks
      // over the window (Jul 31–Aug 2 2026 saw 2-3x bot inflation).
      const impactWindowClicks = dailyPerf
        .filter((d) => d.date > fmtDate(window.start) && d.date <= asOf)
        .reduce((s, d) => s + d.clicks, 0);
      if (posthog && !posthog.skipped && posthog.totalClicks > 0) {
        context.impactClicks = impactWindowClicks;
        context.clickDivergenceRatio = impactWindowClicks / posthog.totalClicks;
      }
    } catch (err) {
      context.partial = true;
      errors.push({ provider: 'impact-baseline', message: err.message });
    }
  }

  return {
    window: {
      days: clampedDays,
      startDate: fmtDate(window.start),
      endDate: fmtDate(window.end),
    },
    totals: {
      commission: totalCommission,
      revenue: totalRevenue, // gross ticket sales attributed (NOT our revenue)
      conversions: totalConversions,
    },
    funnel,
    unitEconomics,
    perPlatform,
    wowDelta,
    context,
    impact,
    partnerize,
    posthog,
    errors,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getAffiliateStats,
  // Monitor-grade fetchers (throw on missing credentials — affiliate hardening 2026-08-03)
  fetchImpactDaily,
  fetchImpactActionsWindow,
  fetchPosthogDailyClicks,
  // Exported for testing / advanced callers
  analyzeTodaytixMix,
  summarizeImpact,
  clampDays,
  AFFILIATE_PLATFORMS,
  AFFILIATE_PLATFORM_CONFIG,
  IMPACT_MAX_DAYS,
  RATE_BUMP_DATE,
};
