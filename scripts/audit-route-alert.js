#!/usr/bin/env node
'use strict';
/**
 * BRO-2454: list every routeAlert() call site in scripts/ and
 * .github/workflows/ and classify it write-before-notify / write-after-notify /
 * write-both / no-state-write (logic: scripts/lib/audit-route-alert-core.js).
 *
 *   node scripts/audit-route-alert.js            candidates + counts
 *   node scripts/audit-route-alert.js --all      every call site
 *   node scripts/audit-route-alert.js --json     machine-readable
 *   node scripts/audit-route-alert.js --strict   exit 1 on an unreviewed write-before-notify site
 */
const path = require('path');
const { KINDS, REVIEWED, auditTree, summarize, unreviewed } = require('./lib/audit-route-alert-core');

function main(argv = process.argv.slice(2), root = path.join(__dirname, '..')) {
  const rows = auditTree(root);
  const counts = summarize(rows);
  const open = unreviewed(rows);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ counts, unreviewed: open, rows }, null, 2));
  } else {
    const show = argv.includes('--all') ? rows : rows.filter((r) => r.kind === KINDS.BEFORE || r.kind === KINDS.BOTH || r.afterUngated.length);
    for (const r of show) {
      const tag = r.kind === KINDS.BEFORE ? (open.includes(r) ? 'UNREVIEWED' : 'reviewed') : '';
      console.log(`${r.kind}\t${r.file}:${r.line}\tdisposition=${r.disposition || '?'}\tbefore=[${r.writesBefore}] after=[${r.writesAfter}]`
        + `${r.afterUngated.length ? ` ungated-after=[${r.afterUngated}]` : ''}${tag ? `\t${tag}` : ''}`);
      if (tag === 'reviewed') console.log(`\t  ${REVIEWED[r.file].reason}`);
    }
    console.log(`\n${rows.length} call sites: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}; unreviewed write-before-notify ${open.length}`);
  }
  return argv.includes('--strict') && open.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
