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
// BRO-2603: arm-yield-ledger.jsonl is one of the 7 ledgers BRO-385 froze for
// 30 days (2026-08-26 -> 2026-09-25) — this is its sole producer, so gating
// here is what makes that freeze actually suppress new cards instead of just
// documenting a decision nothing reads.
const { isLedgerFrozenNow, freezeSkipMessage } = require('./freeze-ledgers.js');

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

/**
 * Plain-English site impact per arm kind, used as the FIRST sentence of every
 * alert. Without this the owner cannot tell a cosmetic pipeline hiccup from
 * "the site is missing reviews right now", and treats both as noise.
 */
const IMPACT = {
  outlet: 'The site may be missing new reviews from this outlet.',
  workflow: 'A scheduled job that keeps the site up to date has stopped succeeding.',
};

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
  // Freeze check keys off the LEDGER FILE THIS RUN ACTUALLY READ (args.ledger,
  // relative to the repo root), not a hardcoded default — code-review finding
  // (BRO-2603): `--ledger=PATH` (used for replay/testing against an alternate
  // file) previously always checked the canonical arm-yield-ledger.jsonl name
  // regardless of which file was read, so a replay against an unrelated file
  // could suppress real alerts, or a same-named-but-relocated ledger could
  // dodge suppression.
  const ledgerName = path.relative(REPO_ROOT, args.ledger).split(path.sep).join('/');
  const frozen = isLedgerFrozenNow(ledgerName);
  if (frozen) {
    console.log(`[arm-yield] ${freezeSkipMessage(ledgerName)} — suppressing all card filing this run`);
  }

  for (const s of dead) {
    const conditionKey = `arm-yield:${s.id}`;
    if (frozen) { console.log(`[arm-yield] ${conditionKey}: skipped (frozen)`); continue; }
    const result = await routeAlert({
      conditionKey,
      // Impact first, mechanism second. The owner reads this in a 7am digest
      // and is not a developer: the first sentence has to say what it means for
      // the SITE, not quote the threshold maths that decided to send it
      // (gpt-5.4-mini ship-check review, 2026-08-02 — "lead with user impact,
      // not statistics", and the terms 'arm'/'baseline'/'threshold' read as
      // internal jargon).
      title: `${s.label} has stopped updating (${s.daysSinceLastYield} days)`,
      description:
        `${IMPACT[s.id.split(':')[0]] || 'Part of the pipeline has stopped producing.'} ` +
        `Nothing new since ${s.lastYieldDate}, ${s.daysSinceLastYield} days ago. ` +
        // Only claim "longer than it has ever been quiet" when that is what
        // fired the alert. On a capped threshold the arm's own history is
        // LONGER than the alerting bar, so this sentence would contradict the
        // alert it is justifying — the reader checks the numbers and stops
        // trusting the detector.
        (s.thresholdCapped
          ? `Its past gaps run as long as ${s.longestPriorGap} day(s), but no arm is allowed to stay silent past ${s.threshold} days without a look. `
          : `It has never before gone quiet for more than ${s.longestPriorGap} day(s), so this is not its normal rhythm. `) +
        `Nothing is fixing this automatically — it needs a look.\n\n` +
        `(Detail: threshold ${s.threshold}d, from ${s.productiveDays} productive day(s) / ${s.windowItems} item(s) ` +
        `between ${s.baselineWindow.from} and ${s.baselineWindow.to}.)`,
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
    if (frozen) { console.log(`[arm-yield] ${conditionKey}: skipped (frozen)`); continue; }
    const c = s.collapse;
    const result = await routeAlert({
      conditionKey,
      title: `${s.label} is producing far less than usual (${Math.round(c.ratio * 100)}% of normal)`,
      description:
        `${IMPACT[s.id.split(':')[0]] || 'Part of the pipeline has nearly stopped producing.'} ` +
        `It managed ${c.recentVolume} in the last ${DEFAULTS.recentDays} days, against ${c.peakVolume} in its best ` +
        `recent fortnight. It has not stopped completely, which is why nothing else has flagged it — ` +
        `this is the shape the opening-night orchestrator's July outage had, where two stray successes in ` +
        `eighteen days kept every "has it gone silent?" check happy. It needs a look.`,
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
    if (frozen) { console.log(`[arm-yield] ${conditionKey}: skipped (frozen)`); continue; }
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
