#!/usr/bin/env node
'use strict';
/**
 * CLI wrapper for scoring-recency.js (BRO-4770), for bash conflict resolvers.
 * For each file, make the working-tree version carry the newer scoring group
 * found in any of the given git refs. Run from the repo root of the data repo.
 *
 * Usage: node carry-newer-scoring.js --refs=HEAD,REBASE_HEAD file1.json file2.json ...
 * Prints the number of files modified (last line).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { carryNewerScoring } = require(path.join(__dirname, 'scoring-recency.js'));

const refsArg = process.argv.find(a => a.startsWith('--refs='));
const refs = refsArg ? refsArg.split('=')[1].split(',').filter(Boolean) : [];
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));

let modified = 0;
for (const f of files) {
  if (!f.endsWith('.json') || f.includes('failed-fetches') || !fs.existsSync(f)) continue;
  let local;
  try { local = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
  let changed = false;
  for (const ref of refs) {
    let other;
    try {
      other = JSON.parse(execFileSync('git', ['show', `${ref}:${f}`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1 << 26 }));
    } catch { continue; }
    if (carryNewerScoring(local, other).changed) {
      changed = true;
      process.stderr.write(`  Newer scoring kept from ${ref}: ${f}\n`);
    }
  }
  if (changed) { fs.writeFileSync(f, JSON.stringify(local, null, 2) + '\n'); modified++; }
}
console.log(String(modified));
