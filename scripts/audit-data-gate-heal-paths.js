#!/usr/bin/env node
/**
 * audit-data-gate-heal-paths.js
 *
 * Lint ratchet (BRO-3507, follow-on to BRO-3425): every --strict/--gate step
 * in test.yml's `data-validation` job must have a heal path — a baseline-diff
 * mode, a scheduled --fix workflow, or an explicit `# heal-exempt: <reason>`
 * annotation. Without one, gates accumulate faster than anyone drains them
 * (BRO-3425 measured 23 such gates, only 2 with a real heal path) and main
 * stays red on drift rather than on real regressions.
 *
 * Decision logic lives in scripts/lib/data-gate-heal-paths.js (pure, tested
 * via scripts/lib/data-gate-heal-paths.test.mjs). This file just reads the
 * repo and reports.
 *
 * Usage:
 *   node scripts/audit-data-gate-heal-paths.js            # report
 *   node scripts/audit-data-gate-heal-paths.js --json     # JSON output (CI)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { auditDataValidationGates, auditCorpusDriftGates } = require('./lib/data-gate-heal-paths.js');
const { AUDITS: CORPUS_DRIFT_AUDITS } = require('./check-corpus-drift.js');

const USAGE = `audit-data-gate-heal-paths.js — every strict/gated Data Validation audit needs a heal path.

Usage:
  node scripts/audit-data-gate-heal-paths.js [options]
  node scripts/audit-data-gate-heal-paths.js --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const TEST_YML_PATH = path.join(WORKFLOWS_DIR, 'test.yml');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');

function readScriptSource(scriptName) {
  try {
    return fs.readFileSync(path.join(ROOT, 'scripts', `${scriptName}.js`), 'utf8');
  } catch {
    return '';
  }
}

function loadWorkflowFiles() {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((filename) => ({
      filename,
      content: fs.readFileSync(path.join(WORKFLOWS_DIR, filename), 'utf8'),
    }));
}

function main() {
  if (hasHelpFlag(args)) {
    console.log(USAGE);
    process.exit(0);
  }

  const testYmlContent = fs.readFileSync(TEST_YML_PATH, 'utf8');
  const workflowFiles = loadWorkflowFiles();
  const testYmlResult = auditDataValidationGates(testYmlContent, readScriptSource, workflowFiles);
  const corpusDriftResult = auditCorpusDriftGates(CORPUS_DRIFT_AUDITS, readScriptSource, workflowFiles);

  const gates = [...testYmlResult.gates, ...corpusDriftResult.gates];
  const violations = [...testYmlResult.violations, ...corpusDriftResult.violations];

  if (JSON_OUT) {
    console.log(JSON.stringify({ testYml: testYmlResult, corpusDrift: corpusDriftResult, gates, violations }, null, 2));
  }

  if (!testYmlResult.gates.length) {
    console.error('❌ No --strict/--gate steps found in the data-validation job — the parser likely broke (job renamed/restructured).');
    process.exit(1);
  }
  if (!corpusDriftResult.gates.length) {
    console.error('❌ No entries found in check-corpus-drift.js\'s AUDITS array — the parser likely broke (array renamed/restructured).');
    process.exit(1);
  }

  if (violations.length) {
    if (!JSON_OUT) {
      console.error(`❌ Data-gate heal-path ratchet failed: ${violations.length} of ${gates.length} gated audit(s) have no heal path.\n`);
      if (testYmlResult.violations.length) {
        console.error(`  test.yml data-validation job (${testYmlResult.violations.length}):`);
        for (const v of testYmlResult.violations) console.error(`    • scripts/${v.script}.js ${v.flags}`);
      }
      if (corpusDriftResult.violations.length) {
        console.error(`  check-corpus-drift.js AUDITS table (${corpusDriftResult.violations.length}):`);
        for (const v of corpusDriftResult.violations) console.error(`    • scripts/${v.script}.js ${v.flags}`);
      }
      console.error(
        '\nFix one of:\n' +
          '  1. Give the script a baseline-diff mode (write/read a data/audit/*baseline*.json).\n' +
          '  2. Add a scheduled workflow that runs it with --fix / --update-baseline / --heal / --write\n' +
          '     (see .github/workflows/fix-circular-duplicate-pairs.yml for the template).\n' +
          '  3. If auto-healing is unsafe (needs a human to judge each hit) or this is an\n' +
          '     intentional hard floor: in test.yml, annotate the step `# heal-exempt: <reason>`;\n' +
          '     in check-corpus-drift.js, add a `healExempt: \'<reason>\'` field to the AUDITS entry.'
      );
    }
    process.exit(1);
  }

  if (!JSON_OUT) {
    console.log(`✅ Data-gate heal-path ratchet passed (${gates.length} gated audits across both workflows, all have a heal path).`);
  }
}

main();
