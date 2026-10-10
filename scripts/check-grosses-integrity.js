#!/usr/bin/env node
/**
 * Weekly grosses integrity check (BRO-4988). Runs after every grosses ingest
 * in weekly-grosses.yml; the rules live in scripts/lib/grosses-integrity.js.
 *
 * Findings fall in two tiers:
 *   alert  - a defect someone can fix (bad key, missing week, rows that do
 *            not add up to the League total, a show that vanished, a copied
 *            gross, zero performances with a gross, an impossible jump).
 *            With --alert, each rule with findings files one card through
 *            owner-alert-router (disposition 'auto'); a rule that comes back
 *            clean resolves its condition.
 *   report - worth a look, often legitimate (a sold-out house at exactly
 *            100%, a flat run, a row whose seatsOffered the published
 *            figures cannot pin down). Printed and summarised only.
 *
 * Advisory (CLAUDE.md §19): exits 0 unless --strict and an alert-tier
 * finding exists.
 *
 * Usage:
 *   node scripts/check-grosses-integrity.js [--weeks=N] [--all] [--json] [--alert] [--strict]
 *     --weeks=N  check the newest N weeks (default 9: this week + the 8 the
 *                scraper may have backfilled)
 *     --all      check every week (history audit; never alerts)
 *     --rule=R   with --strict, fail only on rule R (each card's VERIFY line)
 */

const fs = require('fs');
const path = require('path');
const { checkGrossesIntegrity } = require('./lib/grosses-integrity');

const ALERT_RULES = new Set([
  'week-key-not-sunday', 'week-missing', 'week-overdue', 'total-mismatch', 'show-dropout',
  'duplicate-gross', 'zero-perf-gross', 'negative-value', 'wow-jump',
]);
const CONDITION_PREFIX = 'grosses-integrity:';
const RULE_HINTS = {
  'week-key-not-sunday': 'A Broadway week ends on Sunday. scripts/lib/grosses-history-repair.js normalizeWeekKeys() moves the key on the next scrape-grosses.ts run; if it persists, find the writer that skipped the repair.',
  'week-missing': 'Re-run weekly-grosses.yml (it backfills the 8 weeks before the current one from Playbill), or `npx tsx scripts/scrape-grosses.ts --week=YYYY-MM-DD`.',
  'week-overdue': 'The newest published week never reached grosses-history.json. Check this run\'s scrape step (a source still on the older week, or a write that stored nothing); re-run weekly-grosses.yml with force=true, or `npx tsx scripts/scrape-grosses.ts --week=YYYY-MM-DD`.',
  'total-mismatch': 'Stored rows do not add up to the League "Week\'s Total". Usually a show the scraper could not match to shows.json (see the run\'s "Unmatched" list) or a row dropped as implausible. Add the show / fix the matcher, then re-scrape that week with --week.',
  'show-dropout': 'A show in last week\'s data is missing this week and shows.json gives no closing date by then. Either it closed (set closingDate) or its row failed to match (fix the matcher and re-scrape).',
  'duplicate-gross': 'The same show grossed the same amount to the dollar in two weeks: one week was copied. Re-scrape the later week from Playbill with --week.',
  'zero-perf-gross': 'performances 0 with a gross: the backfill dropped Playbill\'s Previews column. grosses-history-repair.js derivePreviewPerformances() fills provable ones; re-scrape the week otherwise.',
  'negative-value': 'A gross, capacity, ATP or attendance below zero cannot come from the League figures: a parse error. Re-scrape the week from Playbill with --week.',
  'wow-jump': 'Gross moved more than 2.5x between two full weeks. Check the row against Playbill for both weeks; a mismatch means a row was matched to the wrong show.',
};

function parseArgs(argv) {
  const out = { weeks: 9, all: false, json: false, alert: false, strict: false, rule: null };
  for (const a of argv) {
    if (a.startsWith('--weeks=')) out.weeks = Math.max(1, parseInt(a.slice(8), 10) || 9);
    else if (a === '--all') out.all = true;
    else if (a === '--json') out.json = true;
    else if (a === '--alert') out.alert = true;
    else if (a === '--strict') out.strict = true;
    else if (a.startsWith('--rule=')) out.rule = a.slice(7) || null;
  }
  return out;
}

function loadJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'));
}

function groupByRule(findings) {
  const by = new Map();
  for (const f of findings) {
    if (!by.has(f.rule)) by.set(f.rule, []);
    by.get(f.rule).push(f);
  }
  return by;
}

function line(f) {
  return `${f.week}${f.slug ? ` ${f.slug}` : ''}: ${f.detail}`;
}

