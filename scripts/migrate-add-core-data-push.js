#!/usr/bin/env node
/**
 * Migration script: Add push-core-data step to workflows that write core data files.
 *
 * For each workflow that `git add`s core data files, finds the commit/push step
 * and inserts a push-core-data step immediately after it.
 *
 * Usage: node scripts/migrate-add-core-data-push.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

// Core data files that will move to private repo
const CORE_FILES = [
  'shows.json', 'reviews.json', 'grosses.json', 'grosses-history.json',
  'commercial.json', 'audience-buzz.json', 'critic-consensus.json',
  'critic-registry.json', 'outlet-registry.json'
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a YAML file into step blocks, identifying which contain git push
 * and git add of core data files.
 */
function findPushSteps(lines) {
  const pushSteps = [];

  for (let i = 0; i < lines.length; i++) {
    // We're looking for `git push` inside run blocks
    if (!lines[i].includes('git push')) continue;

    // Skip comments
    if (lines[i].trim().startsWith('#')) continue;

    // Find the step that contains this line
    // Walk backward to find the step start (`- name:` or `- uses:`)
    let stepStart = -1;
    let stepIndent = '';

    for (let j = i; j >= 0; j--) {
      const match = lines[j].match(/^(\s+)- (name|uses|if|env|id|with|run|shell|working-directory):/);
      if (match) {
        // Check if this is actually a step start (has `- `)
        const stepMatch = lines[j].match(/^(\s+)- /);
        if (stepMatch) {
          stepStart = j;
          stepIndent = stepMatch[1];
          break;
        }
      }
    }

    if (stepStart === -1) continue;

    // Find the step end
    const stepRegex = new RegExp(`^${escapeRegex(stepIndent)}- `);
    let stepEnd = lines.length;

    for (let j = stepStart + 1; j < lines.length; j++) {
      const trimmed = lines[j].trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;

      if (stepRegex.test(lines[j])) {
        stepEnd = j;
        break;
      }

      // Check if indent dropped below step property level
      const jMatch = lines[j].match(/^(\s*)/);
      const jIndentLen = jMatch ? jMatch[1].length : 0;
      if (jIndentLen <= stepIndent.length && trimmed !== '') {
        stepEnd = j;
        break;
      }
    }

    // Check if this step's block references core data files
    const stepText = lines.slice(stepStart, stepEnd).join('\n');

    // Check for git add of core data files, or git add -A, or git add .
    const addsCoreData = CORE_FILES.some(f => stepText.includes(`data/${f}`)) ||
                         stepText.includes('git add -A') ||
                         /git add \.\s*$/m.test(stepText);

    if (!addsCoreData) continue;

    // Avoid duplicates (same step found from different git push lines)
    if (pushSteps.some(ps => ps.stepStart === stepStart)) continue;

    pushSteps.push({
      stepStart,
      stepEnd,
      stepIndent,
      propertyIndent: stepIndent + '  ',
    });
  }

  return pushSteps;
}

function processWorkflow(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Skip if already has push-core-data
  if (content.includes('push-core-data')) {
    return { modified: false, reason: 'already has push-core-data' };
  }

  // Skip if no git push
  if (!content.includes('git push')) {
    return { modified: false, reason: 'no git push' };
  }

  const lines = content.split('\n');
  const pushSteps = findPushSteps(lines);

  if (pushSteps.length === 0) {
    return { modified: false, reason: 'no push step with core data' };
  }

  if (DRY_RUN) {
    return { modified: true, insertions: pushSteps.length, dryRun: true };
  }

  // Insert push-core-data after each push step (bottom to top)
  const newLines = [...lines];
  for (let k = pushSteps.length - 1; k >= 0; k--) {
    const ps = pushSteps[k];
    const newStep = [
      '',
      `${ps.stepIndent}- name: Push core data to private repo`,
      `${ps.propertyIndent}if: always()`,
      `${ps.propertyIndent}uses: ./.github/actions/push-core-data`,
      `${ps.propertyIndent}with:`,
      `${ps.propertyIndent}  token: \${{ secrets.REVIEW_TEXTS_TOKEN }}`,
      `${ps.propertyIndent}  message: 'data: Update from ${path.basename(filePath, '.yml')}'`,
    ];
    newLines.splice(ps.stepEnd, 0, ...newStep);
  }

  fs.writeFileSync(filePath, newLines.join('\n'));
  return { modified: true, insertions: pushSteps.length };
}

// Find workflows that reference core data in git add commands
function findTargetWorkflows() {
  const targets = new Set();
  const files = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.yml'));

  for (const file of files) {
    const content = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');
    // Check for git add of core data files
    const addsCoreData = CORE_FILES.some(f => content.includes(`git add`) && content.includes(`data/${f}`)) ||
                         (content.includes('git add -A') && content.includes('git push')) ||
                         (content.includes('git add .') && content.includes('git push'));

    if (addsCoreData && content.includes('git push')) {
      targets.add(file);
    }
  }

  return targets;
}

// Main
const targetFiles = findTargetWorkflows();
const allFiles = fs.readdirSync(WORKFLOW_DIR).filter(f => f.endsWith('.yml')).sort();

let modifiedCount = 0;
let skippedCount = 0;
const results = [];

for (const file of allFiles) {
  if (!targetFiles.has(file)) {
    // Not a target — skip silently
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

console.log(`\n=== Core Data Push Migration${DRY_RUN ? ' [DRY RUN]' : ''} ===`);
console.log(`Target workflows: ${targetFiles.size}`);
console.log(`Modified: ${modifiedCount}`);
console.log(`Skipped: ${skippedCount}\n`);

for (const r of results) {
  const icon = r.status.startsWith('MODIFIED') ? '>> ' : '   ';
  console.log(`${icon}${r.file}: ${r.status}`);
}
