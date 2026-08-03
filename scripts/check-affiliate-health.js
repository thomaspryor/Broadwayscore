#!/usr/bin/env node
'use strict';

/**
 * check-affiliate-health.js — daily monitor for the affiliate revenue stream
 * (affiliate hardening plan, 2026-08-03).
 *
 * Until this existed, the weekly Monday email was the ONLY affiliate signal:
 * a total conversion breakage on a Tuesday stayed invisible for up to six
 * days, and even then read as "a bad week". This watches the four failure
 * layers daily, against each metric's own baseline:
 *
 *   site → click        PostHog ticket_click (real-users lens)
 *   click → Impact      Impact-recorded clicks (performance_by_day)
 *   Impact → conversion Impact actions
 *   conversion → payout payout economics (take-rate, $0 payouts)
 *
 * Baseline/silence/collapse judgments reuse scripts/lib/arm-yield.js (the
 * card-#647 primitive — adaptive per-metric thresholds learned from trailing
 * history, no hand-tuned constants to rot). Cross-source ratio checks and the
 * ungated dead-man's-switch live in scripts/lib/affiliate-anomaly.js. All
 * alerting routes through owner-alert-router (conditionKey cooldowns,
 * resolveCondition on recovery) — no bespoke cooldown state.
 *
 * SHADOW MODE: until SHADOW_UNTIL (or while AFFILIATE_MONITOR_SHADOW=1),
 * every check routes at digest tier while thresholds burn in against real
 * traffic — a first-week false positive must not train the owner to ignore
 * the channel (plan-review consensus finding). Kill switch:
 * AFFILIATE_MONITOR_DISABLED=true skips everything.
 *
 * Usage:
 *   node scripts/check-affiliate-health.js              # live run (routes alerts)
 *   node scripts/check-affiliate-health.js --dry-run    # judge + print only
 *   node scripts/check-affiliate-health.js --json       # machine-readable
 *   node scripts/check-affiliate-health.js --fixture=F  # replay from fixture JSON
 *   node scripts/check-affiliate-health.js --as-of=YYYY-MM-DD  # replay date (fixtures)
 *
 * Exit code is 0 whenever the monitor itself ran (alerts are the output
 * channel, per check-arm-yield.js's rationale); 1 only when the monitor
 * crashed — which data-health-check.yml surfaces via its own failure path.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { computeArmState, computeCollapseState, todayKey, toDayKey } = require('./lib/arm-yield');
const {
  checkHandoffBreak,
  checkBotDivergence,
  checkPayoutAnomaly,
  checkDeadMan,
  checkZeroConversionCeiling,
  sumWindow,
} = require('./lib/affiliate-anomaly');

const REPO_ROOT = path.join(__dirname, '..');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'data', 'audit', 'affiliate-health.json');
const LOOKBACK_DAYS = 28;

// Shadow burn-in ends 2026-08-17 (14 days from ship). Extend by setting
// AFFILIATE_MONITOR_SHADOW=1; force-live earlier with AFFILIATE_MONITOR_SHADOW=0.
const SHADOW_UNTIL = '2026-08-17';

const USAGE = `check-affiliate-health.js — daily affiliate revenue-stream monitor

Options:
  --dry-run            Judge and print; route no alerts, write no snapshot
  --json               Emit full check results as JSON
  --as-of=YYYY-MM-DD   Judge as of this date (fixture replays)
  --fixture=PATH       Replay from a fixture JSON instead of live APIs
                       ({impactDaily:[{date,clicks,conversions,payout,sales}],
                         posthogDaily:[{date,clicks,ttClicks}], actions:[...]})
  --help               This message

Env:
  AFFILIATE_MONITOR_DISABLED=true  Kill switch — skip everything
  AFFILIATE_MONITOR_SHADOW=1|0     Force shadow (digest-only) mode on/off`;

function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  // Judge as of YESTERDAY (UTC), the last COMPLETE day, by default. The cron
  // fires 06:45 UTC when "today" is a sliver everywhere (and Impact's
  // reporting day, US-anchored, has barely started) — trailing windows that
  // include a partial day systematically undercount and skew every threshold.
  const yesterday = toDayKey(Date.parse(`${todayKey()}T00:00:00Z`) - 24 * 60 * 60 * 1000);
  return {
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    asOf: get('as-of') || yesterday,
    fixture: get('fixture'),
  };
}

function isShadow(asOf) {
  const env = process.env.AFFILIATE_MONITOR_SHADOW;
  if (env === '1' || env === 'true') return true;
  if (env === '0' || env === 'false') return false;
  return asOf < SHADOW_UNTIL;
}

function seriesToMap(rows, field) {
  const map = new Map();
  for (const r of rows || []) map.set(r.date, Number(r[field]) || 0);
  return map;
}

async function loadData(args) {
  if (args.fixture) {
    const fx = JSON.parse(fs.readFileSync(args.fixture, 'utf8'));
    return { impactDaily: fx.impactDaily || [], posthogDaily: fx.posthogDaily || [], actions: fx.actions || [], errors: [] };
  }
  const { fetchImpactDaily, fetchImpactActionsWindow, fetchPosthogDailyClicks } = require('./lib/affiliate-stats');
  const errors = [];
  const [impactDaily, posthogDaily, actions] = await Promise.all([
    fetchImpactDaily(LOOKBACK_DAYS).catch((err) => { errors.push({ provider: 'impact', message: err.message }); return null; }),
    fetchPosthogDailyClicks(LOOKBACK_DAYS).catch((err) => { errors.push({ provider: 'posthog', message: err.message }); return null; }),
    fetchImpactActionsWindow(14).catch((err) => { errors.push({ provider: 'impact-actions', message: err.message }); return null; }),
  ]);
  return { impactDaily: impactDaily || [], posthogDaily: posthogDaily || [], actions: actions || [], errors };
}

/**
 * Run every check against the loaded series. Pure given its inputs — this is
 * what the fixture replay and the unit tests exercise.
 * @returns {Array<{key, label, verdict:'pass'|'warn'|'critical', reason, wantsPage:boolean}>}
 */
