#!/usr/bin/env node
/**
 * Weekly affiliate performance report.
 *
 * Pulls data from Impact, Partnerize, and PostHog APIs, computes key metrics,
 * and outputs a summary. Can be piped to email or run in CI.
 *
 * Usage:
 *   node scripts/affiliate-report.js                    # last 7 days
 *   node scripts/affiliate-report.js --days 30          # last 30 days
 *   node scripts/affiliate-report.js --email            # send via Gmail draft
 *
 * Requires env vars:
 *   IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN
 *   PARTNERIZE_APP_KEY, PARTNERIZE_API_KEY, PARTNERIZE_PUBLISHER_ID
 *   POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID
 */

const https = require('https');

const DAYS = (() => {
  const idx = process.argv.indexOf('--days');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 7;
})();

const endDate = new Date();
// Add 1 day buffer to end date to catch timezone edge cases
const endDateBuffered = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
const startDate = new Date(endDate.getTime() - DAYS * 24 * 60 * 60 * 1000);
const fmt = d => d.toISOString().split('T')[0];
const fmtISO = d => d.toISOString();

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'Accept': 'application/json', ...headers },
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve({ error: body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchBasicAuth(url, user, pass) {
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  return fetchJSON(url, { Authorization: `Basic ${auth}` });
}

async function main() {
  console.log(`\n📊 Affiliate Performance Report (${fmt(startDate)} to ${fmt(endDate)})\n`);
  console.log('='.repeat(60));

  // ── Impact (TodayTix, Ticketmaster, SeatPlan, Vivid Seats) ──
  const impactSid = process.env.IMPACT_ACCOUNT_SID;
  const impactToken = process.env.IMPACT_AUTH_TOKEN;

  let impactActions = [];
  if (impactSid && impactToken) {
    const data = await fetchBasicAuth(
      `https://api.impact.com/Mediapartners/${impactSid}/Actions.json?StartDate=${fmtISO(startDate)}&EndDate=${fmtISO(endDateBuffered)}`,
      impactSid, impactToken
    );
    impactActions = data.Actions || [];
    console.log('\n── Impact (TodayTix, Ticketmaster, SeatPlan, Vivid Seats) ──');
    console.log(`Conversions: ${impactActions.length}`);

    if (impactActions.length > 0) {
      const totalRevenue = impactActions.reduce((s, a) => s + parseFloat(a.Amount || 0), 0);
      const totalPayout = impactActions.reduce((s, a) => s + parseFloat(a.Payout || 0), 0);
      const byCampaign = {};
      impactActions.forEach(a => {
        const name = a.CampaignName || 'Unknown';
        if (!byCampaign[name]) byCampaign[name] = { count: 0, revenue: 0, payout: 0 };
        byCampaign[name].count++;
        byCampaign[name].revenue += parseFloat(a.Amount || 0);
        byCampaign[name].payout += parseFloat(a.Payout || 0);
      });

      console.log(`Total ticket sales: $${totalRevenue.toFixed(2)}`);
      console.log(`Total commission: $${totalPayout.toFixed(2)}`);
      console.log('By campaign:');
      Object.entries(byCampaign).forEach(([name, d]) => {
        console.log(`  ${name}: ${d.count} sales, $${d.revenue.toFixed(2)} revenue, $${d.payout.toFixed(2)} commission`);
      });
    } else {
      console.log('No conversions yet.');
    }
  } else {
    console.log('\n── Impact: SKIPPED (no credentials) ──');
  }

  // ── Partnerize (StubHub) ──
  const pzAppKey = process.env.PARTNERIZE_APP_KEY;
  const pzApiKey = process.env.PARTNERIZE_API_KEY;
  const pzPubId = process.env.PARTNERIZE_PUBLISHER_ID;

  if (pzAppKey && pzApiKey && pzPubId) {
    console.log('\n── Partnerize (StubHub) ──');

    const clickData = await fetchBasicAuth(
      `https://api.partnerize.com/reporting/report_publisher/publisher/${pzPubId}/click.json?start_date=${fmtISO(startDate)}&end_date=${fmtISO(endDate)}`,
      pzAppKey, pzApiKey
    );
    const clickCount = clickData.count || 0;

    const convData = await fetchBasicAuth(
      `https://api.partnerize.com/reporting/report_publisher/publisher/${pzPubId}/conversion.json?start_date=${fmtISO(startDate)}&end_date=${fmtISO(endDate)}`,
      pzAppKey, pzApiKey
    );
    const convCount = convData.count || 0;

    console.log(`Clicks: ${clickCount}`);
    console.log(`Conversions: ${convCount}`);
    if (clickCount > 0 && convCount > 0) {
      console.log(`Conversion rate: ${(convCount / clickCount * 100).toFixed(1)}%`);
    }
  } else {
    console.log('\n── Partnerize: SKIPPED (no credentials) ──');
  }

  // ── PostHog (click tracking + A/B test) ──
  const phKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const phProject = process.env.POSTHOG_PROJECT_ID;

  if (phKey && phProject) {
    console.log('\n── PostHog (ticket clicks + A/B test) ──');

    const events = await fetchJSON(
      `https://us.posthog.com/api/projects/${phProject}/events/?event=ticket_click&limit=500`,
      { Authorization: `Bearer ${phKey}` }
    );

    const clicks = (events.results || []).filter(e => {
      const t = new Date(e.timestamp);
      return t >= startDate && t <= endDate;
    });

    console.log(`Total ticket clicks: ${clicks.length}`);

    // By platform
    const byPlatform = {};
    clicks.forEach(e => {
      const p = e.properties?.platform || 'Unknown';
      byPlatform[p] = (byPlatform[p] || 0) + 1;
    });
    console.log('By platform:');
    Object.entries(byPlatform).sort((a, b) => b[1] - a[1]).forEach(([p, c]) => {
      const aff = e => clicks.filter(ev => ev.properties?.platform === p && ev.properties?.is_affiliate).length;
      console.log(`  ${p}: ${c} clicks`);
    });

    // A/B test breakdown
    const withVariant = clicks.filter(e => e.properties?.ab_variant);
    if (withVariant.length > 0) {
      console.log('\nA/B Test (ticket-primary-platform):');
      const byVariant = {};
      withVariant.forEach(e => {
        const v = e.properties.ab_variant;
        if (!byVariant[v]) byVariant[v] = { total: 0, byPlatform: {} };
        byVariant[v].total++;
        const p = e.properties.platform || 'Unknown';
        byVariant[v].byPlatform[p] = (byVariant[v].byPlatform[p] || 0) + 1;
      });
      Object.entries(byVariant).forEach(([variant, data]) => {
        console.log(`  Variant "${variant}": ${data.total} clicks`);
        Object.entries(data.byPlatform).sort((a, b) => b[1] - a[1]).forEach(([p, c]) => {
          console.log(`    ${p}: ${c}`);
        });
      });
    } else {
      console.log('\nA/B test: No variant-tagged clicks yet.');
    }
  } else {
    console.log('\n── PostHog: SKIPPED (no credentials) ──');
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Report generated: ${new Date().toISOString()}\n`);
}

main().catch(err => {
  console.error('Report error:', err.message);
  process.exit(1);
});
