#!/usr/bin/env node
'use strict';
// BRO-2484: advisory audit. Thin wrapper; logic in scripts/lib/guard-call-sites.js.
// Flags audience-facing guards with a unit test but no test proving a call site.
// Exit 0 unless --strict and findings exist.
const { auditRepo } = require('./lib/guard-call-sites.js');

const strict = process.argv.includes('--strict');
const { checked, findings } = auditRepo();
console.log(`audit-guard-call-sites: ${checked.length} audience-facing guard(s) checked, ${findings.length} flagged`);
for (const c of checked) {
  const ok = c.provenCallSites.length > 0;
  console.log(`  ${ok ? 'OK  ' : 'WARN'} ${c.guard} (${c.lib})${ok ? ' proven via ' + c.provenCallSites.join(', ') : ''}`);
}
for (const f of findings) console.log(`FLAG ${f.guard}: ${f.reason}`);
if (findings.length && !strict) console.log('(advisory: exit 0; pass --strict to fail)');
process.exit(strict && findings.length ? 1 : 0);