function runChecks({ impactDaily, posthogDaily, actions, errors, asOf }) {
  const checks = [];
  const convByDay = seriesToMap(impactDaily, 'conversions');
  const impactClicksByDay = seriesToMap(impactDaily, 'clicks');
  const ttClicksByDay = seriesToMap(posthogDaily, 'ttClicks');
  const allClicksByDay = seriesToMap(posthogDaily, 'clicks');

  // 1. Provider auth/API liveness — a revoked key surfaces TODAY, not as
  //    healthy-looking zeroes next Monday. (Partnerize deliberately excluded:
  //    dormant integration, hidden since 2026-04-11.)
  for (const provider of ['impact', 'posthog']) {
    const err = errors.find((e) => e.provider === provider || e.provider === `${provider}-actions`);
    checks.push({
      key: `affiliate:provider-auth:${provider}`,
      label: `${provider} API`,
      verdict: err ? 'critical' : 'pass',
      reason: err ? `${provider} fetch failed: ${err.message}` : 'reachable',
      wantsPage: true,
    });
  }
  const impactDead = errors.some((e) => e.provider === 'impact');
  const posthogDead = errors.some((e) => e.provider === 'posthog');

  // 2. Dead-man's-switch — ungated, catches shared-fate breakage of both
  //    click signals at once. Skipped only if we couldn't fetch either side.
  if (!impactDead && !posthogDead) {
    const dm = checkDeadMan({ impactClicksByDay, posthogClicksByDay: allClicksByDay, asOf });
    checks.push({
      key: 'affiliate:dead-man',
      label: 'Dead-man (both click signals)',
      verdict: dm.verdict === 'dead' ? 'critical' : 'pass',
      reason: dm.reason,
      wantsPage: true,
    });
  }

  // 3. Conversion flatline — silence judged against the metric's own history
  //    (arm-yield), conditioned on real clicks still flowing so a traffic
  //    outage reads as what it is (dead-man / click-flow) instead.
  if (!impactDead) {
    const state = computeArmState(convByDay, { asOf });
    if (state.verdict === 'dead') {
      const quietDays = Math.max(1, state.daysSinceLastYield || 1);
      const clicksDuringSilence = posthogDead ? null : sumWindow(ttClicksByDay, asOf, quietDays);
      const clicksCorroborate = clicksDuringSilence === null || clicksDuringSilence >= 10 * quietDays;
      checks.push({
        key: 'affiliate:conversions-flatline',
        label: 'Conversions flatline',
        verdict: clicksCorroborate ? 'critical' : 'warn',
        reason:
          `${state.reason}` +
          (clicksDuringSilence !== null
            ? ` — while ${clicksDuringSilence} real TodayTix clicks flowed over the same ${quietDays}d${clicksCorroborate ? '' : ' (below corroboration floor; may be a traffic dip, not attribution breakage)'}`
            : ''),
        wantsPage: clicksCorroborate,
      });
    } else {
      checks.push({
        key: 'affiliate:conversions-flatline',
        label: 'Conversions flatline',
        verdict: 'pass',
        reason: state.reason || state.verdict,
        wantsPage: true,
      });
    }

    // 4. Absolute zero-conversion ceiling — independent of click evidence.
    const ceiling = checkZeroConversionCeiling({ conversionsByDay: convByDay, asOf });
    checks.push({
      key: 'affiliate:zero-conversions',
      label: '7-day zero-conversion ceiling',
      verdict: ceiling.verdict === 'dead' ? 'critical' : 'pass',
      reason: ceiling.reason,
      wantsPage: true,
    });
  }

  // 5. Site-side click-flow collapse (PostHog TodayTix clicks vs own peak).
  if (!posthogDead) {
    const collapse = computeCollapseState(ttClicksByDay, { asOf });
    checks.push({
      key: 'affiliate:click-flow-collapse',
      label: 'Site ticket-click flow',
      verdict: collapse.verdict === 'collapsed' ? 'critical' : 'pass',
      reason: collapse.reason,
      wantsPage: false,
    });
  }

  // 6. Impact-side click collapse (redirect chain, judged on Impact's own numbers).
  if (!impactDead) {
    const collapse = computeCollapseState(impactClicksByDay, { asOf });
    checks.push({
      key: 'affiliate:impact-click-collapse',
      label: 'Impact click ingestion',
      verdict: collapse.verdict === 'collapsed' ? 'critical' : 'pass',
      reason: collapse.reason,
      wantsPage: false,
    });
  }

  // 7-8. Cross-source ratios (need both providers).
  if (!impactDead && !posthogDead) {
    const handoff = checkHandoffBreak({ impactClicksByDay, posthogTTClicksByDay: ttClicksByDay, asOf });
    checks.push({
      key: 'affiliate:handoff-break',
      label: 'Click → Impact handoff',
      verdict: handoff.verdict === 'broken' ? 'critical' : 'pass',
      reason: handoff.reason,
      wantsPage: true,
    });
    const bots = checkBotDivergence({ impactClicksByDay, posthogTTClicksByDay: ttClicksByDay, asOf });
    checks.push({
      key: 'affiliate:bot-divergence',
      label: 'Bot click divergence',
      verdict: bots.verdict === 'diverged' ? 'warn' : 'pass',
      reason: bots.reason,
      wantsPage: false,
    });
  }

  // 9. Payout economics.
  const payout = checkPayoutAnomaly({ actions, asOf });
  checks.push({
    key: 'affiliate:payout-anomaly',
    label: 'Payout economics',
    verdict: payout.verdict === 'anomalous' ? 'warn' : 'pass',
    reason: payout.reason,
    wantsPage: false,
  });

  return checks;
}

