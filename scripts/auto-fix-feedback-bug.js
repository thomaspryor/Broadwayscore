#!/usr/bin/env node

/**
 * Auto-fixes data-level bugs diagnosed by the feedback pipeline.
 *
 * Reads a bug-diagnosis GitHub issue body, extracts the embedded DIAGNOSIS_JSON,
 * and for high-confidence data fixes, calls Claude to generate exact field edits,
 * applies them, and validates.
 *
 * Outputs one of: fixed | skipped | not-a-bug | validation-failed | error
 *
 * Env vars:
 *   ISSUE_BODY       - Full GitHub issue body text
 *   ANTHROPIC_API_KEY - Claude API key
 */

import { Anthropic } from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);
const { CLAUDE_SONNET } = _require('./lib/models');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

// --- Safety rails ---

const ALLOWED_FIELDS = {
  'shows.json': [
    'venue', 'synopsis', 'runtime', 'intermissions',
    'ageRecommendation', 'type', 'isRevival',
  ],
  'commercial.json': [
    'designation', 'capitalization', 'weeklyRunningCost',
    'capitalizationSource', 'notes',
  ],
  'audience-buzz.json': [
    'title',
  ],
  // awards.json: only winnerNames appends are auto-fixable (append-winner operation).
  // Tony co-winners are excluded — they require awards-confirmed-ties.json update.
  'awards.json': [
    'winnerNames',
  ],
};

const ALLOWED_FILES = Object.keys(ALLOWED_FIELDS);

// --- Helpers ---

function output(action) {
  // Write to GITHUB_OUTPUT for workflow
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `action=${action}\n`);
  }
  console.log(action);
}

function writeComment(md) {
  fs.writeFileSync(path.join(ROOT, '.github-comment.md'), md);
}

