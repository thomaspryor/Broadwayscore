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

  const { window, impact, partnerize, posthog, errors, funnel, unitEconomics, perPlatform } = stats;

  console.log(`\n📊 Affiliate Performance Report (${window.startDate} to ${window.endDate})\n`);
  console.log('='.repeat(60));

  // ── Funnel ──
  if (funnel) {
    console.log('\n── Conversion Funnel ──');
    const pv = funnel.showPageviews != null ? funnel.showPageviews.toLocaleString() : '—';
    const tc = funnel.ticketClicks != null ? funnel.ticketClicks.toLocaleString() : '—';
    const ctr = funnel.rates.clicksPerShowView != null ? `${(funnel.rates.clicksPerShowView * 100).toFixed(2)}%` : '—';
    const cr = funnel.rates.convsPerClick != null ? `${(funnel.rates.convsPerClick * 100).toFixed(2)}%` : '—';
    const epc = funnel.rates.epc != null ? `$${funnel.rates.epc.toFixed(3)}` : '—';
    console.log(`  Show page views : ${pv}`);
    console.log(`  Ticket clicks   : ${tc}    (${ctr} of views)`);
    console.log(`  Conversions     : ${funnel.conversions}    (${cr} of clicks)`);
    console.log(`  Commission      : $${funnel.commission.toFixed(2)}    (${epc} EPC)`);
  }

  // ── Unit economics ──
  if (unitEconomics && unitEconomics.avgOrderValue != null) {
    console.log('\n── Unit Economics ──');
    console.log(`  Avg order value     : $${unitEconomics.avgOrderValue.toFixed(2)}`);
    console.log(`  Avg commission/conv : $${unitEconomics.avgCommissionPerConv.toFixed(2)}`);
    console.log(`  Take rate           : ${(unitEconomics.takeRate * 100).toFixed(2)}%`);
    console.log(`  EPC                 : $${(unitEconomics.earningsPerClick || 0).toFixed(3)}`);
  }

  // ── Per-platform table ──
  if (perPlatform && perPlatform.length > 0) {
    console.log('\n── By Platform ──');
    console.log('  Platform        Clicks  Conv     CR     Commission     EPC');
    for (const r of perPlatform) {
      const aff = r.affiliate ? '*' : ' ';
      const clicks = String(r.clicks).padStart(5);
      const conv = r.conversions != null ? String(r.conversions).padStart(4) : '   —';
      const cr = r.conversionRate != null ? `${(r.conversionRate * 100).toFixed(1)}%`.padStart(6) : '     —';
      const comm = r.commission != null ? `$${r.commission.toFixed(2)}`.padStart(11) : '          —';
      const epc = r.epc != null ? `$${r.epc.toFixed(3)}`.padStart(8) : '       —';
      console.log(`  ${aff}${(r.platform).padEnd(15)} ${clicks}  ${conv}  ${cr}  ${comm}  ${epc}`);
    }
    console.log('  (* = affiliate program; others are unmonetized)');
  }

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
      console.log(`Commission earned (our revenue): $${impact.totalPayout.toFixed(2)}`);
      console.log(`Ticket sales attributed (gross order value, NOT ours): $${impact.totalRevenue.toFixed(2)}`);
      console.log('By campaign:');
      for (const c of impact.byCampaign) {
        console.log(`  ${c.name}: ${c.count} sales, $${c.payout.toFixed(2)} commission ($${c.revenue.toFixed(2)} attributed)`);
      }
      if (impact.todaytixMix) {
        const m = impact.todaytixMix;
        const total = m.newCount + m.existingCount;
        if (total > 0) {
          const newPct = Math.round((m.newCount / total) * 100);
          console.log('TodayTix customer mix (inferred from payout rate):');
          console.log(`  New: ${m.newCount} (${newPct}%), $${m.newPayout.toFixed(2)} commission ($${m.newRevenue.toFixed(2)} attributed)`);
          console.log(`  Existing: ${m.existingCount} (${100 - newPct}%), $${m.existingPayout.toFixed(2)} commission ($${m.existingRevenue.toFixed(2)} attributed)`);
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
