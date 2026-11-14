#!/usr/bin/env node
'use strict';

// BRO-2427 ratchet: fail on a Promise.race + setTimeout timeout wrapper whose
// timer is never cleared. Use withTimeout() from scripts/lib/with-timeout.js.
//   node scripts/audit-timeout-patterns.js          report; exit 1 on findings
//   node scripts/audit-timeout-patterns.js --json
const fs = require('fs');
const path = require('path');
const { findUnclearedTimeoutRaces } = require('./lib/timeout-pattern-audit');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.claude', 'out']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(e.name) && !/\.test\.[a-z]+$/.test(e.name)) out.push(p);
  }
  return out;
}

function audit() {
  const findings = [];
  for (const dir of ['scripts', 'src']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [])) {
      for (const hit of findUnclearedTimeoutRaces(fs.readFileSync(f, 'utf8'))) {
        findings.push({ file: path.relative(ROOT, f), ...hit });
      }
    }
  }
  return findings;
}

if (require.main === module) {
  const findings = audit();
  if (process.argv.includes('--json')) console.log(JSON.stringify(findings, null, 2));
  else if (findings.length) {
    console.error(`${findings.length} uncleared Promise.race timeout(s); use withTimeout() from scripts/lib/with-timeout.js:`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.text}`);
  } else console.log('No uncleared Promise.race timeouts found.');
  process.exit(findings.length ? 1 : 0);
}

module.exports = { audit };
