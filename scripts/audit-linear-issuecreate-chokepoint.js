#!/usr/bin/env node
/**
 * audit-linear-issuecreate-chokepoint.js — CI gate (task #1310): a shared
 * chokepoint that nobody is forced to use changes nothing. On 2026-08-12 a
 * session filed 8 Linear issues via a hand-rolled `issueCreate` GraphQL call
 * in a throwaway script — nothing caught it because there was no gate, only
 * a helper (scripts/lib/linear-client.js) that any script could ignore.
 *
 * This scans every tracked scripts/**\/*.js|mjs file for `issueCreate` or a
 * literal `api.linear.app` reference OUTSIDE the small allowlist of files
 * that are ALLOWED to talk to Linear's issue-creation API directly. Anything
 * else that mentions either string is a bypass of scripts/lib/linear-issue-
 * create.js (task #1310's chokepoint) and fails CI.
 *
 * Heuristic, not a parser — same class of tool as audit-run-budget-
 * coverage.js. False positives (a comment mentioning "issueCreate") are
 * possible; false negatives (a caller that builds the mutation string via
 * concatenation to dodge the literal) are possible too. It is a lint, not a
 * guarantee — good enough to catch the exact failure mode observed, not a
 * substitute for code review of anything touching scripts/lib/linear-*.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SCRIPTS_DIR = path.join(REPO_ROOT, 'scripts');

// Files allowed to reference issueCreate / api.linear.app directly.
const ALLOWLIST = new Set([
  'scripts/lib/linear-client.js', // the low-level GraphQL client itself
  'scripts/lib/linear-issue-create.js', // the chokepoint this gate protects
  'scripts/linear-import.js', // existing bulk-migration script, pre-dates the chokepoint
  'scripts/audit-linear-issuecreate-chokepoint.js', // this file's own doc comment mentions the strings
  'scripts/check-linear-delegations.js', // read-only gql() helper, no issueCreate — monitors delegated issue status, never creates issues
]);

const PATTERNS = [/issueCreate/, /api\.linear\.app/];

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (/\.(js|mjs)$/.test(entry.name) && !/\.test\.(js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function findViolations() {
  const violations = [];
  for (const file of listJsFiles(SCRIPTS_DIR)) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    if (ALLOWLIST.has(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      if (pattern.test(text)) {
        violations.push({ file: rel, pattern: pattern.source });
        break;
      }
    }
  }
  return violations;
}

function main() {
  const violations = findViolations();
  if (violations.length === 0) {
    console.log('audit-linear-issuecreate-chokepoint: OK — no bypasses found.');
    process.exit(0);
  }
  console.error(`audit-linear-issuecreate-chokepoint: ${violations.length} bypass(es) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file} — matches /${v.pattern}/`);
  }
  console.error(
    '\nCreate Linear issues through scripts/linear-brain.js (which goes through ' +
    'scripts/lib/linear-issue-create.js) instead of calling issueCreate/api.linear.app directly. ' +
    'If a file genuinely needs direct access, add it to ALLOWLIST in this script with a comment ' +
    'explaining why.'
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = { findViolations, ALLOWLIST, PATTERNS };
