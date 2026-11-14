#!/usr/bin/env node
/**
 * BRO-6553: audit readable-text contrast on the dark surfaces.
 * Usage: node scripts/audit-text-contrast.js [--strict]   (exit 1 on violations only with --strict)
 */
const { checkToken, findLeftovers } = require('./lib/text-contrast.js');

const { token, failures } = checkToken();
const leftovers = findLeftovers();
for (const f of failures) console.log(`FAIL: ${f}`);
for (const l of leftovers) console.log(`FAIL: ${l} (use text-fg-muted)`);
const bad = failures.length + leftovers.length;
console.log(bad ? `${bad} violation(s)` : `OK: fg-muted ${token} passes 4.5:1 on all surfaces; no text-gray-500/600 text`);
process.exit(bad && process.argv.includes('--strict') ? 1 : 0);
