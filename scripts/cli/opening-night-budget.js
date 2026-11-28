#!/usr/bin/env node
/**
 * Operator-facing budget table for upcoming opening nights.
 *
 * Prints a row per show in the next --window (default 14) days, showing
 * per-show + cumulative consumption against ScrapingBee / Browserbase /
 * LLM cost / GHA-minute budgets. Highlights the first show that pushes
 * each resource over its limit so the operator can see at-a-glance whether
 * 5/12 + 5/13 + 5/14 collectively exhaust ScrapingBee credits.
 *
 * Usage:
 *   node scripts/cli/opening-night-budget.js
 *   node scripts/cli/opening-night-budget.js --window=21
 *   node scripts/cli/opening-night-budget.js --json
 *
 * Env (optional — falls back to cap-based comparisons if missing):
 *   SCRAPINGBEE_API_KEY  — for live SB remaining
 *   GH_TOKEN             — for live GHA minutes remaining
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  estimateBudget,
  fetchLiveUsage,
  DEFAULT_PER_SHOW,
  DEFAULT_CAPS,
} = require('../lib/opening-night-budget');

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (a.startsWith('--')) out[a.slice(2)] = true;
  }
  return out;
}

const args = parseArgs();
const WINDOW_DAYS = Number(args.window) || 14;
const AS_JSON = !!args.json;

function loadShows() {
  const p = path.join(__dirname, '..', '..', 'data', 'shows.json');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  return data.shows || data;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function pad(s, n, align = 'left') {
  s = String(s);
  if (s.length >= n) return s.slice(0, n);
  const space = ' '.repeat(n - s.length);
  return align === 'right' ? space + s : s + space;
}

function dollars(n) { return `$${n.toFixed(2)}`; }

async function main() {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() + WINDOW_DAYS);

  const allShows = loadShows();
  const upcoming = allShows
    .filter(s => {
      if (!s.openingDate) return false;
      const d = new Date(s.openingDate);
      return d >= today && d < cutoff;
    })
    .sort((a, b) => a.openingDate.localeCompare(b.openingDate));

  if (upcoming.length === 0) {
    console.log(`No upcoming opens in the next ${WINDOW_DAYS} days.`);
    return;
  }

  // Group by openingDate to compute per-day cohort sizes (the orchestrator
  // fires per market-day, so cohorts on the same date hit the budget at the
  // same time).
  const byDate = new Map();
  for (const s of upcoming) {
    if (!byDate.has(s.openingDate)) byDate.set(s.openingDate, []);
    byDate.get(s.openingDate).push(s);
  }

  const usage = await fetchLiveUsage();

  // Header
  if (AS_JSON) {
    const rows = upcoming.map((s, i) => ({
      ix: i + 1,
      id: s.id,
      title: s.title,
      market: s.category || 'unknown',
      openingDate: s.openingDate,
      cumulative: estimateBudget(i + 1),
    }));
    console.log(JSON.stringify({ window_days: WINDOW_DAYS, usage, shows: rows }, null, 2));
    return;
  }

  const sbRemain = usage.scrapingbee && usage.scrapingbee.remaining;
  const ghaRemain = usage.gha_minutes && usage.gha_minutes.remaining;
  const bbCap = DEFAULT_CAPS.browserbase.dailyCap;

  console.log('');
  console.log(`Upcoming opening nights — next ${WINDOW_DAYS} days`);
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log('');

  // Available headroom block
  console.log('Live availability:');
  console.log(`  ScrapingBee : ${sbRemain != null ? sbRemain.toLocaleString() + ' credits remaining' : '(no live API; cap=' + DEFAULT_CAPS.scrapingbee.totalCap.toLocaleString() + ')'}`);
  console.log(`  Browserbase : daily soft cap ${bbCap} sessions (no live API)`);
  console.log(`  LLM dollars : daily soft caps Anthropic=${dollars(DEFAULT_CAPS.anthropic.dailyDollarCap)}, OpenAI=${dollars(DEFAULT_CAPS.openai.dailyDollarCap)}, Gemini=${dollars(DEFAULT_CAPS.gemini.dailyDollarCap)}`);
  console.log(`  GHA minutes : ${ghaRemain != null ? ghaRemain + ' min remaining this month' : '(no live API; cap=' + DEFAULT_CAPS.gha_minutes.monthlyCap + ' min/mo)'}`);
  console.log('');

  // Table header
  const cols = [
    pad('#', 3, 'right'),
    pad('Date', 11),
    pad('Show', 38),
    pad('Mkt', 7),
    pad('SBcr-cum', 11, 'right'),
    pad('BB-cum', 7, 'right'),
    pad('$LLM-cum', 9, 'right'),
    pad('GHA-cum', 8, 'right'),
    'Notes',
  ];
  console.log(cols.join(' '));
  console.log('-'.repeat(cols.join(' ').length + 20));

  const cumCulprits = { scrapingbee: null, gha_minutes: null };
  let i = 0;
  for (const s of upcoming) {
    i += 1;
    const cum = estimateBudget(i);
    const llmCum = cum.anthropic.total + cum.openai.total + cum.gemini.total;

    // Cumulative crossovers — only flag resources whose budget actually
    // accumulates across days (SB credits are monthly, GHA minutes are
    // monthly). Browserbase + LLM dollar caps reset daily; flag those in
    // the per-day cohort summary instead.
    const flags = [];
    if (sbRemain != null && cum.scrapingbee.total > sbRemain && !cumCulprits.scrapingbee) {
      cumCulprits.scrapingbee = s.id;
      flags.push('!SB-cap-here');
    }
    if (ghaRemain != null && cum.gha_minutes.total > ghaRemain && !cumCulprits.gha_minutes) {
      cumCulprits.gha_minutes = s.id;
      flags.push('!GHA-cap-here');
    }

    const row = [
      pad(i, 3, 'right'),
      pad(s.openingDate || '?', 11),
      pad((s.title || s.id).slice(0, 38), 38),
      pad((s.category || '?').slice(0, 7), 7),
      pad(cum.scrapingbee.total.toLocaleString(), 11, 'right'),
      pad(String(cum.browserbase.total), 7, 'right'),
      pad(dollars(round2(llmCum)), 9, 'right'),
      pad(String(cum.gha_minutes.total), 8, 'right'),
      flags.join(' '),
    ];
    console.log(row.join(' '));
  }

  console.log('');
  // Per-day cohort summary (most relevant — same-day fan-out is what stresses caps)
  console.log('Per-day cohort sizes (Browserbase + LLM caps reset daily):');
  for (const [date, shows] of byDate) {
    const dayBudget = estimateBudget(shows.length);
    const dayLLM = dayBudget.anthropic.total + dayBudget.openai.total + dayBudget.gemini.total;
    const flagStr = [];
    if (dayBudget.browserbase.total > bbCap) {
      flagStr.push(`!BB ${dayBudget.browserbase.total}>${bbCap}`);
    }
    if (dayBudget.anthropic.total > DEFAULT_CAPS.anthropic.dailyDollarCap) {
      flagStr.push(`!Anthropic ${dollars(dayBudget.anthropic.total)}>${dollars(DEFAULT_CAPS.anthropic.dailyDollarCap)}`);
    }
    console.log(`  ${date}: ${shows.length} show(s) — SB=${dayBudget.scrapingbee.total.toLocaleString()}, BB=${dayBudget.browserbase.total}, $LLM=${dollars(round2(dayLLM))}, GHA=${dayBudget.gha_minutes.total}min ${flagStr.join(' ')}`);
  }
  console.log('');

  // Summary of culprit shows
  const haveCulprits = Object.entries(cumCulprits).filter(([, v]) => v);
  if (haveCulprits.length > 0) {
    console.log('Cumulative cap crossovers:');
    for (const [res, id] of haveCulprits) {
      console.log(`  ${res}: first crossed at row ${upcoming.findIndex(x => x.id === id) + 1} → ${id}`);
    }
    console.log('');
  } else {
    console.log('All resources within budget for the full window.');
    console.log('');
  }
}

function round2(n) { return Math.round(n * 100) / 100; }

main().catch((err) => {
  console.error('Budget CLI failed:', err.message);
  process.exit(1);
});
