import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');

// BRO-2961: 34 of 85 scraping workflows passed a scraping API key but never
// committed data/audit/scraper-spend-ledger.jsonl, so provider-telemetry.js's
// per-call rows never reached origin/main and check-provider-spend.js's
// attributedPct read 0.9-3.4% while billing burned 20-60K credits/day. Fixed
// (51a797ffee4) by wiring the commit-scraper-spend-ledger composite action
// into the real gaps scripts/lib/ledger-coverage-check.js's AST walk found
// (12, not the 44 a naive `grep SCRAPINGBEE_API_KEY` suggested — see that
// file's header for the false positives it avoids, e.g. scraper-cost-
// report.yml's billing-API curl never calls fetchPage()).
//
// This test is the node --test regression guard for that fix: it re-runs the
// exact repo-wide scan `bash scripts/lint-workflow-guards.sh ledger-coverage`
// runs in CI (scripts/lint-workflow-guards.sh:check_ledger_coverage), against
// require()'d production code — not a copy of its logic — so a reintroduced
// gap (new workflow, or an edit that drops a ledger-commit step) fails here
// too, not just in the bash-wrapped CI step.
test('every workflow reaching the scraper-spend ledger commits it, or is a documented exemption', () => {
  const { findLedgerScripts, findMissingLedgerCommits } = require('../../scripts/lib/ledger-coverage-check.js');
  const { EXEMPTIONS, isExempt } = require('../../scripts/lib/ledger-coverage-exemptions.js');

  const ledgerScripts = findLedgerScripts(path.join(ROOT, 'scripts'));
  const workflowsDir = path.join(ROOT, '.github', 'workflows');
  const usedExemptions = new Set();
  const violations = [];

  for (const name of fs.readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
    const text = fs.readFileSync(path.join(workflowsDir, name), 'utf8');
    for (const v of findMissingLedgerCommits(text, ledgerScripts)) {
      if (isExempt(name, v.job)) {
        usedExemptions.add(`${name}#${v.job}`);
      } else {
        violations.push(`${name}: ${v.message}`);
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    'workflows below call a ledger-reaching script but no step in the same job stages ' +
      'data/audit/scraper-spend-ledger.jsonl for commit — add the commit-scraper-spend-ledger ' +
      'composite action (see .github/actions/commit-scraper-spend-ledger), or a documented ' +
      'entry in scripts/lib/ledger-coverage-exemptions.js',
  );

  // Every exemption must correspond to a real, currently-detected violation —
  // a stale entry (fixed workflow, forgotten cleanup) silently masks nothing
  // today, but it rots the file into an untrustworthy audit trail.
  const staleExemptions = EXEMPTIONS.filter((e) => !usedExemptions.has(`${e.file}#${e.job}`));
  assert.deepEqual(
    staleExemptions.map((e) => `${e.file}#${e.job}`),
    [],
    'stale entries in scripts/lib/ledger-coverage-exemptions.js no longer match a real violation — remove them',
  );
});
