// BRO-2502: reuse the weekly geo audit's GA4 query for the morning digest.
const { fetchEngagedSessionsSummary } = require('./ga4-engaged-sessions');
const { queueDigestLine } = require('./owner-alert-router');

async function fetchAndQueueTrafficSummary(client, propertyId, now = new Date()) {
  const summary = await fetchEngagedSessionsSummary(client, propertyId, {
    startDate: '7daysAgo',
    endDate: 'yesterday',
  });
  const inflation = summary.inflationRatio === null ? 'n/a' : `${summary.inflationRatio.toFixed(1)}x`;
  // info rows render their title only. Keep both KPIs and the update date in
  // it so the snapshot-to-email path cannot drop the numbers or imply daily data.
  // Queue directly: a weekly statistic is not a recurring fault to escalate
  // through routeAlert() into a Linear task after repeated notifications.
  queueDigestLine({
    conditionKey: 'traffic:ga4-engaged-sessions',
    title: `Traffic (7d): ${summary.headline.toLocaleString('en-US')} engaged sessions; ` +
      `${inflation} raw-session inflation (${summary.totalSessions.toLocaleString('en-US')} raw sessions). ` +
      `Weekly update ${now.toISOString().slice(0, 10)}.`,
    description: 'GA4 engaged sessions across all channels for the seven completed days ending yesterday. Inflation is raw sessions divided by engaged sessions.',
    severity: 'info',
    info: true,
  });
  return summary;
}

module.exports = { fetchAndQueueTrafficSummary };
