#!/usr/bin/env node
/**
 * Weekly affiliate performance report.
 *
 * Pulls data from Impact, Partnerize, and PostHog APIs via the shared
 * scripts/lib/affiliate-stats.js module (same source used by the admin
 * dashboard at /admin/affiliate), then prints a text summary or styled
 * HTML email. Can be piped to email or run in CI.
 *
 * Usage:
 *   node scripts/affiliate-report.js                    # last 7 days, text
 *   node scripts/affiliate-report.js --html             # last 7 days, HTML
 *   node scripts/affiliate-report.js --days 30          # last 30 days
 *   node scripts/affiliate-report.js --json             # raw JSON
 *
 * Requires env vars:
 *   IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN
 *   PARTNERIZE_APP_KEY, PARTNERIZE_API_KEY, PARTNERIZE_PUBLISHER_ID
 *   POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID
 */

const { getAffiliateStats } = require('./lib/affiliate-stats');
const { buildAffiliateReportHtml, formatUsd } = require('./lib/affiliate-email');

const args = process.argv.slice(2);
const DAYS = (() => {
  const idx = args.indexOf('--days');
  return idx >= 0 ? parseInt(args[idx + 1], 10) : 7;
})();
const JSON_MODE = args.includes('--json');
const HTML_MODE = args.includes('--html');

async function main() {
  // Whole Pacific days so the totals, WoW and trailing baseline cover the
  // same week no matter when the cron fires (BRO-6379).
  const stats = await getAffiliateStats({ days: DAYS, includeWoW: true, completeDays: true });

  if (JSON_MODE) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  if (HTML_MODE) {
    console.log(buildAffiliateReportHtml(stats));
    return;
  }

  const { window, impact, partnerize, posthog, errors, funnel, unitEconomics, perPlatform, wowDelta, context } = stats;

  console.log(`\n📊 Affiliate Performance Report (${window.startDate} to ${window.endDate})\n`);
  console.log('='.repeat(60));

  // ── Week over week (Impact only) ──
  if (wowDelta) {
    const arrow = (pct) => pct == null ? '' : (pct >= 0 ? `▲ +${pct.toFixed(1)}%` : `▼ ${pct.toFixed(1)}%`);
    console.log(`\n── Week over Week (vs ${wowDelta.priorStartDate} to ${wowDelta.priorEndDate}, Impact only) ──`);
    console.log(`  Commission   : ${arrow(wowDelta.commissionPct) || 'n/a'}    (prior ${formatUsd(wowDelta.priorCommission)})`);
    console.log(`  Conversions  : ${arrow(wowDelta.conversionsPct) || 'n/a'}    (prior ${wowDelta.priorConversions})`);
    console.log(`  New TT custs : ${arrow(wowDelta.newCustomersPct) || 'n/a'}    (prior ${wowDelta.priorNewCustomers})`);
    console.log(`  Attrib sales : ${arrow(wowDelta.revenuePct) || 'n/a'}    (prior ${formatUsd(wowDelta.priorRevenue)})`);
  }

  // ── Context (baseline + outlier annotations — affiliate hardening 2026-08-03) ──
  if (context) {
    console.log('\n── Context ──');
    if (context.partial) {
      console.log('  PARTIAL DATA — baseline/outlier context unavailable; treat deltas with caution.');
    } else {
      if (context.baseline && context.baseline.payoutVsBaselinePct != null) {
        const b = context.baseline;
        const sign = context.baseline.payoutVsBaselinePct >= 0 ? '+' : '';
        console.log(`  vs trailing ${b.baseline.days}d baseline: ${sign}${context.baseline.payoutVsBaselinePct.toFixed(1)}%/day` +
          ` (${formatUsd(b.windowPerDay?.payout || 0)}/day now vs ${formatUsd(b.baselinePerDay?.payout || 0)}/day)`);
      }
      for (const d of context.outlierDays || []) {
        console.log(`  Outlier day: ${d.day} contributed ${Math.round(d.shareOfWindow * 100)}% of window commission (${formatUsd(d.payout)})`);
      }
      for (const b of context.repeatBuyers || []) {
        console.log(`  Repeat buyer: one customer placed ${b.conversions} orders (${formatUsd(b.sales)} sales)`);
      }
      if (context.clickDivergenceRatio != null && context.clickDivergenceRatio > 2) {
        console.log(`  Bot note: Impact recorded ${context.impactClicks} clicks vs ${funnel?.ticketClicks} on-site (${context.clickDivergenceRatio.toFixed(1)}x) — EPC diluted`);
      }
    }
  }

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
    console.log(`  Commission      : ${formatUsd(funnel.commission)}    (${epc} EPC)`);
  }

  // ── Unit economics ──
  if (unitEconomics && unitEconomics.avgOrderValue != null) {
    console.log('\n── Unit Economics ──');
    console.log(`  Avg order value     : ${formatUsd(unitEconomics.avgOrderValue)}`);
    console.log(`  Avg commission/conv : ${formatUsd(unitEconomics.avgCommissionPerConv)}`);
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
      const comm = r.commission != null ? formatUsd(r.commission).padStart(11) : '          —';
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
      console.log(`Commission earned (our revenue): ${formatUsd(impact.totalPayout)}`);
      console.log(`Ticket sales attributed (gross order value, NOT ours): ${formatUsd(impact.totalRevenue)}`);
      console.log('By campaign:');
      for (const c of impact.byCampaign) {
        console.log(`  ${c.name}: ${c.count} sales, ${formatUsd(c.payout)} commission (${formatUsd(c.revenue)} attributed)`);
      }
      if (impact.todaytixMix) {
        const m = impact.todaytixMix;
        const total = m.newCount + m.existingCount;
        if (total > 0) {
          const newPct = Math.round((m.newCount / total) * 100);
          console.log('TodayTix customer mix (inferred from payout rate):');
          console.log(`  New: ${m.newCount} (${newPct}%), ${formatUsd(m.newPayout)} commission (${formatUsd(m.newRevenue)} attributed)`);
          console.log(`  Existing: ${m.existingCount} (${100 - newPct}%), ${formatUsd(m.existingPayout)} commission (${formatUsd(m.existingRevenue)} attributed)`);
          if (m.promoZeroCount > 0) console.log(`  Promo-code orders (TodayTix pays $0 on these by contract): ${m.promoZeroCount} (${formatUsd(m.promoZeroRevenue)} attributed)`);
          if (m.unknownCount > 0) console.log(`  Unknown rate: ${m.unknownCount}`);
          if (m.rateBumpUplift > 0) {
            console.log(`  Rate-bump uplift (vs old 2%/1% contract): +${formatUsd(m.rateBumpUplift)} commission this period`);
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
