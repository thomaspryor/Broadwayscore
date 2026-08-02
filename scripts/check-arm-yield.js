#!/usr/bin/env node
'use strict';

/**
 * check-arm-yield.js — the cross-run "this arm produced nothing for N days"
 * detector (card #647).
 *
 * Every zero-data guard this repo had before was PER-RUN: "this run fetched
 * zero items → exit 1". The 2026-07-30 pipeline health audit found three arms
 * dead for 11 days, 16 days and 5 months, and no per-run guard could see any
 * of them — a cancelled run runs no guard, a failed run dies before its guard,
 * and a monthly cron gives a guard five chances in five months. The signal was
 * only ever visible across runs, in the absence itself.
 *
 * This reads the per-arm yield ledger (data/audit/arm-yield-ledger.jsonl,
 * written by record-arm-yield.js), judges each registered arm against a
 * threshold learned from that arm's OWN cadence (scripts/lib/arm-yield.js),
 * and routes at most one owner-visible alert per dead arm per incident through
 * owner-alert-router.js.
 *
 * Alerting deliberately uses disposition 'digest', not 'human': a dead arm is
 * a real problem but never a wake-the-owner one, and per the 2026-07-28 owner
 * mandate (card #611) only the page-worthy allowlist emails directly. The
 * router's ledger gives one notification per open incident, and a recovered
 * arm calls resolveCondition() so the NEXT outage alerts immediately instead
 * of waiting out a cooldown from the last one.
 *
 * Exit code is 0 whenever the check itself ran, even with dead arms — the
 * alert is the output channel, not the exit status. A non-zero exit here would
 * make this workflow's own runs red for as long as any arm stayed broken,
 * which is precisely how check-cron-health would then flag THIS detector as
 * stale and start redispatching it in a loop.
 *
 * Usage:
 *   node scripts/check-arm-yield.js                    # judge as of today
 *   node scripts/check-arm-yield.js --as-of=2026-07-30 # replay a past day
 *   node scripts/check-arm-yield.js --dry-run          # judge, alert nothing
 *   node scripts/check-arm-yield.js --json             # machine-readable
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { selectArms } = require('./lib/arm-registry');
const { DEFAULTS, detectDeadArms, todayKey } = require('./lib/arm-yield');

const REPO_ROOT = path.join(__dirname, '..');
const DEFAULT_LEDGER = path.join(REPO_ROOT, 'data', 'audit', 'arm-yield-ledger.jsonl');

const USAGE = `check-arm-yield.js — alert when a normally-productive pipeline arm goes silent

Options:
  --as-of=YYYY-MM-DD   Judge as of this day (default today, UTC). Replays history.
  --arms=id,id         Only these registry arm ids (default: all)
  --ledger=PATH        Ledger file (default data/audit/arm-yield-ledger.jsonl)
  --window-days=N      Baseline history window (default ${DEFAULTS.windowDays})
  --min-streak-days=N  Floor before any arm can be called dead (default ${DEFAULTS.minStreakDays})
  --dry-run            Judge and print; route no alerts, touch no ledger
  --json               Emit the full state array as JSON
  --help               This message`;

function parseArgs(argv) {
  const get = (name, dflt) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const num = (name, dflt) => {
    const raw = get(name, null);
    if (raw === null) return dflt;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : dflt;
  };
  return {
    asOf: get('as-of', todayKey()),
    arms: get('arms', null),
    ledger: get('ledger', DEFAULT_LEDGER),
    windowDays: num('window-days', DEFAULTS.windowDays),
    minStreakDays: num('min-streak-days', DEFAULTS.minStreakDays),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const ICON = {
  dead: '💀',
  unobserved: '🕳️',
  healthy: '✅',
  'insufficient-history': '·',
  'no-history': '·',
};

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return 0;
  }
  const args = parseArgs(process.argv.slice(2));
  const { arms, unknown } = selectArms(args.arms);
  if (unknown.length) {
    console.error(`Unknown arm id(s): ${unknown.join(', ')}`);
    return 1;
  }

  const entries = readLedger(args.ledger);
  if (!entries.length) {
    console.log(`No ledger rows at ${path.relative(REPO_ROOT, args.ledger)} — run record-arm-yield.js first.`);
    return 0;
  }

  const { states, dead, collapsed, unobserved } = detectDeadArms(entries, arms, {
    asOf: args.asOf,
    windowDays: args.windowDays,
    minStreakDays: args.minStreakDays,
  });

  if (args.json) {
    console.log(JSON.stringify({ asOf: args.asOf, states }, null, 2));
  } else {
    console.log(`Arm yield as of ${args.asOf} (${entries.length} ledger rows, ${states.length} arms)\n`);
    for (const s of states) {
      const isCollapsed = s.verdict !== 'dead' && s.collapse.verdict === 'collapsed';
      const icon = isCollapsed ? '📉' : ICON[s.verdict] || '?';
      const since = s.daysSinceLastYield === null ? '—' : `${s.daysSinceLastYield}d`;
      const thr = s.threshold === null ? '—' : `${s.threshold}d`;
      const reason = isCollapsed ? s.collapse.reason : s.reason;
      console.log(`${icon} ${s.id.padEnd(38)} last yield ${since.padStart(5)} / threshold ${thr.padStart(5)}  ${reason}`);
    }
    console.log('');
  }

  if (args.dryRun) {
    console.log(
      `[dry-run] ${dead.length} dead, ${collapsed.length} collapsed, ${unobserved.length} unobserved — no alerts routed`
    );
    return 0;
  }

  // Required lazily so --dry-run/--json replays never touch the alert ledger.
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');

  for (const s of dead) {
    const conditionKey = `arm-yield:${s.id}`;
    const result = await routeAlert({
      conditionKey,
      title: `Pipeline arm silent ${s.daysSinceLastYield}d: ${s.label}`,
      description:
        `${s.label} has produced nothing since ${s.lastYieldDate} (${s.daysSinceLastYield} days). ` +
        `Its own recent history never went quiet for more than ${s.longestPriorGap} day(s), ` +
        `so the alert threshold for this arm is ${s.threshold} days. ` +
        `Baseline: ${s.productiveDays} productive day(s) / ${s.windowItems} item(s) between ` +
        `${s.baselineWindow.from} and ${s.baselineWindow.to}.`,
      hint:
        `Check whether the arm's runs are being CANCELLED (a timeout cap — invisible to notify-failure, ` +
        `since \`if: always()\` does not fire on cancellation) or failing quietly at severity:low/email:false. ` +
        `Replay the detector with: node scripts/check-arm-yield.js --arms=${s.id} --as-of=${args.asOf} --dry-run`,
      severity: 'error',
      disposition: 'digest',
      cooldownHours: 168,
      fields: [
        { name: 'Last yield', value: s.lastYieldDate },
        { name: 'Silent for', value: `${s.daysSinceLastYield} days (threshold ${s.threshold})` },
      ],
    });
    console.log(`[arm-yield] ${conditionKey}: ${result.action}`);
  }

  for (const s of collapsed) {
    const conditionKey = `arm-yield-collapse:${s.id}`;
    const c = s.collapse;
    const result = await routeAlert({
      conditionKey,
      title: `Pipeline arm yield collapsed to ${Math.round(c.ratio * 100)}%: ${s.label}`,
      description:
        `${s.label} produced ${c.recentVolume} item(s) between ${c.recentWindow.from} and ${c.recentWindow.to}, ` +
        `against a peak of ${c.peakVolume} over the same window length in the trailing ${DEFAULTS.lookbackDays} days. ` +
        `It is still producing occasionally, so the silence rule does not fire — this is the shape the ` +
        `opening-night orchestrator's 2026-07-13..07-30 outage had (two successful scheduled runs in eighteen days, ` +
        `with stray single successes that reset any consecutive-zero counter).`,
      hint:
        `For a workflow arm, compare scheduled runs against successes: ` +
        `gh run list --workflow=<file> --limit 100 --json createdAt,conclusion,event. ` +
        `A wall of conclusion=cancelled means the job is hitting its timeout cap, which notify-failure never sees.`,
      severity: 'error',
      disposition: 'digest',
      cooldownHours: 168,
      fields: [
        { name: 'Recent volume', value: `${c.recentVolume} (last ${DEFAULTS.recentDays}d)` },
        { name: 'Peak volume', value: `${c.peakVolume} (best ${DEFAULTS.recentDays}d in ${DEFAULTS.lookbackDays}d)` },
      ],
    });
    console.log(`[arm-yield] ${conditionKey}: ${result.action}`);
  }

  // The recorder going dark looks EXACTLY like a healthy arm to any check that
  // only reads the last row, so it gets its own condition rather than silence.
  for (const s of unobserved) {
    const conditionKey = `arm-yield-unobserved:${s.id}`;
    const result = await routeAlert({
      conditionKey,
      title: `Arm yield ledger has no rows for ${s.label}`,
      description:
        `The yield ledger's most recent row for ${s.label} is ${s.lastObservedDate}, older than the ` +
        `${DEFAULTS.maxObservationAgeDays}-day observation window. The DETECTOR is blind for this arm — ` +
        `"no rows" must not be read as "healthy", which is the exact mistake card #647 exists to prevent.`,
      hint: `Check that check-arm-yield.yml's record step is running: node scripts/record-arm-yield.js --arms=${s.id} --backfill-days=7`,
      severity: 'warning',
      disposition: 'digest',
      cooldownHours: 168,
    });
    console.log(`[arm-yield] ${conditionKey}: ${result.action}`);
  }

  // Re-arm every healthy arm's condition so a NEW outage alerts immediately
  // rather than being swallowed by the previous incident's cooldown.
  for (const s of states) {
    if (s.verdict !== 'dead') resolveCondition(`arm-yield:${s.id}`);
    if (s.verdict !== 'unobserved') resolveCondition(`arm-yield-unobserved:${s.id}`);
    if (s.collapse.verdict !== 'collapsed') resolveCondition(`arm-yield-collapse:${s.id}`);
  }

  const clean = states.length - dead.length - collapsed.length - unobserved.length;
  console.log(`\n${dead.length} dead arm(s), ${collapsed.length} collapsed, ${unobserved.length} unobserved, ${clean} healthy/insufficient-history.`);
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error('check-arm-yield failed:', err.stack || err.message);
      process.exit(1);
    }
  );
}

module.exports = { readLedger };
