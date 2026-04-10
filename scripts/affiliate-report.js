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

// Uses native fetch (Node 18+)

const DAYS = (() => {
  const idx = process.argv.indexOf('--days');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 7;
})();

const endDate = new Date();
// Add 1 day buffer to end date to catch timezone edge cases
const endDateBuffered = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
const startDate = new Date(endDate.getTime() - DAYS * 24 * 60 * 60 * 1000);
const fmt = d => d.toISOString().split('T')[0];
const fmtISO = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z'); // Impact rejects milliseconds

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json', ...headers } });
  return res.json();
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

    // A/B test breakdown — apply CORRECT filters per memory/feedback_ab_test_analysis.md
    // 1. Only show pages (page_type='show')
    // 2. New format ab_variant: "platform:X,buttons:Y"
    // 3. Exclude fallback variants (ad blockers / opt-outs)
    // For full analysis use: node scripts/analyze-ab-test.js
    const abClicks = clicks.filter(e => {
      const props = e.properties || {};
      if (props.page_type !== 'show') return false;
      const v = props.ab_variant;
      if (typeof v !== 'string') return false;
      if (!v.match(/^platform:[^,]+,buttons:[^,]+$/)) return false;
      if (v.includes('fallback')) return false;
      return true;
    });

    if (abClicks.length > 0) {
      console.log('\nA/B Test (ticket-single-button) — filtered, show pages only:');
      // Group by buttons variant (the active test)
      const byButtons = {};
      abClicks.forEach(e => {
        const match = e.properties.ab_variant.match(/buttons:([^,]+)/);
        if (!match) return;
        const v = match[1];
        if (!byButtons[v]) byButtons[v] = { clicks: 0, users: new Set() };
        byButtons[v].clicks++;
        byButtons[v].users.add(e.distinct_id);
      });
      Object.entries(byButtons).sort().forEach(([variant, data]) => {
        const userCount = data.users.size;
        const cpu = userCount > 0 ? (data.clicks / userCount).toFixed(2) : 'N/A';
        console.log(`  ${variant}: ${data.clicks} clicks, ${userCount} users (${cpu} clicks/user)`);
      });
      console.log(`  → Run "node scripts/analyze-ab-test.js" for stat sig + decision guidance`);
    } else {
      console.log('\nA/B test: No qualified events yet (need page_type=show + valid ab_variant).');
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
