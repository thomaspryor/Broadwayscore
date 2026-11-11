#!/usr/bin/env node
'use strict';
/**
 * audit-provider-retirements.js (BRO-7342)
 *
 * Anthropic and Gemini twin of audit-openai-retirements.js (BRO-7339): diffs the provider's
 * published shutdown table against the repo registry (scripts/lib/research-cost.js
 * MODEL_SHUTDOWNS + ACCEPTED_SHUTDOWNS), limited to model ids the repo references.
 *
 *   node scripts/audit-provider-retirements.js --provider=anthropic|gemini [--html=PATH] [--strict] [--alert] [--json=PATH]
 *
 * Unreadable or empty page: exit 0 and an input-missing card, never a "clean" result.
 * Exit 1 only with --strict on an unregistered shutdown or a date that moved.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help');
const { PROVIDERS, readProviderPage, driftReport } = require('./lib/provider-deprecations');
const { MODEL_SHUTDOWNS, ACCEPTED_SHUTDOWNS } = require('./lib/research-cost');

const ROOT = path.join(__dirname, '..');
const REGISTRY_FILE = path.join(__dirname, 'lib', 'research-cost.js'); // its own tables would make every listed id look "used"
const argv = process.argv.slice(2);
const flagVal = (n) => { const a = argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

if (hasHelpFlag(argv)) {
  console.log('Usage:\n  node scripts/audit-provider-retirements.js --provider=anthropic|gemini [--html=PATH] [--strict] [--alert] [--json=PATH]\n'
    + '  Diffs the provider\'s shutdown table against MODEL_SHUTDOWNS for model ids this repo references.');
  process.exit(0);
}

const provider = flagVal('provider');
if (!PROVIDERS[provider]) {
  console.error('audit-provider-retirements: --provider=anthropic|gemini is required');
  process.exit(2);
}
const P = PROVIDERS[provider];

/** Non-test source that names this provider's models in quotes. */
function repoReferencedIds() {
  const ids = new Set();
  const skip = new Set(['node_modules', '.next', 'out', 'data', '.git', 'memory', 'docs']);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name) || e.name.startsWith('.worktrees')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?js|mjs|ts|tsx|ya?ml)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && p !== REGISTRY_FILE) {
        for (const id of P.referenced(fs.readFileSync(p, 'utf8'))) ids.add(id);
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
    const res = await fetch(P.url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
    if (res.ok) return await res.text();
  } catch (e) { /* fall through to curl (proxied sandboxes) */ }
  try { return execFileSync('curl', ['-sSL', '--max-time', '30', P.url], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }); } catch (e) { return ''; }
}

(async () => {
  const label = `audit-${provider}-retirements`;
  const today = new Date().toISOString().slice(0, 10);
  const { page, modelRows, inputMissing } = readProviderPage(provider, await fetchPage());
  const referenced = repoReferencedIds();
  const registry = { ...ACCEPTED_SHUTDOWNS, ...MODEL_SHUTDOWNS };
  const report = inputMissing ? { missing: [], dateDrift: [], soon: [] } : driftReport({ page, registry, referenced, today, baseIdFn: P.baseIdFn });
  const out = { generatedAt: new Date().toISOString(), provider, pageRows: page.length, referenced: referenced.size, inputMissing, ...report };

  if (inputMissing) console.log(`${label}: INPUT MISSING (parsed ${page.length} of ${modelRows} model rows from ${P.url}); nothing checked`);
  for (const m of report.missing) console.log(`UNREGISTERED  ${m.id} shuts down ${m.shutdown} (${m.daysLeft}d), replacement ${m.replacement || 'none named'}; add it to MODEL_SHUTDOWNS or ACCEPTED_SHUTDOWNS`);
  for (const d of report.dateDrift) console.log(`DATE MOVED    ${d.id}: registry ${d.registry}, ${P.name} now ${d.page}`);
  for (const s of report.soon) console.log(`SOON          ${s.id} ${s.shutdown} (${s.daysLeft}d) -> ${s.replacement || 'none named'}`);
  if (!inputMissing) console.log(`${label}: ${page.length} dated rows, ${referenced.size} model ids referenced, ${report.missing.length} unregistered, ${report.dateDrift.length} date changes`);

  const j = flagVal('json');
  if (j) fs.writeFileSync(j, JSON.stringify(out, null, 2));
  const strictFail = argv.includes('--strict') && !inputMissing && (report.missing.length || report.dateDrift.length);
  if (argv.includes('--alert')) {
    const { decideProviderRetirementAlerts } = require('./lib/provider-retirement-alert');
    const { routeAuditDecisions } = require('./lib/audit-alert');
    await routeAuditDecisions(decideProviderRetirementAlerts(provider, out), label);
  }
  process.exitCode = strictFail ? 1 : 0;
})().catch((err) => {
  console.error(`audit-provider-retirements: failed: ${err.stack || err.message}`);
  process.exitCode = 3;
});