function parseDiagnosis(issueBody) {
  const match = issueBody.match(/<!-- DIAGNOSIS_JSON\n([\s\S]*?)\nDIAGNOSIS_JSON -->/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function loadJsonFile(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
}

function saveJsonFile(relPath, data) {
  fs.writeFileSync(path.join(ROOT, relPath), JSON.stringify(data, null, 2) + '\n');
}

function runValidation() {
  try {
    execSync('node scripts/validate-data.js', { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function rollbackDataFiles() {
  try {
    execSync('git checkout -- data/', { cwd: ROOT, stdio: 'pipe' });
  } catch {
    // Best effort
  }
}

// --- Main ---

async function main() {
  const issueBody = process.env.ISSUE_BODY;
  if (!issueBody) {
    console.error('ISSUE_BODY env var not set');
    writeComment('## Error\n\nNo issue body provided. Cannot process.');
    output('error');
    return;
  }

  // 1. Parse diagnosis
  const diagnosis = parseDiagnosis(issueBody);
  if (!diagnosis) {
    console.log('No DIAGNOSIS_JSON found in issue body (older issue format or edited)');
    writeComment('## Skipped\n\nThis issue does not contain machine-readable diagnosis data. It may have been created before auto-fix was enabled, or the issue body was edited. Requires manual review.');
    output('skipped');
    return;
  }

  console.log(`Diagnosis: ${diagnosis.summary}`);
  console.log(`  fixType=${diagnosis.fixType}, confidence=${diagnosis.confidence}`);
  console.log(`  showId=${diagnosis.showId}, showSlug=${diagnosis.showSlug}`);

  // 2. Gate: not-a-bug
  if (diagnosis.fixType === 'not-a-bug') {
    writeComment(`## Likely Not a Bug\n\n${diagnosis.whatsHappening}\n\n**Proposed Fix:** ${diagnosis.proposedFix}\n\nLeaving open for 7 days in case you disagree.\n\n---\n*Auto-processed by feedback pipeline*`);
    output('not-a-bug');
    return;
  }

  // 3. Gate: only auto-fix data + high confidence
  if (diagnosis.fixType !== 'data') {
    writeComment(`## Requires Manual Review\n\nThis is a \`${diagnosis.fixType}\` fix which cannot be auto-applied. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*`);
    output('skipped');
    return;
  }

  if (diagnosis.confidence !== 'high') {
    writeComment(`## Requires Manual Review\n\nDiagnosis confidence is \`${diagnosis.confidence}\` (auto-fix requires \`high\`). A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*`);
    output('skipped');
    return;
  }

  // 4. Gate: need a show ID
  if (!diagnosis.showId) {
    writeComment('## Requires Manual Review\n\nCould not resolve the show mentioned in this report. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*');
    output('skipped');
    return;
  }

  // 5. Verify show exists
  const showsData = loadJsonFile('data/shows.json');
  const shows = showsData.shows || showsData;
  const showIndex = shows.findIndex(s => s.id === diagnosis.showId);
  if (showIndex === -1) {
    writeComment(`## Requires Manual Review\n\nShow \`${diagnosis.showId}\` not found in shows.json. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*`);
    output('skipped');
    return;
  }

  const show = shows[showIndex];
  console.log(`Found show: ${show.title} (${show.id})`);

  // 6a. Awards co-winner fix: applied directly from diagnosis — no second Claude call needed.
  //     Tony ties route to manual (require awards-confirmed-ties.json update).
  if (diagnosis.targetFile === 'awards.json' && diagnosis.operation === 'append-winner') {
    const { ceremony, category, missingPerson, existingWinners } = diagnosis;

    if (!ceremony || !category || !missingPerson) {
      writeComment('## Requires Manual Review\n\nAwards diagnosis is missing ceremony, category, or missingPerson. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*');
      output('skipped');
      return;
    }

    // Tony co-winners need awards-confirmed-ties.json update — always route to manual.
    if (ceremony === 'tony') {
      writeComment('## Requires Manual Review\n\nTony Award co-winners require updating `data/awards-confirmed-ties.json` — this cannot be auto-applied. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*');
      output('skipped');
      return;
    }

    const awardsData = loadJsonFile('data/awards.json');
    const showAwards = awardsData.shows?.[show.id];
    if (!showAwards) {
      writeComment(`## Requires Manual Review\n\nShow \`${show.id}\` not found in awards.json. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*`);
      output('skipped');
      return;
    }

    const ceremonyEntry = showAwards[ceremony];
    if (!ceremonyEntry) {
      writeComment(`## Requires Manual Review\n\nCeremony \`${ceremony}\` not found for show \`${show.id}\` in awards.json. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*`);
      output('skipped');
      return;
    }

    const currentWinners = ceremonyEntry.winnerNames?.[category];
    if (!currentWinners) {
      writeComment(`## Requires Manual Review\n\nNo \`winnerNames\` entry for category "${category}" in ${ceremony} — cannot auto-create. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*`);
      output('skipped');
      return;
    }

    // oldValue parity: existingWinners from diagnosis must match current data
    if (existingWinners && JSON.stringify(currentWinners) !== JSON.stringify(existingWinners)) {
      writeComment(`## Requires Manual Review\n\nAwards data has changed since diagnosis (current winners don't match expected). A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*`);
      output('skipped');
      return;
    }

    // Near-duplicate name check: prevent committing misspelled duplicates
    const normalize = n => n.toLowerCase().replace(/[^a-z]/g, '');
    const alreadyPresent = currentWinners.some(n => normalize(n) === normalize(missingPerson));
    if (alreadyPresent) {
      const comment = currentWinners.includes(missingPerson)
        ? `## Already Fixed\n\n"${missingPerson}" is already listed as a winner in the awards data.`
        : `## Requires Manual Review\n\nA name similar to "${missingPerson}" already exists in winners (possible spelling variant). A maintainer will review.`;
      writeComment(`${comment}\n\n---\n*Auto-processed by feedback pipeline*`);
      output('not-a-bug');
      return;
    }

    // Apply: append missing co-winner
    ceremonyEntry.winnerNames[category] = [...currentWinners, missingPerson];
    if (ceremonyEntry.wins && !ceremonyEntry.wins.includes(category)) {
      ceremonyEntry.wins.push(category);
    }

    saveJsonFile('data/awards.json', awardsData);
    console.log(`Applied awards fix: added "${missingPerson}" to ${show.id}/${ceremony}/${category}`);

    // Validate — rollback awards.json only on failure
    console.log('Running validation...');
    if (!runValidation()) {
      console.error('Validation failed — rolling back awards.json');
      try {
        execSync('git checkout -- data/awards.json', { cwd: ROOT, stdio: 'pipe' });
      } catch { /* best effort */ }
      writeComment('## Validation Failed\n\nThe awards fix failed data validation and has been rolled back. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*');
      output('validation-failed');
      return;
    }

    writeComment(`## Fix Applied\n\n**Show:** ${show.title}\n**Change:** Added "${missingPerson}" as co-winner for ${ceremony} / ${category}\n\nThe fix will be live within a few minutes after deployment.\n\n---\n*Auto-fixed by feedback pipeline*`);
    output('fixed');
    console.log('Awards co-winner fix applied successfully');
    return;
  }

  // 6. Call Claude to generate exact edits
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build context: current show data from relevant files
  const currentData = { show: { ...show } };
  try {
    const commercial = loadJsonFile('data/commercial.json');
    const slug = diagnosis.showSlug || show.slug;
    if (commercial.shows?.[slug]) currentData.commercial = commercial.shows[slug];
  } catch { /* skip */ }
  try {
    const buzz = loadJsonFile('data/audience-buzz.json');
    if (buzz.shows?.[show.id]) currentData.audienceBuzz = buzz.shows[show.id];
  } catch { /* skip */ }

  const allowedFieldsList = Object.entries(ALLOWED_FIELDS)
    .map(([file, fields]) => `  ${file}: ${fields.join(', ')}`)
    .join('\n');

  const prompt = `You are fixing a data bug in Broadway Scorecard's database.

## Bug Diagnosis
**Summary:** ${diagnosis.summary}
**What's happening:** ${diagnosis.whatsHappening}
**Findings:** ${diagnosis.findings.join('; ')}
**Proposed fix:** ${diagnosis.proposedFix}

## Current Data
\`\`\`json
${JSON.stringify(currentData, null, 2)}
\`\`\`

## Show Identity
- Show ID: ${show.id}
- Show slug: ${show.slug}

## Rules
- You may ONLY edit these fields:
${allowedFieldsList}
- You must specify the EXACT current value (oldValue) and the corrected value (newValue)
- If you cannot determine the correct new value with certainty, set canFix to false
- NEVER guess or fabricate data — only fix what the diagnosis clearly identifies

Respond with ONLY a JSON object:
{
  "canFix": true,
  "changes": [
    {
      "file": "shows.json",
      "field": "synopsis",
      "oldValue": "exact current value",
      "newValue": "corrected value"
    }
  ],
  "explanation": "Why this change is correct"
}

If you cannot fix it, respond: { "canFix": false, "reason": "why" }`;

  let edits;
  try {
    const message = await anthropic.messages.create({
      model: CLAUDE_SONNET,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = message.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in Claude response');
    edits = JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.error('Claude API error:', err.message);
    writeComment(`## Error\n\nFailed to generate fix edits: ${err.message}\n\n---\n*Auto-processed by feedback pipeline*`);
    output('error');
    return;
  }

  if (!edits.canFix) {
    writeComment(`## Requires Manual Review\n\nAuto-fix could not determine the correct edit: ${edits.reason}\n\n---\n*Auto-processed by feedback pipeline*`);
    output('skipped');
    return;
  }

  if (!edits.changes || edits.changes.length === 0) {
    writeComment('## Requires Manual Review\n\nNo specific changes identified.\n\n---\n*Auto-processed by feedback pipeline*');
    output('skipped');
    return;
  }

  // 7. Validate and apply edits
  const applied = [];
  const skipped = [];

  for (const change of edits.changes) {
    // Validate file is allowed
    if (!ALLOWED_FILES.includes(change.file)) {
      skipped.push(`${change.file}: not an auto-fixable file`);
      continue;
    }

    // Validate field is allowed
    if (!ALLOWED_FIELDS[change.file].includes(change.field)) {
      skipped.push(`${change.file}:${change.field}: not an auto-fixable field`);
      continue;
    }

    try {
      if (change.file === 'shows.json') {
        // Verify oldValue matches current
        const currentVal = shows[showIndex][change.field];
        if (JSON.stringify(currentVal) !== JSON.stringify(change.oldValue)) {
          skipped.push(`${change.field}: current value doesn't match expected (data may have changed since diagnosis)`);
          continue;
        }
        shows[showIndex][change.field] = change.newValue;
        applied.push(`shows.json: ${change.field} = "${String(change.newValue).substring(0, 80)}..."`);

      } else if (change.file === 'commercial.json') {
        const commercial = loadJsonFile('data/commercial.json');
        const slug = diagnosis.showSlug || show.slug;
        if (!commercial.shows?.[slug]) {
          skipped.push(`commercial.json: no entry for slug "${slug}"`);
          continue;
        }
        const currentVal = commercial.shows[slug][change.field];
        if (JSON.stringify(currentVal) !== JSON.stringify(change.oldValue)) {
          skipped.push(`commercial.json:${change.field}: current value doesn't match expected`);
          continue;
        }
        commercial.shows[slug][change.field] = change.newValue;
        saveJsonFile('data/commercial.json', commercial);
        applied.push(`commercial.json: ${change.field} updated`);

      } else if (change.file === 'audience-buzz.json') {
        const buzz = loadJsonFile('data/audience-buzz.json');
        if (!buzz.shows?.[show.id]) {
          skipped.push(`audience-buzz.json: no entry for show ID "${show.id}"`);
          continue;
        }
        const currentVal = buzz.shows[show.id][change.field];
        if (JSON.stringify(currentVal) !== JSON.stringify(change.oldValue)) {
          skipped.push(`audience-buzz.json:${change.field}: current value doesn't match expected`);
          continue;
        }
        buzz.shows[show.id][change.field] = change.newValue;
        saveJsonFile('data/audience-buzz.json', buzz);
        applied.push(`audience-buzz.json: ${change.field} updated`);
      }
    } catch (err) {
      skipped.push(`${change.file}:${change.field}: error applying — ${err.message}`);
    }
  }

  if (applied.length === 0) {
    const reasons = skipped.length > 0 ? `\n\nSkipped edits:\n${skipped.map(s => `- ${s}`).join('\n')}` : '';
    writeComment(`## Requires Manual Review\n\nNo edits could be applied.${reasons}\n\n---\n*Auto-processed by feedback pipeline*`);
    output('skipped');
    return;
  }

  // Save shows.json if we modified it
  if (applied.some(a => a.startsWith('shows.json'))) {
    saveJsonFile('data/shows.json', Array.isArray(showsData) ? shows : { ...showsData, shows });
  }

  // 8. Validate
  console.log('Running validation...');
  if (!runValidation()) {
    console.error('Validation failed — rolling back');
    rollbackDataFiles();
    writeComment('## Validation Failed\n\nThe auto-fix was applied but failed data validation. Changes have been rolled back. A maintainer will review.\n\n---\n*Auto-processed by feedback pipeline*');
    output('validation-failed');
    return;
  }

  // 9. Success
  const appliedList = applied.map(a => `- ${a}`).join('\n');
  const skippedList = skipped.length > 0 ? `\n\n**Skipped:**\n${skipped.map(s => `- ${s}`).join('\n')}` : '';

  writeComment(`## Fix Applied\n\n**Show:** ${show.title}\n**Explanation:** ${edits.explanation}\n\n**Changes:**\n${appliedList}${skippedList}\n\nThe fix will be live within a few minutes after deployment.\n\n---\n*Auto-fixed by feedback pipeline*`);
  output('fixed');
  console.log(`Successfully applied ${applied.length} edit(s)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  writeComment(`## Error\n\nUnexpected error: ${err.message}\n\n---\n*Auto-processed by feedback pipeline*`);
  output('error');
});
