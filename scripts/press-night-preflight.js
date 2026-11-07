#!/usr/bin/env node
'use strict';
/**
 * press-night-preflight.js (BRO-6858): 24h and 3h before a Broadway press night, check that every key the night
 * spends on works and ScrapingBee has credits left. A problem pages the owner (press-night:preflight:, page-worthy)
 * with time to fix it; a clean run resolves the condition. Started by press-night-clock.yml.
 *
 *   node scripts/press-night-preflight.js --show=ID --night=YYYY-MM-DD --label=pf24|pf3 [--dry-run]
 * Exit 0 clean, 1 problems found (paged unless --dry-run), 2 bad args.
 */
require('./lib/cli-help').exitOnHelp(module);
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { preflightVerdict } = require('./lib/press-night-preflight');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const REPO = 'thomaspryor/Broadwayscore';

async function main() {
  const show = arg('show'); const night = arg('night'); const label = arg('label') || 'check';
  if (!/^[a-z0-9-]+$/.test(show) || !/^\d{4}-\d{2}-\d{2}$/.test(night) || !/^[a-z0-9-]+$/.test(label)) {
    console.error('--show=ID --night=YYYY-MM-DD --label=pf24|pf3 required'); return 2;
  }
  const dryRun = process.argv.includes('--dry-run');
  const out = path.join(require('os').tmpdir(), `press-night-secrets-${process.pid}.json`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, 'check-secrets-health.js'), `--json-out=${out}`, '--no-alert'],
      { stdio: ['ignore', 'ignore', 'inherit'], timeout: 180000 });
  } catch { /* non-zero exit = some check failed; the JSON still says which */ }
  let results = [];
  try { results = JSON.parse(fs.readFileSync(out, 'utf8')).results || []; } catch (e) { console.error(`::warning::no secrets results: ${e.message}`); }
  let sb = null;
  try { sb = await require('./lib/check-sb-credits').fetchSBCreditStatus(); } catch (e) { console.error(`::warning::ScrapingBee credit check failed: ${e.message}`); }
  const v = preflightVerdict({ results, sb });
  const summary = [`Press night preflight ${show} ${night} ${label}: ${v.ok ? 'clean' : `${v.problems.length} problem(s)`}`,
    ...v.problems.map((p) => `- ${p.key}: ${p.why}`),
    sb && sb.ok ? `ScrapingBee: ${Math.round(sb.pctUsed)}% used, ${sb.remaining} left` : 'ScrapingBee credits: unknown'];
  console.log(summary.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  if (dryRun) return v.ok ? 0 : 1;

  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  const conditionKey = `press-night:preflight:${show}:${night}:${label}`;
  // A clean run clears every preflight page of the night (a clean pf3 clears a pf24 page fixed since).
  if (v.ok) { for (const l of new Set([label, 'pf24', 'pf3'])) resolveCondition(`press-night:preflight:${show}:${night}:${l}`, { reason: `preflight ${label} clean` }); return 0; }
  const runUrl = process.env.GITHUB_RUN_ID ? `https://github.com/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const when = label === 'pf3' ? '3 hours' : label === 'pf24' ? '24 hours' : 'soon';
  const res = await routeAlert({
    conditionKey, severity: 'error', disposition: 'human', cooldownHours: 24,
    title: `Press night in ${when}: ${show} has ${v.problems.length} broken key(s)`,
    description: `${v.problems.map((p) => `${p.key} (${p.why})`).join('; ')}.${v.resendDown ? ' Resend is down, so this email may not arrive; the alert also goes to Linear.' : ''} Run: ${runUrl || 'local'}`,
    url: runUrl,
  });
  // A 'digest' result (the router downgraded the page) is still delivered: the owner sees it in the next digest.
  if (res && res.action === 'digest') console.log('alert: queued for the owner digest');
  else console.log(`alert: ${(res && res.action) || 'sent'}`);
  return 1;
}

if (require.main === module) main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
