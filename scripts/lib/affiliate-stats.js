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

  if (results[0].status === 'fulfilled') {
    const r = results[0].value;
    impact = r.skipped ? { skipped: true, reason: r.reason } : summarizeImpact(r.actions);
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
      const row = {
        platform: p.platform,
        clicks: p.count,
        conversions: null,
        commission: null,
        revenue: null,
        conversionRate: null,
        epc: null,
        affiliate: false,
      };
      // Try Impact match first (TodayTix, Ticketmaster, etc.)
      const impactMatch = impactByCampaign.get(p.platform);
      if (impactMatch) {
        row.conversions = impactMatch.count;
        row.commission = impactMatch.payout;
        row.revenue = impactMatch.revenue;
        row.affiliate = true;
      }
      // StubHub comes from Partnerize, not Impact
      if (p.platform === 'StubHub' && partnerize && !partnerize.skipped) {
        row.conversions = partnerize.conversions || 0;
        row.commission = 0; // Partnerize list API doesn't return commission
        row.revenue = null;
        row.affiliate = true;
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
        wowDelta = {
          commissionPct: priorCommission > 0
            ? ((totalCommission - priorCommission) / priorCommission) * 100
            : null,
          revenuePct: priorRevenue > 0
            ? ((totalRevenue - priorRevenue) / priorRevenue) * 100
            : null,
          priorCommission,
          priorRevenue,
        };
      }
    } catch (err) {
      errors.push({ provider: 'impact-prior', message: err.message });
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
    impact,
    partnerize,
    posthog,
    errors,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  getAffiliateStats,
  // Exported for testing / advanced callers
  analyzeTodaytixMix,
  summarizeImpact,
  clampDays,
  IMPACT_MAX_DAYS,
  RATE_BUMP_DATE,
};