async function routeResults(checks, { asOf, shadow }) {
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  for (const check of checks) {
    if (check.verdict === 'pass') {
      // Re-arm so the NEXT incident alerts immediately instead of waiting
      // out the previous incident's cooldown (check-arm-yield pattern).
      resolveCondition(check.key);
      continue;
    }
    const critical = check.verdict === 'critical';
    // Shadow mode: everything digest-tier while thresholds burn in.
    const disposition = shadow ? 'digest' : critical && check.wantsPage ? 'human' : 'digest';
    const result = await routeAlert({
      conditionKey: check.key,
      title: `Affiliate revenue: ${check.label} — ${critical ? 'BROKEN' : 'anomaly'}${shadow ? ' [shadow]' : ''}`,
      description:
        `The affiliate ticket-revenue pipeline (the site's only revenue stream) tripped its "${check.label}" check as of ${asOf}. ` +
        `${check.reason}\n\n` +
        (shadow ? `(Shadow burn-in until ${SHADOW_UNTIL}: digest-only while thresholds calibrate — verify before reacting.)\n\n` : '') +
        `Replay: node scripts/check-affiliate-health.js --dry-run`,
      hint:
        'Layer map — site→click: check show pages render TodayTix buttons (verify-affiliate-links.js); ' +
        'click→Impact: hit a show page link and confirm the pxf.io redirect resolves; ' +
        'Impact→conversion: Impact dashboard Actions list; payout: contract terms on the Impact program. ' +
        'The 2026-08-03 investigation (Notion: "Affiliate report -77% WoW drop") documents the healthy baselines.',
      severity: critical ? 'error' : 'warning',
      disposition,
      cooldownHours: critical ? 48 : 168,
    });
    console.log(`[affiliate-health] ${check.key}: ${result.action}`);
  }
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return 0;
  }
  if (String(process.env.AFFILIATE_MONITOR_DISABLED).toLowerCase() === 'true') {
    console.log('AFFILIATE_MONITOR_DISABLED=true — skipping affiliate health monitor');
    return 0;
  }
  const args = parseArgs(process.argv.slice(2));
  const shadow = isShadow(args.asOf);
  const data = await loadData(args);
  const checks = runChecks({ ...data, asOf: args.asOf });

  const failing = checks.filter((c) => c.verdict !== 'pass');
  if (args.json) {
    console.log(JSON.stringify({ asOf: args.asOf, shadow, checks }, null, 2));
  } else {
    console.log(`Affiliate health as of ${args.asOf}${shadow ? ' [SHADOW MODE]' : ''}`);
    for (const c of checks) {
      const icon = c.verdict === 'pass' ? '✅' : c.verdict === 'warn' ? '⚠️' : '🔴';
      console.log(`${icon} ${c.label.padEnd(34)} ${c.reason}`);
    }
  }

  if (args.dryRun) {
    console.log(`\n[dry-run] ${failing.length} failing check(s) — no alerts routed, no snapshot written`);
    return 0;
  }

  await routeResults(checks, { asOf: args.asOf, shadow });

  // Snapshot for health-check.js's digest line + its own staleness dead-man.
  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(
    SNAPSHOT_PATH,
    JSON.stringify(
      {
        asOf: args.asOf,
        shadow,
        checks: checks.map(({ key, label, verdict, reason }) => ({ key, label, verdict, reason })),
        failingCount: failing.length,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  );
  console.log(`\n${failing.length} failing / ${checks.length} checks. Snapshot: ${path.relative(REPO_ROOT, SNAPSHOT_PATH)}`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('check-affiliate-health failed:', err.stack || err.message);
      process.exit(1);
    }
  );
}

module.exports = { runChecks, isShadow, SHADOW_UNTIL, LOOKBACK_DAYS };
