#!/usr/bin/env node
/**
 * ga4-engaged-sessions.js — the `sessions_engaged` headline traffic KPI.
 *
 * GA4's "Direct" channel is ~80% bot traffic (per BRO-44 audit: 6.2% engagement,
 * 23s avg session) and drives the majority of reported raw `sessions`, overstating
 * real engagement roughly 5x (May 2026: 32,168 total sessions vs 5,680 engaged).
 * `engagedSessions` (GA4's own definition: session lasted 10s+, OR had a
 * conversion event, OR had 2+ pageviews/screenviews) already excludes almost all
 * of that bot volume, since bots typically fetch one URL and leave. Use the
 * `headline` field here — not raw `sessions` — wherever a single "how much
 * traffic did we get" number is reported.
 *
 * See docs/GA4_Engaged_Sessions_Report.md.
 */

// Pure aggregation — no I/O, unit-tested directly.
function summarizeChannelRows(rows) {
  const totalSessions = rows.reduce((sum, r) => sum + r.sessions, 0);
  const totalEngagedSessions = rows.reduce((sum, r) => sum + r.engagedSessions, 0);
  const direct = rows.find((r) => r.channel === 'Direct') || {
    channel: 'Direct',
    sessions: 0,
    engagedSessions: 0,
  };

  return {
    byChannel: rows,
    totalSessions,
    totalEngagedSessions,
    direct,
    sessionsExDirect: totalSessions - direct.sessions,
    engagedSessionsExDirect: totalEngagedSessions - direct.engagedSessions,
    // The headline KPI. `engagedSessions` already excludes non-engaged
    // sessions across every channel (including Direct), so no further
    // Direct-specific filtering is needed on top of it.
    headline: totalEngagedSessions,
    inflationRatio: totalEngagedSessions > 0 ? totalSessions / totalEngagedSessions : null,
  };
}

async function fetchEngagedSessionsSummary(client, propertyId, dateRange) {
  const [res] = await client.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [dateRange],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 20,
  });

  const rows = (res.rows || []).map((r) => ({
    channel: r.dimensionValues?.[0]?.value || '(not set)',
    sessions: parseInt(r.metricValues?.[0]?.value || '0', 10),
    engagedSessions: parseInt(r.metricValues?.[1]?.value || '0', 10),
  }));

  return { dateRange, ...summarizeChannelRows(rows) };
}

module.exports = { fetchEngagedSessionsSummary, summarizeChannelRows };
