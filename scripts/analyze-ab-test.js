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
  // Accept both `--days 14` (this script's original form) and `--days=14`
  // (the convention every other analyzer in this repo uses — analyze-gate-cold-start.js,
  // analyze-email-gate-funnel.js). Silently falling back to the 14-day default
  // on an unrecognized form would give a caller like `--json --days=30` a
  // wrong-window analysis with no error (2026-07-24 ship-check finding).
  const eq = process.argv.find(a => a.startsWith('--days='));
  if (eq) return parseInt(eq.split('=')[1], 10);
  const idx = process.argv.indexOf('--days');
  return idx >= 0 ? parseInt(process.argv[idx + 1], 10) : 14;
})();

// --json: emit one machine-readable summary line instead of the prose report
// (consumed by scripts/monitor-ticket-ab.js via loadWindows/runAnalyzerJson —
// same pattern as analyze-gate-cold-start.js / analyze-email-gate-funnel.js).
const JSON_OUT = process.argv.includes('--json');

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

// Significance math + report decision logic live in scripts/lib/significance.js
// (pure, unit-tested — CLAUDE.md §15). This file only fetches, joins, and
// prints. History: the previous inline zTest() here produced "p-value: NaN"
// on every run (clicks passed into conversion-count slots) — see the header
// comment in significance.js for the full post-mortem.
const { computeAbSignificance } = require('./lib/significance');

