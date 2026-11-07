#!/usr/bin/env node
'use strict';

/**
 * check-market-page-weight.js (BRO-5991)
 *
 * HTML size + <img> count budget for /west-end, /off-broadway, /off-west-end,
 * plus the big hub pages that must stay under Googlebot's 2MB read limit (BRO-5968),
 * plus the homepage and a show page (BRO-6278).
 *
 * Usage:
 *   node scripts/check-market-page-weight.js                 # built HTML in .next/server/app
 *   node scripts/check-market-page-weight.js --url=https://broadwayscorecard.com   # live pages
 *   node scripts/check-market-page-weight.js --strict        # exit 1 on a violation
 *
 * Advisory by default (CLAUDE.md section 19): prints violations, exits 0.
 * Arm --strict after the budgets have held on main for a while.
 */

const fs = require('fs');
const path = require('path');
const { MARKET_PAGE_BUDGETS, HUB_PAGE_BUDGETS, CORE_PAGE_BUDGETS, evaluateBudget } = require('./lib/page-weight.js');
const { hasHelpFlag } = require('./lib/cli-help.js');

const args = process.argv.slice(2);
if (hasHelpFlag(args)) {
  console.log('Usage: node scripts/check-market-page-weight.js [--url=<origin>] [--dir=<built app dir>] [--strict]\n\nChecks market list pages and big hub pages against HTML-size and <img>-count budgets. Advisory unless --strict.');
  process.exit(0);
}

const strict = args.includes('--strict');
const urlArg = (args.find(a => a.startsWith('--url=')) || '').slice(6).replace(/\/$/, '');
const dirArg = (args.find(a => a.startsWith('--dir=')) || '').slice(6);
const dir = dirArg || path.join(__dirname, '..', '.next', 'server', 'app');

async function loadHtml(budget) {
  if (urlArg) {
    const res = await fetch(urlArg + budget.route, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`${budget.route}: HTTP ${res.status}`);
    return res.text();
  }
  const file = path.join(dir, budget.htmlFile);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

async function main() {
  const violations = [];
  let checked = 0;
  for (const budget of [...MARKET_PAGE_BUDGETS, ...HUB_PAGE_BUDGETS, ...CORE_PAGE_BUDGETS]) {
    let html;
    try {
      html = await loadHtml(budget);
    } catch (e) {
      console.log(`SKIP ${budget.route}: ${e.message}`);
      continue;
    }
    if (html == null) {
      console.log(`SKIP ${budget.route}: no built HTML at ${path.join(dir, budget.htmlFile)}`);
      continue;
    }
    const r = evaluateBudget(budget, html);
    checked++;
    console.log(`${r.violations.length ? 'OVER' : 'ok  '} ${r.route}: ${(r.bytes / 1024).toFixed(0)}kB, ${r.imgs} <img> (budget ${(budget.maxBytes / 1024).toFixed(0)}kB, ${budget.maxImgs})`);
    violations.push(...r.violations);
  }
  if (violations.length) {
    console.log(`\n${strict ? 'FAIL' : 'ADVISORY'}: ${violations.length} page-weight violation(s):\n  ${violations.join('\n  ')}`);
    if (strict) process.exit(1);
  } else if (!checked) {
    console.log('No pages checked.');
  }
}

main().catch(e => { console.error(e); process.exit(strict ? 1 : 0); });
