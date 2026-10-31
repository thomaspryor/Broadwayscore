#!/usr/bin/env node
/**
 * BRO-5262: fail when a src/app/api/**\/route.ts GET handler dispatches a
 * GitHub workflow (emailed GET links get opened by mail scanners). Allowlist
 * with a reason in scripts/lib/get-route-dispatch.js. Advisory in test.yml
 * first (CLAUDE.md §19).
 *
 * Usage: node scripts/audit-get-route-dispatch.js [--json]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { auditRoutes } = require('./lib/get-route-dispatch');

const ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'src/app/api');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== '__tests__' && ent.name !== 'node_modules') walk(p, out); }
    else if (ent.name === 'route.ts' || ent.name === 'route.js') out.push(p);
  }
  return out;
}

const files = walk(API_DIR).map((p) => ({ path: path.relative(ROOT, p).split(path.sep).join('/'), src: fs.readFileSync(p, 'utf8') }));
const result = auditRoutes(files);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ scanned: files.length, ...result }, null, 2));
} else {
  console.log(`Scanned ${files.length} API route files.`);
  for (const a of result.allowed) console.log(`  allowlisted: ${a.path} (${a.chain.join(' -> ')}): ${a.reason}`);
  for (const v of result.violations) {
    console.log(`::error file=${v.path}::GET handler dispatches a workflow (${v.chain.join(' -> ')}). Mail scanners open emailed GET links, so GET must render a confirm page and only POST may dispatch (see src/app/api/autonomous-action/route.ts). Or allowlist it with a reason in scripts/lib/get-route-dispatch.js.`);
  }
  for (const s of result.stale) console.log(`::error::Stale allowlist entry in scripts/lib/get-route-dispatch.js: ${s} no longer dispatches from GET. Remove it.`);
}
const failed = result.violations.length + result.stale.length;
if (!failed) console.log('OK: no API route dispatches a workflow from GET.');
process.exit(failed ? 1 : 0);
