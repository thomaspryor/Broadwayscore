#!/usr/bin/env node
/**
 * check-attribution-gap-clear.js — machine-checkable acceptance criteria for
 * the `provider-spend:attribution-gap:<provider>` cards check-provider-spend.js
 * files (BRO-4215).
 *
 * Exit 0 iff each of the last attributionAlertDays consecutive recorded days in
 * data/audit/provider-spend-daily.jsonl has attributedPct[provider] >=
 * attributionAlertMin (same window the alert fires on) (scripts/config/
 * provider-spend-thresholds.json), i.e. the scraper-spend ledger now explains
 * most of that provider's billed spend. Read-only. See autonomous-triage-core.js's
 * SAFE_CHECK_FORMS entry for the regex that locks --provider to known names.
 *
 * Exit codes: 0 gap closed · 1 gap still open · 3 cannot verify (no record,
 * or that day's billing API was unmeasured) · 2 usage error
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');
const { attributionWindowVerdict } = require('./lib/provider-spend-core');

const REPO = path.join(__dirname, '..');
const PROVIDERS = ['scrapingbee', 'scrapingdog', 'brightdata'];
const USAGE = `Usage: node scripts/check-attribution-gap-clear.js --provider=${PROVIDERS.join('|')}`;

function parseRecords(lines) {
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function main(argv) {
  if (hasHelpFlag(argv || [])) { console.log(USAGE); return 0; }
  const arg = (argv || []).find((a) => a.startsWith('--provider='));
  const provider = arg ? arg.slice('--provider='.length) : '';
  if (!PROVIDERS.includes(provider)) {
    console.error(USAGE);
    return 2;
  }
  const thresholds = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', 'config', 'provider-spend-thresholds.json'), 'utf8'));
  const min = thresholds.attributionAlertMin ?? 0.8;
  let lines = [];
  try { lines = fs.readFileSync(path.join(REPO, 'data', 'audit', 'provider-spend-daily.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { /* handled below */ }
  const days = thresholds.attributionAlertDays ?? 2;
  const v = attributionWindowVerdict(parseRecords(lines), provider, { min, days });
  const shown = v.days.map((d, i) => `${d}=${v.pcts[i] === null ? 'unmeasured' : Math.round(v.pcts[i] * 100) + '%'}`).join(', ');
  if (v.verdict === 'unverifiable') {
    console.log(`CANNOT VERIFY: need ${days} consecutive measured days of ${provider} attribution (have: ${shown || 'none'})`);
    return 3;
  }
  console.log(`${v.verdict.toUpperCase()}: ${provider} attributedPct ${shown} (threshold ${Math.round(min * 100)}% on each of the last ${days} days)`);
  return v.verdict === 'clear' ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main };
