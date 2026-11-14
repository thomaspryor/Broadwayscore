#!/usr/bin/env node
/**
 * Migration script: Add checkout-core-data step to all workflows.
 *
 * For each workflow file, finds the FIRST `actions/checkout@v4` in each job
 * that does NOT have `repository:` (i.e., the main repo checkout), and inserts
 * a `checkout-core-data` step immediately after it.
 *
 * Usage: node scripts/migrate-add-core-data-checkout.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const SKIP_LIST = new Set([
  'mirror-to-gitlab.yml',
  'mirror-review-texts-to-gitlab.yml',
  'rotate-gitlab-token.yml',
  'purge-archives-history.yml',
  'check-secrets-health.yml',
  'vercel-build-guard.yml',
]);

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function processWorkflow(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Skip if already has checkout-core-data
  if (content.includes('checkout-core-data')) {
    return { modified: false, reason: 'already has checkout-core-data' };
  }

  // Skip if no checkout@v4
  if (!content.includes('actions/checkout@v4')) {
    return { modified: false, reason: 'no checkout@v4' };
  }

  const lines = content.split('\n');
  const insertions = []; // { before: lineIndex, stepIndent: string }

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('actions/checkout@v4')) continue;

    // Get the indentation of this line
    const lineMatch = lines[i].match(/^(\s*)/);
    if (!lineMatch) continue;
    const lineIndent = lineMatch[1];

    // Determine step indent (the indent of the `- ` list marker)
    let stepIndent;
    if (/^\s+- /.test(lines[i])) {
      // This line starts with `- uses:` — it IS the step start
      stepIndent = lines[i].match(/^(\s+)- /)[1];
    } else {
      // This is a `uses:` property line — step started above at 2-less indent
      stepIndent = lineIndent.slice(0, -2);
    }

    const propertyIndent = stepIndent + '  ';

    // Scan forward: check for `repository:` and find the next step boundary
    let hasRepository = false;
    let nextStepLine = lines.length;
    const stepRegex = new RegExp(`^${escapeRegex(stepIndent)}- `);

    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      // Check if we've reached the next step at this indent level
      if (stepRegex.test(lines[j])) {
        nextStepLine = j;
        break;
      }

      // Check if indent dropped below step property level (left the steps block)
      const jMatch = lines[j].match(/^(\s*)/);
      const jIndent = jMatch ? jMatch[1].length : 0;
      if (jIndent <= stepIndent.length && trimmed !== '') {
        nextStepLine = j;
        break;
      }

      if (trimmed.startsWith('repository:') || trimmed.includes('repository:')) {
        hasRepository = true;
      }
    }

    if (hasRepository) continue;

    // This is a main repo checkout. Mark insertion point.
    // Check we haven't already inserted for this step block area
    // (avoid duplicate insertions for the same checkout)
    const alreadyMarked = insertions.some(ins =>
      Math.abs(ins.before - nextStepLine) < 3
    );
    if (alreadyMarked) continue;

    insertions.push({ before: nextStepLine, stepIndent, propertyIndent });
  }

  if (insertions.length === 0) {
    return { modified: false, reason: 'no main repo checkout found' };
  }

  if (DRY_RUN) {
    return { modified: true, insertions: insertions.length, dryRun: true };
  }

  // Apply insertions from bottom to top (so line numbers stay valid)
  const newLines = [...lines];
  for (let k = insertions.length - 1; k >= 0; k--) {
    const ins = insertions[k];
    const newStep = [
      '',
      `${ins.stepIndent}- name: Checkout core data`,
      `${ins.propertyIndent}uses: ./.github/actions/checkout-core-data`,
      `${ins.propertyIndent}with:`,
      `${ins.propertyIndent}  token: \${{ secrets.REVIEW_TEXTS_TOKEN }}`,
    ];
    newLines.splice(ins.before, 0, ...newStep);
  }

  fs.writeFileSync(filePath, newLines.join('\n'));
  return { modified: true, insertions: insertions.length };
}

// Main
const files = fs.readdirSync(WORKFLOW_DIR)
  .filter(f => f.endsWith('.yml'))
  .sort();

let modifiedCount = 0;
let skippedCount = 0;
const results = [];

for (const file of files) {
  if (SKIP_LIST.has(file)) {
    results.push({ file, status: 'SKIP (in skip list)' });
    skippedCount++;
    continue;
  }

  const filePath = path.join(WORKFLOW_DIR, file);
  const result = processWorkflow(filePath);

  if (result.modified) {
    results.push({ file, status: `MODIFIED (${result.insertions} insertion(s))${result.dryRun ? ' [dry-run]' : ''}` });
    modifiedCount++;
  } else {
    results.push({ file, status: `SKIP (${result.reason})` });
    skippedCount++;
  }
}

console.log(`\n=== Core Data Checkout Migration${DRY_RUN ? ' [DRY RUN]' : ''} ===`);
console.log(`Modified: ${modifiedCount}`);
console.log(`Skipped: ${skippedCount}`);
console.log(`Total: ${files.length}\n`);

for (const r of results) {
  const icon = r.status.startsWith('MODIFIED') ? '>> ' : '   ';
  console.log(`${icon}${r.file}: ${r.status}`);
}