function writeStepSummary(scope, byRule) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const md = [`## Grosses integrity (${scope[0]}..${scope[scope.length - 1]})`, ''];
  if (byRule.size === 0) md.push('All checks passed.');
  for (const [rule, list] of byRule) {
    md.push(`**${rule}** (${ALERT_RULES.has(rule) ? 'alert' : 'report'}, ${list.length})`, '');
    for (const f of list.slice(0, 15)) md.push(`- ${line(f)}`);
    if (list.length > 15) md.push(`- ...and ${list.length - 15} more`);
    md.push('');
  }
  fs.appendFileSync(file, md.join('\n') + '\n');
}

// One condition per rule and newest affected week: a defect that persists
// stays on its open card (silent refire), while a new week of trouble files
// its own card instead of hiding under the first one's cooldown. Open
// conditions whose week no longer has findings are resolved.
function conditionKeyFor(rule, list) {
  const newest = list.map((f) => f.week).filter(Boolean).sort().pop() || 'none';
  return `${CONDITION_PREFIX}${rule}:${newest}`;
}

async function routeFindings(byRule) {
  const { routeAlert, resolveCondition, loadLedger } = require('./lib/owner-alert-router');
  const open = Object.entries(loadLedger().conditions || {})
    .filter(([k, c]) => k.startsWith(CONDITION_PREFIX) && c && c.status === 'open')
    .map(([k]) => k);
  for (const rule of ALERT_RULES) {
    const list = byRule.get(rule) || [];
    const weeks = new Set(list.map((f) => f.week));
    for (const key of open) {
      const m = key.match(/^grosses-integrity:([^:]+):(.+)$/);
      if (m && m[1] === rule && !weeks.has(m[2])) resolveCondition(key, { reason: 'grosses integrity check clean for that week' });
    }
    if (list.length === 0) continue;
    const conditionKey = conditionKeyFor(rule, list);
    const res = await routeAlert({
      conditionKey,
      title: `Grosses integrity: ${list.length} ${rule} finding(s)`,
      description: list.slice(0, 25).map((f) => `- ${line(f)}`).join('\n'),
      hint: RULE_HINTS[rule],
      severity: 'warning',
      disposition: 'auto',
      category: 'data-quality',
      cooldownHours: 24 * 30,
      verify: { line: `VERIFY: node scripts/check-grosses-integrity.js --strict --rule=${rule}`, note: `exits 0 once no ${rule} finding remains in the newest 9 weeks` },
    });
    console.log(`  alert ${conditionKey}: ${res.action}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const history = loadJson('data/grosses-history.json');
  const shows = loadJson('data/shows.json').shows || [];
  const keys = Object.keys(history.weeks || {}).sort();
  const scope = args.all ? keys : keys.slice(-args.weeks);
  const findings = checkGrossesIntegrity(history, shows, {
    weeks: scope,
    // Full history in --all: KNOWN_GAPS (grosses-integrity.js) covers the
    // accepted holes, so any other gap since 2001 is reported.
    missingSince: args.all ? '0000-01-01' : undefined,
    now: new Date(),
  });
  const byRule = groupByRule(findings);
  const alertCount = findings.filter((f) => ALERT_RULES.has(f.rule) && (!args.rule || f.rule === args.rule)).length;

  if (args.json) {
    console.log(JSON.stringify({ scope: [scope[0], scope[scope.length - 1]], alertCount, findings }, null, 2));
  } else {
    console.log(`Grosses integrity: ${scope.length} week(s) ${scope[0]}..${scope[scope.length - 1]}, ${findings.length} finding(s), ${alertCount} alert-tier`);
    for (const [rule, list] of byRule) {
      console.log(`\n${rule} [${ALERT_RULES.has(rule) ? 'alert' : 'report'}] (${list.length})`);
      for (const f of list.slice(0, args.all ? 10 : 50)) console.log(`  ${line(f)}`);
      if (list.length > (args.all ? 10 : 50)) console.log(`  ...and ${list.length - (args.all ? 10 : 50)} more`);
    }
    if (alertCount) console.log(`\n::warning::grosses integrity: ${alertCount} alert-tier finding(s) (${[...byRule.keys()].filter((r) => ALERT_RULES.has(r)).join(', ')})`);
  }
  writeStepSummary(scope, byRule);

  if (args.alert && !args.all) await routeFindings(byRule);
  if (args.strict && alertCount) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`check-grosses-integrity: ${err.stack || err.message}`);
    process.exit(2);
  });
}

module.exports = { ALERT_RULES, parseArgs, conditionKeyFor, routeFindings };