async function fetchPostHog(url) {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`PostHog API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchImpact(url) {
  const sid = process.env.IMPACT_ACCOUNT_SID;
  const token = process.env.IMPACT_AUTH_TOKEN;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Impact API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!projectId) {
    console.error('POSTHOG_PROJECT_ID not set');
    process.exit(1);
  }

  const say = (...a) => { if (!JSON_OUT) console.log(...a); };
  const summary = {
    flag: FLAG,
    days: DAYS,
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0],
    restartClamped: !!(restartDate && restartDate > requestedStart),
  };

  say(`\n📊 A/B Test Analysis: ${FLAG}`);
  say(`Date range: ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`);
  if (restartDate && restartDate > requestedStart) {
    say(`  (clamped to restart date ${restartDate.toISOString().split('T')[0]}; pre-restart data excluded)`);
  }
  say('='.repeat(70));

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

  say(`\nRaw ticket_click events fetched: ${events.length}`);

  // ── Apply correct filters (see memory/feedback_ab_test_analysis.md) ──
  // 1. Only show pages (excludes showtimes/compare/guide)
  // 2. Has ab_variant matching the new flag-prefixed format "flag:X,platform:Y,buttons:Z"
  //    (legacy format "platform:X,buttons:Y" is still accepted for backward
  //     compat with events fired before the flag-prefix shipped 2026-04-27)
  // 3. Excludes fallback variants (ad blockers / opt-outs)
  // 4. Within date range
  const VARIANT_RE = new RegExp(`(?:^|^flag:${FLAG},)platform:[^,]+,buttons:[^,]+$`);
  const filtered = events.filter(e => {
    const t = new Date(e.timestamp);
    if (t < startDate || t > endDate) return false;

    const props = e.properties || {};
    if (props.page_type !== 'show') return false;

    const variant = props.ab_variant;
    if (typeof variant !== 'string') return false;
    if (!VARIANT_RE.test(variant)) return false;
    if (variant.includes('fallback')) return false;

    return true;
  });

  say(`After filters (page_type=show, valid ab_variant, no fallback): ${filtered.length}`);
  say(`Excluded: ${events.length - filtered.length} events (other page types, fallback, pre-test format)`);

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

  // Postback attribution: as of 2026-04-26, affiliate-utils.ts forwards
  // distinct_id (subId1) and ab_variant (subId2) on every Impact click URL
  // built by TicketLink. Impact echoes these back on each Action record
  // (PascalCase: SubId1/SubId2). A SubId2 only counts as "attributed to
  // this test" if it carries the `flag:${FLAG}` cohort prefix added 2026-04-27
  // (Codex ship-check #6) — without it, a future test reusing `buttons:single`
  // would silently merge into this test's history.
  // Rows without a matching SubId2 are pre-postback historical, non-AB-tested
  // click sources (DiscountTicketsTable, lottery, rush, showtimes), or
  // belong to a different test cohort, and feed the estimated split below.
  const subIdField = (a) => a.SubId2 || a.subId2 || '';
  const subId1Field = (a) => a.SubId1 || a.subId1 || '';
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const attributedConversions = impactConversions.filter(a => VARIANT_RE.test(subIdField(a)));
  const unattributedConversions = impactConversions.filter(a => !VARIANT_RE.test(subIdField(a)));
  const unattributedCommission = unattributedConversions.reduce((s, c) => s + num(c.Payout), 0);
  const totalConversions = impactConversions.length;
  const totalRevenue = impactConversions.reduce((s, c) => s + num(c.Amount), 0);
  const totalCommission = impactConversions.reduce((s, c) => s + num(c.Payout), 0);

  // Group attributed conversions by the variant segment we're analyzing
  // (same regex as the click grouping above so the keys match).
  // convUsers: UNIQUE converting users via the SubId1 (distinct_id) echo —
  // one user converting 4x is one converting user, not four. joinWithSub1 /
  // conversions is the join-coverage that gates the primary significance
  // metric (computeAbSignificance suppresses the p when coverage is low or
  // asymmetric — a clean-looking p on a partial join is worse than none).
  const directByVariant = {};
  for (const a of attributedConversions) {
    const subId = subIdField(a);
    const m = subId.match(new RegExp(`${variantKey}:([^,]+)`));
    if (!m) continue;
    const v = m[1];
    if (!directByVariant[v]) {
      directByVariant[v] = { conversions: 0, revenue: 0, commission: 0, convUsers: new Set(), joinWithSub1: 0 };
    }
    directByVariant[v].conversions++;
    directByVariant[v].revenue += num(a.Amount);
    directByVariant[v].commission += num(a.Payout);
    const s1 = subId1Field(a);
    if (s1 && s1.length > 3) {
      directByVariant[v].joinWithSub1++;
      directByVariant[v].convUsers.add(s1);
    }
  }

  // ── Print per-variant metrics ──
  say(`\n${'─'.repeat(70)}`);
  say('VARIANT BREAKDOWN');
  say('─'.repeat(70));

  const variantNames = Object.keys(byVariant).sort();
  const totals = { clicks: 0, users: 0 };
  for (const v of variantNames) {
    totals.clicks += byVariant[v].clicks;
    totals.users += byVariant[v].users.size;
  }

  // Postback coverage — also decides whether the estimated-split line prints:
  // at ≥80% coverage the direct numbers are the measurement and the estimate
  // only invites cross-population arithmetic (per this script's own caveat).
  const postbackCoverage = totalConversions > 0 ? attributedConversions.length / totalConversions : 0;
  const showEstimatedSplit = unattributedConversions.length > 0 && postbackCoverage < 0.8;
  summary.postbackCoverage = +postbackCoverage.toFixed(3);
  summary.totalConversions = totalConversions;

  const emptyDirect = () => ({ conversions: 0, revenue: 0, commission: 0, convUsers: new Set(), joinWithSub1: 0 });
  for (const v of variantNames) {
    const data = byVariant[v];
    const userCount = data.users.size;
    const clicksPerUser = userCount > 0 ? (data.clicks / userCount).toFixed(2) : 'N/A';
    // Direct attribution from Impact SubId2 (postback path).
    const direct = directByVariant[v] || emptyDirect();
    // Estimated split for unattributed conversions: we apply this variant's
    // share of *show-page* AB clicks to ALL unattributed Impact conversions —
    // including ones from non-AB surfaces (lottery, rush, discount-tickets,
    // showtimes) and pre-postback historical rows. The populations don't
    // match, so this is an estimate, not a measurement. Suppressed once
    // postback coverage ≥80% (direct numbers are the measurement then).
    const variantShare = totals.clicks > 0 ? data.clicks / totals.clicks : 0;
    const estConversions = unattributedConversions.length * variantShare;
    const estCommission = unattributedCommission * variantShare;

    say(`\nVariant: ${v}`);
    say(`  Clicks: ${data.clicks}`);
    say(`  Unique users: ${userCount}`);
    say(`  Clicks per user: ${clicksPerUser}`);
    say(`  Direct conversions (subId2): ${direct.conversions}`);
    say(`  Unique converting users (subId1): ${direct.convUsers.size}`);
    say(`  Direct commission (subId2): $${direct.commission.toFixed(2)}`);
    if (showEstimatedSplit) {
      say(`  Estimated split (unattributed pool, assumes equal exposure): ${estConversions.toFixed(1)} conv / $${estCommission.toFixed(2)}`);
    }
    say(`  By platform:`);
    Object.entries(data.platforms).sort((a, b) => b[1] - a[1]).forEach(([p, c]) => {
      say(`    ${p}: ${c}`);
    });
  }

  // Postback coverage line — tells you whether attribution is "live" yet.
  if (totalConversions > 0) {
    const pct = (postbackCoverage * 100).toFixed(0);
    say(`\nPostback coverage: ${attributedConversions.length}/${totalConversions} conversions carry SubId2 (${pct}%).`);
    if (postbackCoverage >= 0.8 && unattributedConversions.length > 0) {
      say(`  (coverage ≥80% — estimated-split lines suppressed; direct conversions are the measurement)`);
    }
    if (attributedConversions.length === 0) {
      say(`  ⚠ No conversions have SubId2 yet. Either the postback wiring just shipped`);
      say(`    and no conversion has landed since, or Impact isn't echoing the field.`);
      say(`    Verify with: curl an Action and inspect the SubId2 property.`);
    }
  }

  // ── Flag health (contamination gate for the significance section) ──
  // Same registry-driven check as analyze-gate-cold-start.js: significance
  // read from data collected under a drifted flag (split/rollout/sticky/
  // inactive) is contaminated, so computeAbSignificance suppresses the p.
  let flagHealthy = null;
  let flagHealthProblem = null;
  try {
    const { REGISTERED_FLAGS, evaluateFlagHealth } = require('./lib/flag-registry');
    const entry = REGISTERED_FLAGS.find(e => e.key === FLAG);
    if (entry) {
      const fh = await fetchPostHog(`https://us.posthog.com/api/projects/${projectId}/feature_flags/?search=${encodeURIComponent(FLAG)}`);
      const f = (fh.results || []).find(r => r.key === FLAG);
      const live = f ? {
        active: f.active,
        variants: (f.filters?.multivariate?.variants || []).map(v => ({ key: v.key, pct: v.rollout_percentage })),
        rollout: f.filters?.groups?.[0]?.rollout_percentage,
        ensure_experience_continuity: !!f.ensure_experience_continuity,
      } : null;
      const health = evaluateFlagHealth(live, entry.expected);
      flagHealthy = health.ok;
      if (!health.ok) flagHealthProblem = health.problem;
      say(`\nFLAG HEALTH: ${health.ok ? '✅ matches registry-expected state' : `🛑 ${health.problem}`}`);
    } else {
      say(`\nFLAG HEALTH: ⚠ no REGISTERED_FLAGS entry for '${FLAG}' — health unchecked (add one in scripts/lib/flag-registry.js)`);
    }
  } catch (e) {
    say(`\nFLAG HEALTH: ⚠ check failed (${e.message}) — proceeding without contamination gate`);
  }
  summary.flagHealthy = flagHealthy;
  summary.flagHealthProblem = flagHealthProblem;

  // ── Statistical significance (all decision logic in lib/significance.js) ──
  // Always computed (not just when variantNames.length === 2) so --json has a
  // primary block to report even in a degenerate shape — computeAbSignificance
  // itself returns { degenerate: '...' } for anything other than 2 variants.
  {
    const sigInput = variantNames.map(v => {
      const direct = directByVariant[v] || emptyDirect();
      return {
        name: v,
        clicks: byVariant[v].clicks,
        users: byVariant[v].users.size,
        convUsers: direct.convUsers.size,
        convCount: direct.conversions,
        // Fraction of this variant's subId2-attributed conversions that also
        // carry a usable subId1; null (= fully covered) when no conversions.
        joinCoverage: direct.conversions > 0 ? direct.joinWithSub1 / direct.conversions : null,
      };
    });
    summary.variants = sigInput.map(v => ({
      name: v.name, clicks: v.clicks, users: v.users, convUsers: v.convUsers,
      convCount: v.convCount, joinCoverage: v.joinCoverage,
    }));
    // Independence check: a subId1 converting in BOTH variants breaks the
    // two-sample test (sticky bucketing should make this impossible — any
    // overlap signals assignment leakage and suppresses the p).
    let crossVariantConvUsers = 0;
    if (variantNames.length === 2) {
      const [setA, setB] = variantNames.map(v => (directByVariant[v] || emptyDirect()).convUsers);
      crossVariantConvUsers = [...setA].filter(u => setB.has(u)).length;
    }
    const rep = computeAbSignificance(sigInput, { crossVariantConvUsers, flagHealthProblem });
    summary.primary = rep.degenerate
      ? { degenerate: rep.degenerate, suppressed: null, significant: null, p: null, underpowered: false, note: null }
      : {
        p: rep.primary.p, significant: rep.primary.significant,
        suppressed: rep.primary.suppressed, degenerate: rep.primary.degenerate,
        underpowered: rep.underpowered, underpoweredNote: rep.underpoweredNote,
        // Pipeline caution (e.g. asymmetric-zero conversions at comparable
        // click volume — see significance.js) that prose mode already prints
        // but --json was silently dropping; a "significant" p with an
        // un-surfaced note reads as clean when the analyzer is warning about
        // a broken per-arm postback.
        note: rep.primary.note || null,
      };

    say(`\n${'─'.repeat(70)}`);
    say('STATISTICAL SIGNIFICANCE');
    say('─'.repeat(70));

    if (rep.degenerate) {
      say(`n/a — ${rep.degenerate}`);
    } else {
      say(`PRIMARY DECISION METRIC: ${rep.primary.metric}`);
      for (const pv of rep.primary.perVariant) {
        const rate = pv.rate === null ? 'n/a' : `${(pv.rate * 100).toFixed(1)}%`;
        say(`  ${pv.name}: ${pv.convUsers} converting / ${pv.users} clicking users = ${rate}`);
      }
      for (const jc of rep.joinCoverage) {
        const covStr = jc.coverage === null ? 'n/a (0 conversions)' : `${(jc.coverage * 100).toFixed(0)}%`;
        say(`  subId1 join coverage — ${jc.name}: ${covStr}`);
      }
      if (rep.primary.suppressed) {
        say(`  ⚠ primary p SUPPRESSED: ${rep.primary.suppressed}`);
      } else if (rep.primary.degenerate) {
        say(`  p: n/a (${rep.primary.degenerate})`);
      } else {
        say(`  ${rep.primary.test}: p = ${rep.primary.p.toFixed(4)} (z = ${rep.primary.z.toFixed(3)})`);
        if (rep.primary.note) say(`  note: ${rep.primary.note}`);
        if (rep.primary.significant) say(`  ✅ Statistically significant at p<0.05`);
        else say(`  ❌ Not significant at p<0.05`);
      }
      if (rep.underpowered) {
        say(`  ⚠️  Underpowered: ${rep.underpoweredNote}`);
      }

      say(`\nSECONDARY (${rep.secondary.metric}):`);
      for (const pv of rep.secondary.perVariant) {
        const cpu = pv.clicksPerUser === null ? 'n/a' : pv.clicksPerUser.toFixed(2);
        say(`  ${pv.name}: ${cpu} clicks/user`);
      }

      // Decision guidance — driven by the primary p, never by click direction
      // (guardrails memory: "direction looks clear" is not a winner).
      say(`\nDecision guidance:`);
      if (rep.primary.suppressed || rep.primary.degenerate) {
        say(`  → Primary metric unavailable (see above). Fix the data issue before judging.`);
      } else if (rep.underpowered) {
        say(`  → Continue running. Sample below advisory floors (see underpowered note).`);
      } else if (rep.primary.significant) {
        say(`  → Significant. Discuss with the owner before ANY flag change (guardrails memory rule 2).`);
      } else {
        say(`  → Continue running for clearer signal.`);
      }
    }
  }

  // ── Caveats ──
  say(`\n${'─'.repeat(70)}`);
  say('CAVEATS');
  say('─'.repeat(70));
  say('• Direct conversions use the SubId2 postback wired into affiliate-utils.ts');
  say('  on 2026-04-26 — distinct_id (subId1) + ab_variant (subId2) ride the click URL,');
  say('  Impact echoes them on each Action, this script joins on subId2.');
  say(`• A SubId2 must carry the \`flag:${FLAG}\` cohort prefix (added 2026-04-27)`);
  say('  to count toward THIS test. Bare `platform:X,buttons:Y` strings from before');
  say('  the prefix shipped, and any future test reusing the same keys, fall into');
  say('  the unattributed pool.');
  say('• Estimated split is NOT a measurement — it imports show-page A/B click ratios');
  say('  into a population (lottery/rush/discount/historical) the test never observed.');
  say('  It auto-suppresses once postback coverage reaches 80% (direct conversions');
  say('  are the measurement then).');
  say('• Primary metric denominator is CLICKING users, not exposed users — it measures');
  say('  conversion among clickers, not intent-to-treat. If a variant changes click');
  say('  propensity, interpret alongside the secondary clicks/user line.');
  say('• Click tracking only works when PostHog loads (ad blockers excluded via fallback filter).');
  say('• Methodology: see memory/feedback_ab_test_analysis.md');
  say('');

  if (JSON_OUT) console.log(JSON.stringify(summary));
}

main().catch(err => {
  console.error('Analysis error:', err);
  process.exit(1);
});
