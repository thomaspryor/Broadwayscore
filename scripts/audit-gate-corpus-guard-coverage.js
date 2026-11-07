#!/usr/bin/env node

/**
 * Task #1069 (extended #1619). CI lint: every `node scripts/audit-*.js
 * --gate` or `--strict` step in test.yml whose script walks
 * data/review-texts must call scripts/lib/corpus-scan-guard.js's
 * assertCorpusScanned(). Without this, nothing stops the NEXT audit
 * promoted to --gate/--strict from reintroducing the vacuous-gate class
 * fixed reactively 6 times across #1063/#1065/#1066/#1067/#1068 (10
 * scripts, 5+ sessions): a missing/empty private review-texts checkout
 * scans 0 files and reports a false-clean pass. #1619 extended this from
 * --gate-only after task #1608's session found a --strict-wired gap that
 * only a /second-opinion review caught, not this automated gate.
 *
 * Blocking by design (unlike audit-run-budget-coverage.js's advisory
 * heuristic) — this is a mechanical source-grep, not a loop-shape guess, so
 * false positives should be rare and are fixed by adding the guard, not by
 * an exemption comment.
 *
 * Usage: node scripts/audit-gate-corpus-guard-coverage.js [workflowPath] [scriptsDir]
 * Both args default to the real repo paths; overridable for testing against
 * a scratch copy of test.yml without touching the live workflow.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { findUnguardedGateAudits } = require('./lib/gate-corpus-guard-coverage');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, '.github', 'workflows', 'test.yml');
const SCRIPTS_DIR = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'scripts');

function main() {
  const workflowText = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const getScriptSource = (script) => {
    const scriptPath = path.join(SCRIPTS_DIR, script);
    if (!fs.existsSync(scriptPath)) return null;
    return fs.readFileSync(scriptPath, 'utf8');
  };

  const { violations, missingScripts, gateWiredCount, strictWiredCount } = findUnguardedGateAudits({
    workflowText,
    getScriptSource,
  });

  if (missingScripts.length > 0) {
    console.log('⚠️  --gate/--strict-wired script(s) referenced in the workflow but not found on disk (skipped):');
    for (const m of missingScripts) {
      console.log(`  • ${WORKFLOW_PATH}:${m.line} → scripts/${m.script}`);
    }
  }

  if (violations.length === 0) {
    console.log(
      `✅ Gate corpus-guard coverage: ${gateWiredCount} --gate-wired + ${strictWiredCount} --strict-wired ` +
        'audit(s) checked, every review-texts scanner among them calls assertCorpusScanned.'
    );
    process.exit(0);
  }

  console.error('❌ Gate corpus-guard coverage — missing assertCorpusScanned:\n');
  console.error('These scripts are wired as a blocking `--gate` or `--strict` step in test.yml AND');
  console.error('walk data/review-texts (readdirSync), but never call assertCorpusScanned from');
  console.error('scripts/lib/corpus-scan-guard.js — a missing/empty corpus checkout would');
  console.error('report a vacuous clean pass instead of failing loud (task #1063 class).\n');
  for (const v of violations) {
    console.error(`  • ${WORKFLOW_PATH}:${v.line} → scripts/${v.script}`);
  }
  console.error('\nFix: wire assertCorpusScanned into the script — see scripts/audit-review-contamination.js');
  console.error('for the pattern (require corpus-scan-guard, call assertCorpusScanned(scanned, { gate }) after the scan).');
  process.exit(1);
}

main();
