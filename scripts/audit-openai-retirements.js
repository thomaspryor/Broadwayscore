#!/usr/bin/env node
'use strict';
/**
 * audit-openai-retirements.js (BRO-7339)
 *
 * Diffs OpenAI's published shutdown table against the repo's own registry
 * (scripts/lib/research-cost.js MODEL_SHUTDOWNS + ACCEPTED_SHUTDOWNS), limited to
 * model ids the repo actually references. gpt-5-mini and o3 were scheduled for
 * 2026-12-11 in a notice of 2026-06-11 and nothing here knew; this is what would
 * have said so in June.
 *
 *   node scripts/audit-openai-retirements.js [--html=PATH] [--strict] [--alert] [--json=PATH]
 *
 *   --html=PATH  read a saved copy of the page instead of fetching it
 *   --strict     exit 1 on an unregistered shutdown or a date that moved
 *   --alert      file/refresh a worker card (scripts/lib/audit-alert.js); clears it when clean
 *
 * Unreadable or empty page: exit 0 and an input-missing card, never a "clean" result.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');
const { parseDeprecations, referencedModelIds, driftReport } = require('./lib/openai-deprecations');
const { MODEL_SHUTDOWNS, ACCEPTED_SHUTDOWNS } = require('./lib/research-cost');

const URL_PAGE = 'https://developers.openai.com/api/docs/deprecations';
const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const flagVal = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

if (hasHelpFlag(argv)) {
  console.log('Usage:\n  node scripts/audit-openai-retirements.js [--html=PATH] [--strict] [--alert] [--json=PATH]\n'
    + '  Diffs OpenAI\'s shutdown table against MODEL_SHUTDOWNS for model ids this repo references.');
  process.exit(0);
}

/** Non-test source that names OpenAI models in quotes. */
function repoReferencedIds() {
  const ids = new Set();
  const skip = new Set(['node_modules', '.next', 'out', 'data', '.git', 'memory', 'docs']);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || e.name.startsWith('.worktrees')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?js|mjs|ts|tsx|ya?ml)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        for (const id of referencedModelIds(fs.readFileSync(p, 'utf8'))) ids.add(id);
      }
    }
  };
  for (const d of ['scripts', 'src', '.github/workflows']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  return ids;
}

async function fetchPage() {
  const html = flagVal('html');
  if (html) return fs.readFileSync(html, 'utf8');
  try {
    const res = await fetch(URL_PAGE, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (res.ok) return await res.text();
  } catch (e) { /* fall through to curl (proxied sandboxes) */ }
  try { return execFileSync('curl', ['-sSL', '--max-time', '30', URL_PAGE], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch (e) { return ''; }
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const page = parseDeprecations(await fetchPage());
  const inputMissing = page.length < 5; // the live page has 200+ dated rows; a handful means a shell or a block page
  const referenced = repoReferencedIds();
  const registry = { ...ACCEPTED_SHUTDOWNS, ...MODEL_SHUTDOWNS };
  const report = inputMissing ? { missing: [], dateDrift: [], soon: [] } : driftReport({ page, registry, referenced, today });
  const out = { generatedAt: new Date().toISOString(), pageRows: page.length, referenced: referenced.size, inputMissing, ...report };

  if (inputMissing) console.log(`audit-openai-retirements: INPUT MISSING (parsed ${page.length} rows from ${URL_PAGE}); nothing checked`);
  for (const m of report.missing) console.log(`UNREGISTERED  ${m.id} shuts down ${m.shutdown} (${m.daysLeft}d), replacement ${m.replacement || 'none named'}; add it to MODEL_SHUTDOWNS or ACCEPTED_SHUTDOWNS`);
  for (const d of report.dateDrift) console.log(`DATE MOVED    ${d.id}: registry ${d.registry}, OpenAI now ${d.page}`);
  for (const s of report.soon) console.log(`SOON          ${s.id} ${s.shutdown} (${s.daysLeft}d) -> ${s.replacement || 'none named'}`);
  if (!inputMissing) console.log(`audit-openai-retirements: ${page.length} dated rows, ${referenced.size} model ids referenced, ${report.missing.length} unregistered, ${report.dateDrift.length} date changes`);

  const j = flagVal('json');
  if (j) fs.writeFileSync(j, JSON.stringify(out, null, 2));
  const strictFail = argv.includes('--strict') && !inputMissing && (report.missing.length || report.dateDrift.length);
  if (argv.includes('--alert')) {
    const { decideOpenAiRetirementAlerts } = require('./lib/openai-retirement-alert');
    const { routeAuditDecisions } = require('./lib/audit-alert');
    await routeAuditDecisions(decideOpenAiRetirementAlerts(out), 'audit-openai-retirements');
  }
  process.exitCode = strictFail ? 1 : 0;
})().catch((err) => {
  console.error(`audit-openai-retirements: failed: ${err.stack || err.message}`);
  process.exitCode = 3;
});
