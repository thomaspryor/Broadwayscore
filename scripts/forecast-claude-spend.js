#!/usr/bin/env node
'use strict';
/**
 * Read-only forecaster for Claude Code session spend (BRO-3026).
 *
 * Answers, reproducibly: "how much of our Claude Code demand will overflow the
 * weekly plan allowance into paid usage credits, and what does that cost?"
 * Written after a fleet cost audit found $34,914 billed to Anthropic across
 * Jul+Aug 2026 with nothing in the codebase measuring it, and after the owner
 * pointed out that "let's observe for a week" is how findings get lost.
 *
 * IT ONLY READS AND REPORTS. It gates nothing, throttles nothing, calls no
 * paid API, and writes only to a MACHINE-LOCAL path — never to git-committed
 * data/audit/, because ~/.claude/projects exists on this Mac and on no CI
 * runner, so committing its rollup would dress a one-machine number up as
 * fleet-wide truth (/plan-review finding, 2026-09-08).
 *
 * Usage:
 *   node scripts/forecast-claude-spend.js                # human-readable
 *   node scripts/forecast-claude-spend.js --json         # machine-readable
 *   node scripts/forecast-claude-spend.js --days=90
 *   node scripts/forecast-claude-spend.js --help
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  priceUsage, weeklyBuckets, quantile, calibrateAllowance, forecastMonthly, ASSUMED_PRICE_TIERS,
} = require('./lib/claude-session-spend');

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (name, dflt) => {
  const hit = ARGS.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) ? n : dflt;
};

if (has('--help') || has('-h')) {
  console.log(`forecast-claude-spend.js — read-only Claude Code spend forecaster (BRO-3026)

  --days=N          days of transcript history to scan (default 90)
  --cap=N           provider monthly spend limit in $ (default 10000)
  --boost=N         current limit boost factor, 1.5 during a +50% boost (default 1)
  --cal-demand=N    calibration week's measured demand $ (default 22606)
  --cal-billed=N    calibration week's actual billed usage-credit $ (default 305)
  --json            emit JSON only
  --no-write        skip writing the local snapshot

Reads ~/.claude/projects/**/*.jsonl. Writes ~/.broadwayscore-state/claude-spend-snapshot.json (incl. dailyUsd per UTC day).
Calibration defaults come from the week of 2026-09-01..07, the one week where both
demand and the billed figure were known. Re-derive them when you have a better week.`);
  process.exit(0);
}

const DAYS = val('days', 90);
const CAP = val('cap', 10000);
const BOOST = val('boost', 1);
const CAL_DEMAND = val('cal-demand', 22606);
const CAL_BILLED = val('cal-billed', 305);
const JSON_ONLY = has('--json');

const root = path.join(os.homedir(), '.claude', 'projects');
const cutoffMs = Date.now() - DAYS * 864e5;
const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);

const byDay = Object.create(null);
const byTier = Object.create(null);
let files = 0;
let priced = 0;
let unpriced = 0;
let unreadable = 0;
const unpricedModels = new Set();

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(p);
    } else if (e.name.endsWith('.jsonl')) {
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        unreadable++;
        continue;
      }
      if (st.mtimeMs < cutoffMs) continue;
      files++;
      let txt;
      try {
        txt = fs.readFileSync(p, 'utf8');
      } catch {
        unreadable++;
        continue;
      }
      for (const line of txt.split('\n')) {
        // Cheap pre-filter, and tail-safe: sessions APPEND to these files while
        // we read, so the last line can be a partial write. JSON.parse is in a
        // try for exactly that — a truncated line is skipped, never counted.
        if (!line || line.indexOf('"usage"') === -1) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = o && o.message && o.message.usage;
        if (!usage) continue;
        const day = String(o.timestamp || '').slice(0, 10);
        if (!day || day < cutoffDay) continue;
        const { usd, tier } = priceUsage(usage, o.message.model);
        if (!tier) {
          unpriced++;
          if (o.message.model) unpricedModels.add(o.message.model);
          continue;
        }
        priced++;
        byDay[day] = (byDay[day] || 0) + usd;
        byTier[tier] = (byTier[tier] || 0) + usd;
      }
    }
  }
}

walk(root);

const days = Object.keys(byDay).sort();
const wk = weeklyBuckets(byDay);
const weekKeys = Object.keys(wk).sort();
// Drop first and last: both are partial weeks and would understate demand.
const fullWeeks = weekKeys.slice(1, -1).map((k) => wk[k]);
const dailyVals = days.map((d) => byDay[d]);

const allowance = calibrateAllowance({ demandWeek: CAL_DEMAND, billedWeek: CAL_BILLED }, BOOST);
const forecast = allowance
  ? forecastMonthly({ weeklyDemands: fullWeeks, baseWeekly: allowance.baseWeekly, monthlyCap: CAP })
  : null;

const top5 = [...dailyVals].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
const total = dailyVals.reduce((a, b) => a + b, 0);

const snapshot = {
  generatedAt: new Date().toISOString(),
  note: 'LIST-PRICE ESTIMATE of demand, not billed spend. Only the overflow above the plan allowance is billed.',
  scanned: { files, pricedMessages: priced, unpricedMessages: unpriced, unreadableFiles: unreadable, days: days.length },
  unpricedModels: [...unpricedModels],
  assumedPriceTiers: [...ASSUMED_PRICE_TIERS],
  demand: {
    totalUsd: total,
    byTierUsd: byTier,
    daily: { median: quantile(dailyVals, 0.5), p90: quantile(dailyVals, 0.9) },
    weekly: {
      n: fullWeeks.length,
      p25: quantile(fullWeeks, 0.25),
      median: quantile(fullWeeks, 0.5),
      p75: quantile(fullWeeks, 0.75),
      max: fullWeeks.length ? Math.max(...fullWeeks) : 0,
    },
    burstiness: { top5DayShare: total > 0 ? top5 / total : 0, daysUnder100: dailyVals.filter((v) => v < 100).length },
  },
  allowance,
  forecast,
  monthlyCapUsd: CAP,
  dailyUsd: byDay,
};

if (JSON_ONLY) {
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  const $ = (v) => '$' + Math.round(v).toLocaleString();
  console.log(`\nClaude Code spend forecast — ${days.length} days, ${files} transcripts, ${priced.toLocaleString()} priced messages`);
  if (unpriced) console.log(`  ! ${unpriced} messages had no price tier (models: ${[...unpricedModels].join(', ') || 'unknown'}) — EXCLUDED, not zero-rated`);
  console.log(`\nDEMAND (list-price equivalent, NOT what was billed)`);
  console.log(`  total ${$(total)} | daily median ${$(quantile(dailyVals, 0.5))} | daily p90 ${$(quantile(dailyVals, 0.9))}`);
  console.log(`  by tier: ${Object.entries(byTier).sort((a, b) => b[1] - a[1]).map(([t, v]) => `${t} ${$(v)}`).join(' | ')}`);
  console.log(`  burstiness: top 5 days = ${(100 * (total > 0 ? top5 / total : 0)).toFixed(0)}% of all demand; ${dailyVals.filter((v) => v < 100).length} days under $100`);
  console.log(`\nWEEKLY DEMAND (n=${fullWeeks.length} complete weeks)`);
  console.log(`  p25 ${$(quantile(fullWeeks, 0.25))} | median ${$(quantile(fullWeeks, 0.5))} | p75 ${$(quantile(fullWeeks, 0.75))} | max ${$(fullWeeks.length ? Math.max(...fullWeeks) : 0)}`);
  if (allowance) {
    console.log(`\nPLAN ALLOWANCE (calibrated from ${$(CAL_DEMAND)} demand vs ${$(CAL_BILLED)} billed, boost ${BOOST}x)`);
    console.log(`  base weekly allowance ${$(allowance.baseWeekly)}  [confidence: ${allowance.confidence}, n=${allowance.n}]`);
    if (allowance.confidence === 'provisional') console.log(`  ! provisional: one atypical calibration week would set this wrong. Recalibrate at n>=3.`);
  }
  if (forecast) {
    console.log(`\nFORECAST — monthly bill if the boost ends and demand holds`);
    console.log(`  ${forecast.overflowWeeks}/${forecast.weeks} historical weeks would overflow`);
    console.log(`  p25 (quiet)  ${$(forecast.monthly.p25)}`);
    console.log(`  median       ${$(forecast.monthly.median)}   <- use this, not the mean; demand is bursty`);
    console.log(`  p75 (busy)   ${$(forecast.monthly.p75)}${forecast.capBindsAtP75 ? `  (clamped by the ${$(CAP)} cap)` : ''}`);
    if (forecast.capBindsAtP75) {
      console.log(`\n  ! At p75 burn the ${$(CAP)} cap is exhausted in ${forecast.weeksToExhaustCapAtP75.toFixed(1)} weeks.`);
      console.log(`    The risk is a WORK STOPPAGE, not a bill. Set provider spend-approach notifications.`);
    }
  }
}

if (!has('--no-write')) {
  const dir = path.join(os.homedir(), '.broadwayscore-state');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, 'claude-spend-snapshot.json');
    const tmp = out + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, out); // atomic: never leave a half-written snapshot
    if (!JSON_ONLY) console.log(`\nsnapshot -> ${out}`);
  } catch (e) {
    console.error(`could not write snapshot: ${e.message}`);
  }
}
