#!/usr/bin/env node
/**
 * check-attribution-gap-clear.js — machine-checkable acceptance criteria for
 * the `provider-spend:attribution-gap:<provider>` cards check-provider-spend.js
 * files (BRO-4215).
 *
 * Exit 0 iff the latest recorded day in data/audit/provider-spend-daily.jsonl
 * has attributedPct[provider] >= attributionAlertMin (scripts/config/
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

const REPO = path.join(__dirname, '..');
const PROVIDERS = ['scrapingbee', 'scrapingdog', 'brightdata'];
const USAGE = `Usage: node scripts/check-attribution-gap-clear.js --provider=${PROVIDERS.join('|')}`;

function latestPct(lines, provider) {
  const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r) => r && r.day).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const last = records[records.length - 1];
  if (!last) return { day: null, pct: null };
  const pct = (last.attributedPct || {})[provider];
  return { day: last.day, pct: typeof pct === 'number' ? pct : null };
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
  const { day, pct } = latestPct(lines, provider);
  if (pct === null) {
    console.log(`CANNOT VERIFY: no measured ${provider} attribution in provider-spend-daily.jsonl (latest day: ${day || 'none'})`);
    return 3;
  }
  const verdict = pct >= min ? 'CLEAR' : 'OPEN';
  console.log(`${verdict}: ${provider} attributedPct ${Math.round(pct * 100)}% on ${day} (threshold ${Math.round(min * 100)}%)`);
  return pct >= min ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { latestPct, main };
