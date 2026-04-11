#!/usr/bin/env node
/**
 * Weekly affiliate performance report.
 *
 * Pulls data from Impact, Partnerize, and PostHog APIs via the shared
 * scripts/lib/affiliate-stats.js module (same source used by the admin
 * dashboard at /admin/affiliate), then prints a text summary. Can be
 * piped to email or run in CI.
 *
 * Usage:
 *   node scripts/affiliate-report.js                    # last 7 days
 *   node scripts/affiliate-report.js --days 30          # last 30 days
 *   node scripts/affiliate-report.js --json             # raw JSON
 *   node scripts/affiliate-report.js --email            # (legacy flag, unused)
 *
 * Requires env vars:
 *   IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN
 *   PARTNERIZE_APP_KEY, PARTNERIZE_API_KEY, PARTNERIZE_PUBLISHER_ID
 *   POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID
 */

const { getAffiliateStats } = require('./lib/affiliate-stats');

const args = process.argv.slice(2);
const DAYS = (() => {
  const idx = args.indexOf('--days');
  return idx >= 0 ? parseInt(args[idx + 1], 10) : 7;
})();
const JSON_MODE = args.includes('--json');

async function main() {
  const stats = await getAffiliateStats({ days: DAYS, includeWoW: false });

  if (JSON_MODE) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  const { window, impact, partnerize, posthog, errors } = stats;

  console.log(`\n📊 Affiliate Performance Report (${window.startDate} to ${window.endDate})\n`);
  console.log('='.repeat(60));

  // ── Impact ──
  console.log('\n── Impact (TodayTix, Ticketmaster, SeatPlan, Vivid Seats) ──');
  const impactErr = errors.find(e => e.provider === 'impact');
  if (impactErr) {
    console.log(`Impact API error: ${impactErr.message}`);
  } else if (!impact || impact.skipped) {
    console.log(impact?.skipped ? `SKIPPED (${impact.reason})` : 'No data');
  } else {
    console.log(`Conversions: ${impact.conversions}`);
    if (impact.conversions > 0) {
      console.log(`Total ticket sales: $${impact.totalRevenue.toFixed(2)}`);
      console.log(`Total commission: $${impact.totalPayout.toFixed(2)}`);
      console.log('By campaign:');
      for (const c of impact.byCampaign) {
        console.log(`  ${c.name}: ${c.count} sales, $${c.revenue.toFixed(2)} revenue, $${c.payout.toFixed(2)} commission`);
      }
      if (impact.todaytixMix) {
        const m = impact.todaytixMix;
        const total = m.newCount + m.existingCount;
        if (total > 0) {
          const newPct = Math.round((m.newCount / total) * 100);
          console.log('TodayTix customer mix (inferred from payout rate):');
          console.log(`  New: ${m.newCount} (${newPct}%), $${m.newRevenue.toFixed(2)} revenue, $${m.newPayout.toFixed(2)} commission`);
          console.log(`  Existing: ${m.existingCount} (${100 - newPct}%), $${m.existingRevenue.toFixed(2)} revenue, $${m.existingPayout.toFixed(2)} commission`);
          if (m.unknownCount > 0) console.log(`  Unknown rate: ${m.unknownCount}`);
          if (m.rateBumpUplift > 0) {
            console.log(`  Rate-bump uplift (vs old 2%/1% contract): +$${m.rateBumpUplift.toFixed(2)} commission this period`);
          }
        }
      }
    } else {
      console.log('No conversions yet.');
    }
  }

  // ── Partnerize ──
  console.log('\n── Partnerize (StubHub) ──');
  const partnerizeErr = errors.find(e => e.provider === 'partnerize');
  if (partnerizeErr) {
    console.log(`Partnerize error: ${partnerizeErr.message}`);
  } else if (!partnerize || partnerize.skipped) {
    console.log(partnerize?.skipped ? `SKIPPED (${partnerize.reason})` : 'No data');
  } else {
    console.log(`Clicks: ${partnerize.clicks}`);
    console.log(`Conversions: ${partnerize.conversions}`);
    if (partnerize.clicks > 0 && partnerize.conversions > 0) {
      console.log(`Conversion rate: ${(partnerize.conversionRate * 100).toFixed(1)}%`);
    }
  }

  // ── PostHog ──
  console.log('\n── PostHog (ticket clicks) ──');
  const posthogErr = errors.find(e => e.provider === 'posthog');
  if (posthogErr) {
    console.log(`PostHog error: ${posthogErr.message}`);
  } else if (!posthog || posthog.skipped) {
    console.log(posthog?.skipped ? `SKIPPED (${posthog.reason})` : 'No data');
  } else {
    console.log(`Total ticket clicks: ${posthog.totalClicks}`);
    if (posthog.byPlatform.length > 0) {
      console.log('By platform:');
      for (const p of posthog.byPlatform) {
        console.log(`  ${p.platform}: ${p.count} clicks`);
      }
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Report generated: ${stats.updatedAt}\n`);
}

main().catch(err => {
  console.error('Report error:', err.message);
  process.exit(1);
});
