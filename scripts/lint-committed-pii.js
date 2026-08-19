#!/usr/bin/env node

/**
 * Task #1074 (+ #1092: extended to data/audit/*.jsonl; + BRO-376: extended to
 * data/archive/*.jsonl after a real contest entrant's personal email address
 * shipped into data/archive/notion-card-history.jsonl — a migrated Notion
 * Outcome, not audit output, so the original data/audit/-only glob never saw
 * it). CI lint: no git-tracked data/audit/*.json[l] or data/archive/*.json[l]
 * file may carry submitter PII (name/email). See scripts/lib/pii-scan.js for
 * the detection rules and why this exists.
 *
 * Blocking by design — a committed PII leak in a PUBLIC repo is a real
 * exposure, not style debt. ALLOWLIST is an explicit inventory of files
 * with a known-legitimate hit (outlet contact address, critic byline),
 * the same pattern scripts/lint-resend-calls.js uses: adding a new file
 * requires a one-line justification, never a silent skip.
 *
 * Each entry carries a maxFindings count (scripts/.alert-sender-baseline.json's
 * pattern, per test.yml's "Audit — alert-sender direct-bypass gate": a count
 * map, not a file list, so a NEW leak landing in an already-allowlisted file
 * still fails instead of hiding behind the file-level exemption forever
 * (ship-check finding, 2026-08-06). Shrink/grow the count deliberately when
 * the file's known-legitimate content changes.
 *
 * Usage: node scripts/lint-committed-pii.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scanJsonValue, scanJsonlValue, formatPath } = require('./lib/pii-scan');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO_ROOT = path.join(__dirname, '..');

const ALLOWLIST = new Map([
  [
    'data/audit/truncated-reviews-to-fix.json',
    {
      reason:
        'copyrighted review-excerpt text ("ending" field) carries publicly-published ' +
        'outlet/critic contact addresses (e.g. LSA@lsamedia.com, nystagereview.com bylines) ' +
        '— not submitter PII from the feedback pipeline',
      maxFindings: 39,
    },
  ],
]);

function listTrackedAuditFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '--', 'data/audit/*.json', 'data/audit/*.jsonl', 'data/archive/*.json', 'data/archive/*.jsonl'],
    { cwd: REPO_ROOT, encoding: 'utf8' }
  );
  return out.split('\n').filter(Boolean);
}

function scanFile(relPath) {
  const absPath = path.join(REPO_ROOT, relPath);
  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    return { error: err.message, findings: [] };
  }
  if (relPath.endsWith('.jsonl')) {
    const findings = scanJsonlValue(text);
    return { error: null, findings, badLineNumbers: findings.badLineNumbers };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: err.message, findings: [] };
  }
  return { error: null, findings: scanJsonValue(parsed) };
}

const USAGE = `lint-committed-pii.js — no git-tracked data/audit or data/archive JSON may
carry submitter PII (task #1074, BRO-376).

Usage:
  node scripts/lint-committed-pii.js   scan every tracked data/audit + data/archive *.json[l]
  --help, -h                           show this message, do nothing else

Blocking by design: a committed PII leak in a PUBLIC repo is a real exposure.
ALLOWLIST (top of file) holds per-file maxFindings counts, so a NEW leak in an
already-allowlisted file still fails.
`;

function main(argv = process.argv.slice(2)) {
  // Before listTrackedAuditFiles(), which shells out to git via execFileSync.
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const files = listTrackedAuditFiles();
  const violations = [];
  const parseErrors = [];
  const badJsonlLines = [];

  for (const relPath of files) {
    const { error, findings, badLineNumbers } = scanFile(relPath);
    if (error) {
      parseErrors.push({ relPath, error });
      continue;
    }
    if (badLineNumbers && badLineNumbers.length > 0) {
      badJsonlLines.push({ relPath, badLineNumbers });
    }
    if (findings.length === 0) continue;
    const allowed = ALLOWLIST.get(relPath);
    if (allowed && findings.length <= allowed.maxFindings) continue;
    violations.push({ relPath, findings, allowed });
  }

  if (parseErrors.length > 0) {
    console.log('⚠️  Skipped (not valid JSON, not this lint\'s job to fix):');
    for (const p of parseErrors) console.log(`  • ${p.relPath}: ${p.error}`);
  }

  if (badJsonlLines.length > 0) {
    console.log(
      '⚠️  Unparseable line(s) in tracked .jsonl (skipped from the PII scan — a blind spot, ' +
        'not this lint\'s job to fix the data):'
    );
    for (const b of badJsonlLines) {
      console.log(`  • ${b.relPath}: line(s) ${b.badLineNumbers.join(', ')}`);
    }
  }

  if (violations.length === 0) {
    console.log(
      `✅ PII lint: ${files.length} committed data/audit + data/archive *.json[l] file(s) checked ` +
        `(${ALLOWLIST.size} allowlisted), none carry submitter PII.`
    );
    process.exit(0);
  }

  console.error('❌ Possible submitter PII in a committed, PUBLIC-repo data/audit file:\n');
  for (const v of violations) {
    if (v.allowed) {
      console.error(
        `  ${v.relPath} — ${v.findings.length} hit(s) exceeds its allowlisted baseline of ` +
          `${v.allowed.maxFindings}. New content in this file introduced a NEW finding — ` +
          'the allowlist covers a fixed count, not a blanket file skip.'
      );
    } else {
      console.error(`  ${v.relPath}`);
    }
    for (const f of v.findings) {
      const loc = formatPath(f.path) || '(root)';
      if (f.type === 'email-shaped-string') {
        console.error(`    • ${loc} → email-shaped string (${f.snippet})`);
      } else {
        console.error(`    • ${loc} → key named "${f.key}" looks like a submitter PII field`);
      }
    }
  }
  console.error(
    '\nNever store submitter name/email in a file committed to the PUBLIC ' +
      'thomaspryor/Broadwayscore repo — see scripts/lib/feedback-request-ledger.js. If this ' +
      'is a genuine non-PII case (an outlet contact address, a critic byline), add/raise it ' +
      'in ALLOWLIST in scripts/lint-committed-pii.js with a one-line justification and the ' +
      'new maxFindings count — do not silently drop the data instead.'
  );
  process.exit(1);
}

if (require.main === module) main();

module.exports = { listTrackedAuditFiles, scanFile, ALLOWLIST };
