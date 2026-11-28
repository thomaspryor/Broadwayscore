#!/usr/bin/env node
// BRO-5963: helpers for backup-restore-drill.yml. Prints names and counts only.
//   pick <weekly|daily> <listing-file>   print the newest complete set's R2 prefix
//   supabase <unpacked-dir> [outer-manifest]   recount the export against its manifest
'use strict';
const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help.js');
const drill = require('./lib/backup-drill');

const argv = process.argv.slice(2);
if (hasHelpFlag(argv) || !argv.length) {
  console.log('Usage: node scripts/backup-restore-drill.js pick <weekly|daily> <listing-file>\n       node scripts/backup-restore-drill.js supabase <dir> [outer-manifest]');
  process.exit(hasHelpFlag(argv) ? 0 : 2);
}

try {
  const [cmd, a, b] = argv;
  if (cmd === 'pick') {
    const set = drill.pickLatestSet(a, fs.readFileSync(b, 'utf8'));
    console.log(set.prefix);
  } else if (cmd === 'supabase') {
    const { counts, problems } = drill.recountExport(a, b);
    for (const [k, v] of Object.entries(counts)) console.log(`${k}: ${v} rows`);
    if (problems.length) { console.error('RESTORE DRILL MISMATCH:\n' + problems.join('\n')); process.exit(1); }
    console.log(`OK: ${Object.keys(counts).length} datasets match the manifest`);
  } else { console.error(`unknown command: ${cmd}`); process.exit(2); }
} catch (e) { console.error('restore drill failed:', e.message); process.exit(1); }
