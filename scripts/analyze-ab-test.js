#!/usr/bin/env node
/**
 * A/B test analyzer for ticket button experiments.
 *
 * Pulls ticket_click events from PostHog, applies correct filters,
 * joins with conversion data from Impact, computes per-variant metrics
 * with statistical significance.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  LIVE A/B TEST ANALYZER — READ BEFORE MODIFYING
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  Rules (see memory/feedback_ab_test_guardrails.md):
 *    1. Never change PostHog flag rollouts based on this script's output
 *       without explicit user approval. "Direction looks clear" ≠ winner.
 *    2. Never remove filter logic. memory/feedback_ab_test_analysis.md
 *       explains why each exclusion exists.
 *    3. When a test restarts, ADD to FLAG_RESTART_DATES before re-running.
 *       Pre-restart events are contaminated and must be excluded.
 *    4. Small samples deserve skepticism. At current traffic, 100 clicks
 *       per variant takes ~50 days. Don't declare early.
 *
 *  Companion validator: scripts/validate-ab-test.js (proves the flag is
 *  actually serving variants, DOM renders correctly, and click tracking
 *  fires with the right ab_variant). Run that first when debugging.
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Usage:
 *   node scripts/analyze-ab-test.js                  # default: ticket-single-button
 *   node scripts/analyze-ab-test.js --flag <key>     # specific flag
 *   node scripts/analyze-ab-test.js --days 14        # date range
 *
 * IMPORTANT — read these before modifying:
 *   See memory/feedback_ab_test_analysis.md for the correct filter logic
 *   and why each exclusion exists. The filters are NOT optional.
 *
 * Required env vars:
 *   POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID
 *   IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN
 */

const FLAG = (() => {
  const idx = process.argv.indexOf('--flag');
  return idx >= 0 ? process.argv[idx + 1] : 'ticket-single-button';
})();

const DAYS = (() => {
  const idx = process.argv.indexOf('--days');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 14;
})();

/**
 * Restart markers: timestamp after which each flag's current test run began.
 * Events before this date are excluded from analysis because they belong to
 * a previous, distinct test run (different traffic split, different variant
 * definition, or contaminated baseline). When restarting a test, add/update
 * the entry here.
 *
 * ticket-single-button: restarted 2026-04-11 ~19:00 UTC after the first run
 *   (Mar 28 - Apr 11) was invalidated by the StubHub hide mid-flight changing
 *   the `multi` condition. Also fixed sticky-bucket gap during the Apr 11
 *   flag flip. Fresh clock, 50/50 split.
 */
const FLAG_RESTART_DATES = {
  'ticket-single-button': new Date('2026-04-11T19:00:00Z'),
};

const endDate = new Date();
const requestedStart = new Date(endDate.getTime() - DAYS * 24 * 60 * 60 * 1000);
// Clamp startDate to the most recent restart marker for this flag — events
// before the restart were generated under a different test and must not
// pollute the current analysis.
const restartDate = FLAG_RESTART_DATES[FLAG];
const startDate = restartDate && restartDate > requestedStart ? restartDate : requestedStart;
const fmtISO = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

async function fetchPostHog(url) {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  return res.json();
}

async function fetchImpact(url) {
  const sid = process.env.IMPACT_ACCOUNT_SID;
  const token = process.env.IMPACT_AUTH_TOKEN;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  return res.json();
}

/**
 * Two-proportion z-test for conversion rates.
 * Returns p-value (one-tailed, testing if variant > control).
 */
function zTest(controlConv, controlN, variantConv, variantN) {
  if (controlN === 0 || variantN === 0) return 1;
  const p1 = controlConv / controlN;
  const p2 = variantConv / variantN;
  const pooled = (controlConv + variantConv) / (controlN + variantN);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / controlN + 1 / variantN));
  if (se === 0) return 1;
  const z = (p2 - p1) / se;
  // Approximation of normal CDF for one-tailed test
  const cdf = 0.5 * (1 + Math.sign(z) * Math.sqrt(1 - Math.exp(-2 * z * z / Math.PI)));
  return 1 - cdf;
}

async function main() {
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!projectId) {
    console.error('POSTHOG_PROJECT_ID not set');
    process.exit(1);
  }

  console.log(`\n📊 A/B Test Analysis: ${FLAG}`);
  console.log(`Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  if (restartDate && restartDate > requestedStart) {
    console.log(`  (clamped to restart date ${restartDate.toISOString().split('T')[0]}; pre-restart data excluded)`);
  }
  console.log('='.repeat(70));

  // ── Fetch all ticket_click events ──
  // PostHog API doesn't filter on properties easily, so fetch and filter client-side
  const events = [];
  let after = fmtISO(startDate);
  let pageCount = 0;
  while (pageCount < 20) {
    const url = `https://us.posthog.com/api/projects/${projectId}/events/?event=ticket_click&limit=200&after=${encodeURIComponent(after)}`;
    const data = await fetchPostHog(url);
    if (!data.results || data.results.length === 0) break;
    events.push(...data.results);
    if (!data.next || data.results.length < 200) break;
    after = data.results[data.results.length - 1].timestamp;
    pageCount++;
  }

  console.log(`\nRaw ticket_click events fetched: ${events.length}`);

  // ── Apply correct filters (see memory/feedback_ab_test_analysis.md) ──
  // 1. Only show pages (excludes showtimes/compare/guide)
  // 2. Has ab_variant matching new format "platform:X,buttons:Y"
  // 3. Excludes fallback variants (ad blockers / opt-outs)
  // 4. Within date range
  const filtered = events.filter(e => {
    const t = new Date(e.timestamp);
    if (t < startDate || t > endDate) return false;

    const props = e.properties || {};
    if (props.page_type !== 'show') return false;

    const variant = props.ab_variant;
    if (typeof variant !== 'string') return false;
    if (!variant.match(/^platform:[^,]+,buttons:[^,]+$/)) return false;
    if (variant.includes('fallback')) return false;

    return true;
  });

  console.log(`After filters (page_type=show, valid ab_variant, no fallback): ${filtered.length}`);
  console.log(`Excluded: ${events.length - filtered.length} events (other page types, fallback, pre-test format)`);

  // ── Group by the relevant variant segment ──
  // Extract the variant for the FLAG we're analyzing
  const variantKey = FLAG === 'ticket-primary-platform' ? 'platform' : 'buttons';
  const byVariant = {};

  for (const e of filtered) {
    const variant = e.properties.ab_variant;
    const match = variant.match(new RegExp(`${variantKey}:([^,]+)`));
    if (!match) continue;
    const v = match[1];

    if (!byVariant[v]) {
      byVariant[v] = {
        clicks: 0,
        users: new Set(),
        platforms: {},
      };
    }
    byVariant[v].clicks++;
    byVariant[v].users.add(e.distinct_id);
    const platform = e.properties.platform || 'Unknown';
    byVariant[v].platforms[platform] = (byVariant[v].platforms[platform] || 0) + 1;
  }

  // ── Pull conversions from Impact ──
  let impactConversions = [];
  if (process.env.IMPACT_ACCOUNT_SID && process.env.IMPACT_AUTH_TOKEN) {
    const sid = process.env.IMPACT_ACCOUNT_SID;
    const url = `https://api.impact.com/Mediapartners/${sid}/Actions.json?StartDate=${fmtISO(startDate)}&EndDate=${fmtISO(endDate)}`;
    const data = await fetchImpact(url);
    impactConversions = data.Actions || [];
  }

  // Note: Impact conversions can't be directly attributed to PostHog variants
  // (no shared user ID), so we can only compute total conversions and approximate
  // per-variant by assuming proportional click distribution.
  const totalConversions = impactConversions.length;
  const totalRevenue = impactConversions.reduce((s, c) => s + parseFloat(c.Amount || 0), 0);
  const totalCommission = impactConversions.reduce((s, c) => s + parseFloat(c.Payout || 0), 0);

  // ── Print per-variant metrics ──
  console.log(`\n${'─'.repeat(70)}`);
  console.log('VARIANT BREAKDOWN');
  console.log('─'.repeat(70));

  const variantNames = Object.keys(byVariant).sort();
  const totals = { clicks: 0, users: 0 };
  for (const v of variantNames) {
    totals.clicks += byVariant[v].clicks;
    totals.users += byVariant[v].users.size;
  }

  for (const v of variantNames) {
    const data = byVariant[v];
    const userCount = data.users.size;
    const clicksPerUser = userCount > 0 ? (data.clicks / userCount).toFixed(2) : 'N/A';
    // Approximate conversions for this variant by share of total clicks
    const variantShare = totals.clicks > 0 ? data.clicks / totals.clicks : 0;
    const estConversions = (totalConversions * variantShare).toFixed(1);
    const estCommission = (totalCommission * variantShare).toFixed(2);

    console.log(`\nVariant: ${v}`);
    console.log(`  Clicks: ${data.clicks}`);
    console.log(`  Unique users: ${userCount}`);
    console.log(`  Clicks per user: ${clicksPerUser}`);
    console.log(`  Est. conversions (proportional): ${estConversions}`);
    console.log(`  Est. commission (proportional): $${estCommission}`);
    console.log(`  By platform:`);
    Object.entries(data.platforms).sort((a, b) => b[1] - a[1]).forEach(([p, c]) => {
      console.log(`    ${p}: ${c}`);
    });
  }

  // ── Statistical significance ──
  if (variantNames.length === 2) {
    const [a, b] = variantNames;
    const aClicks = byVariant[a].clicks;
    const bClicks = byVariant[b].clicks;
    const aUsers = byVariant[a].users.size;
    const bUsers = byVariant[b].users.size;

    console.log(`\n${'─'.repeat(70)}`);
    console.log('STATISTICAL SIGNIFICANCE');
    console.log('─'.repeat(70));

    const ctr_a = aUsers > 0 ? (aClicks / aUsers).toFixed(3) : 0;
    const ctr_b = bUsers > 0 ? (bClicks / bUsers).toFixed(3) : 0;
    console.log(`${a}: ${aClicks} clicks / ${aUsers} users = ${ctr_a} clicks/user`);
    console.log(`${b}: ${bClicks} clicks / ${bUsers} users = ${ctr_b} clicks/user`);

    const liftPct = ctr_a > 0 ? (((ctr_b - ctr_a) / ctr_a) * 100).toFixed(1) : 'N/A';
    console.log(`Relative lift (${b} vs ${a}): ${liftPct}%`);

    // Sample size adequacy
    const minN = Math.min(aClicks, bClicks);
    if (minN < 100) {
      console.log(`\n⚠️  Sample too small (min ${minN} clicks per variant). Need 100+ for 50% lift, 200+ for 30%, 400+ for 20%.`);
    } else {
      const p = zTest(aClicks, aUsers, bClicks, bUsers);
      console.log(`p-value (one-tailed): ${p.toFixed(4)}`);
      if (p < 0.05) console.log(`✅ Statistically significant at p<0.05`);
      else console.log(`❌ Not yet significant at p<0.05`);
    }

    // Decision guidance
    console.log(`\nDecision guidance:`);
    if (minN < 100) {
      console.log(`  → Continue running. Need at least 100 clicks per variant.`);
    } else if (Math.abs(parseFloat(liftPct)) > 30) {
      console.log(`  → Strong directional signal. Consider declaring winner.`);
    } else {
      console.log(`  → Continue running for clearer signal.`);
    }
  }

  // ── Caveats ──
  console.log(`\n${'─'.repeat(70)}`);
  console.log('CAVEATS');
  console.log('─'.repeat(70));
  console.log('• Conversions are proportional estimates. Impact API doesnt expose');
  console.log('  click_id or distinct_id, so we cant directly join with PostHog variants.');
  console.log('• True per-variant conversion rates require Impact postback integration.');
  console.log('• Click tracking only works when PostHog loads (ad blockers excluded via fallback filter).');
  console.log('• Methodology: see memory/feedback_ab_test_analysis.md');
  console.log('');
}

main().catch(err => {
  console.error('Analysis error:', err);
  process.exit(1);
});
