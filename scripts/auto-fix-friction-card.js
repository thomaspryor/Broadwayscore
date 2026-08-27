#!/usr/bin/env node

/**
 * auto-fix-friction-card.js — Reads P0/P1 Notion friction cards, applies safe
 * single-file UI fixes as draft GitHub PRs.
 *
 * Safety model: code-level file allowlist, NOT LLM classification. Claude generates
 * the patch (old_string → new_string); we validate it fits within allowed paths and
 * that tsc + lint pass. Draft PRs only — human always reviews before merge.
 *
 * Outputs one of: fixed | skipped | error (per card, to stdout and GITHUB_STEP_SUMMARY)
 *
 * Env vars:
 *   NOTION_API_KEY      - Notion integration token
 *   ANTHROPIC_API_KEY   - Claude API key
 *   GITHUB_TOKEN        - For gh pr create (must have pull-requests: write)
 *
 * Usage:
 *   node scripts/auto-fix-friction-card.js                  # live run (up to 3 cards)
 *   node scripts/auto-fix-friction-card.js --dry-run         # print proposed patches, no git/PR/Notion writes
 *   node scripts/auto-fix-friction-card.js --card-id=<id>    # scope to one card (still real writes unless --dry-run)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Client: NotionClient } = require('@notionhq/client');
const Anthropic = require('@anthropic-ai/sdk');
const { CLAUDE_SONNET } = require('./lib/models');
const { updatePage } = require('./lib/notion-writes');

// Load .env
require('./lib/load-env').loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_VALIDATION = process.argv.includes('--skip-validation');
// A malformed --card-id (e.g. '--card-id=' with an empty value) must NOT
// silently fall through to the full pending-cards sweep — that's the exact
// bug class caught in notion-action-poll.js's --card flag (task #725):
// CARD_ID_ARG_RAW tracks flag presence separately from the parsed value so
// main() can fail closed instead of scoping wider than the operator intended.
const CARD_ID_ARG_RAW = process.argv.find(a => a.startsWith('--card-id='));
const CARD_ID_ARG = CARD_ID_ARG_RAW ? CARD_ID_ARG_RAW.slice('--card-id='.length) || null : null;
const CARDS_PER_RUN_CAP = 3;
const { BRAIN_DATABASE_ID: NOTION_DATABASE_ID } = require('./lib/notion-constants');
const ROOT = path.join(__dirname, '..');

// --- Safety rails (code-level, not LLM) ---
// Only src/components/ is auto-fixable. Everything else requires human review.
// This is intentionally narrow — widen only with explicit confirmation.
const ALLOWED_FILE_PREFIXES = [
  'src/components/',
];

const BLOCKED_FILES = [
  'src/lib/engine.ts',
  'src/lib/scoring.ts',
  'src/lib/data-core.ts',
];

function isAllowedFile(filePath) {
  if (!filePath) return false;
  const normalized = filePath.replace(/^\//, '');
  if (BLOCKED_FILES.includes(normalized)) return false;
  return ALLOWED_FILE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

// --- Notion helpers ---

async function getPendingFrictionCards(notion) {
  const cards = [];
  let cursor;
  do {
    const res = await notion.dataSources.query({
      data_source_id: NOTION_DATABASE_ID,
      start_cursor: cursor,
      page_size: 50,
      filter: {
        and: [
          { property: 'Tags', multi_select: { contains: 'friction' } },
          { property: 'Status', status: { equals: 'Not started' } },
          {
            or: [
              { property: 'Priority', select: { equals: 'P0 Now' } },
              { property: 'Priority', select: { equals: 'P1 Next' } },
            ],
          },
        ],
      },
    });
    cards.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  // Only cards with fhash: tags (analyzer-generated) and without auto-fix-attempted
  return cards.filter(card => {
    const tags = (card.properties?.Tags?.multi_select || []).map(t => t.name);
    return tags.some(t => t.startsWith('fhash:')) && !tags.includes('auto-fix-attempted');
  });
}

function getCardFhash(card) {
  const tags = card.properties?.Tags?.multi_select || [];
  const fhashTag = tags.find(t => t.name.startsWith('fhash:'));
  return fhashTag ? fhashTag.name.slice(6) : null;
}

function getCardTitle(card) {
  return card.properties?.Name?.title?.[0]?.plain_text || '(untitled)';
}

function getCardNotes(card) {
  return card.properties?.Notes?.rich_text?.map(t => t.plain_text).join('') || '';
}

function getCardPriority(card) {
  return card.properties?.Priority?.select?.name || 'P2 Later';
}

async function tagCardAttempted(notion, cardId, extraTag) {
  // Read current tags first to avoid clobbering existing ones
  const page = await notion.pages.retrieve({ page_id: cardId });
  const currentTags = (page.properties?.Tags?.multi_select || []).map(t => ({ name: t.name }));
  const newTags = [...currentTags];
  if (!newTags.find(t => t.name === 'auto-fix-attempted')) {
    newTags.push({ name: 'auto-fix-attempted' });
  }
  if (extraTag && !newTags.find(t => t.name === extraTag)) {
    newTags.push({ name: extraTag });
  }
  await updatePage(notion, {
    page_id: cardId,
    properties: { Tags: { multi_select: newTags } },
  });
}

async function addPrUrlToCard(notion, cardId, prUrl) {
  const page = await notion.pages.retrieve({ page_id: cardId });
  const existing = page.properties?.Notes?.rich_text?.map(t => t.plain_text).join('') || '';
  const updated = existing + `\n\n## Auto-fix PR\n${prUrl}`;
  await updatePage(notion, {
    page_id: cardId,
    properties: {
      Notes: { rich_text: [{ text: { content: updated.slice(0, 1800) } }] },
    },
  });
}

// --- Patch generation via Claude ---

const PATCH_SCHEMA = {
  type: 'object',
  required: ['canFix', 'reason'],
  properties: {
    canFix: { type: 'boolean' },
    reason: { type: 'string' },
    target_file: { type: 'string', description: 'Relative path from repo root, e.g. src/components/TicketLink.tsx' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['old_string', 'new_string', 'explanation'],
        properties: {
          old_string: { type: 'string', description: 'Exact string to find in the file — must appear exactly once' },
          new_string: { type: 'string', description: 'Replacement string' },
          explanation: { type: 'string' },
        },
      },
    },
  },
};

async function generatePatch(anthropic, cardTitle, cardNotes, fileContents) {
  const fileSection = fileContents
    ? `\n\nFILE CONTENTS (${fileContents.path}):\n\`\`\`\n${fileContents.content}\n\`\`\``
    : '';

  const prompt = `You are an automated code patcher for Broadway Scorecard (Next.js 14 + TypeScript).

A product friction card has been flagged for auto-fix. Your job is to determine if this is safe to patch automatically and, if so, generate the exact string replacement.

FRICTION CARD: ${cardTitle}

CARD NOTES:
${cardNotes}
${fileSection}

RULES:
- Only fix if it is a SINGLE file change in src/components/
- Only fix guard additions, null-checks, missing prop additions, or label/copy changes
- The old_string MUST appear EXACTLY ONCE in the file — if it could match multiple places, use more surrounding context to make it unique
- If you cannot produce a safe, unique, minimal patch with high confidence, set canFix: false
- Do NOT touch scoring, data pipeline, or multi-file logic
- TypeScript must remain valid after the change

Return ONLY the tool call.`;

  const response = await anthropic.messages.create({
    model: CLAUDE_SONNET,
    max_tokens: 2000,
    temperature: 0,
    tools: [{
      name: 'propose_patch',
      description: 'Propose a code patch for the friction card',
      input_schema: PATCH_SCHEMA,
    }],
    tool_choice: { type: 'tool', name: 'propose_patch' },
    messages: [{ role: 'user', content: prompt }],
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not call propose_patch tool');
  return toolUse.input;
}

// --- Patch application ---

function applyPatch(filePath, oldString, newString) {
  const content = fs.readFileSync(filePath, 'utf8');
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) throw new Error(`old_string not found in ${filePath}`);
  if (occurrences > 1) throw new Error(`old_string appears ${occurrences} times in ${filePath} — not unique`);
  const patched = content.replace(oldString, newString);
  fs.writeFileSync(filePath, patched, 'utf8');
}

function revertFile(filePath) {
  try {
    // Restore both index (staging) and working tree from HEAD
    execSync(`git checkout HEAD -- "${filePath}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch {
    // best effort
  }
}

function runValidation() {
  try {
    execSync('npx tsc --noEmit', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
    execSync('npx next lint --max-warnings 0', { cwd: ROOT, stdio: 'pipe', timeout: 60000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.stderr?.toString() || e.message };
  }
}

// --- Git / PR helpers ---

function branchExists(branchName) {
  try {
    execSync(`git ls-remote --exit-code --heads origin ${branchName}`, { cwd: ROOT, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function createAndPushBranch(branchName, filePath, commitMsg) {
  execSync(`git checkout -b ${branchName}`, { cwd: ROOT, stdio: 'pipe' });
  execSync(`git add "${filePath}"`, { cwd: ROOT, stdio: 'pipe' });
  execSync(`git commit -m "${commitMsg}"`, { cwd: ROOT, stdio: 'pipe' });
  execSync(`git push origin ${branchName}`, { cwd: ROOT, stdio: 'pipe' });
}

function createDraftPr(title, body) {
  const result = execSync(
    `gh pr create --draft --title "${title}" --body "${body.replace(/"/g, '\\"')}"`,
    { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }
  );
  return result.trim();
}

function returnToMain() {
  try {
    execSync('git checkout main', { cwd: ROOT, stdio: 'pipe' });
  } catch {
    execSync('git checkout -', { cwd: ROOT, stdio: 'pipe' });
  }
}

// --- Main ---

async function main() {
  const missing = ['NOTION_API_KEY', 'ANTHROPIC_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!DRY_RUN && !process.env.GITHUB_TOKEN) {
    console.error('Missing GITHUB_TOKEN — required for PR creation');
    process.exit(1);
  }
  if (CARD_ID_ARG_RAW && !CARD_ID_ARG) {
    console.error('--card-id requires a value, e.g. --card-id=3af637c5-416f-8199-810c-e68f50c33b8d');
    process.exit(1);
  }

  if (DRY_RUN) console.log('[dry-run] No git/PR/Notion writes will happen.\n');

  const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
  const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  let cards;
  if (CARD_ID_ARG) {
    console.log(`Fetching specific card: ${CARD_ID_ARG}`);
    const page = await notion.pages.retrieve({ page_id: CARD_ID_ARG });
    cards = [page];
    console.log(`Card: ${getCardTitle(page)}`);
  } else {
    console.log('Fetching pending friction cards from Notion...');
    cards = await getPendingFrictionCards(notion);
    console.log(`Found ${cards.length} eligible card(s) (cap: ${CARDS_PER_RUN_CAP})`);
  }

  const toProcess = cards.slice(0, CARDS_PER_RUN_CAP);
  const results = [];

  for (const card of toProcess) {
    const fhash = getCardFhash(card) || require('crypto').createHash('sha256').update(card.id).digest('hex').slice(0, 8);
    const title = getCardTitle(card);
    const notes = getCardNotes(card);
    const priority = getCardPriority(card);
    const cardUrl = card.url;

    console.log(`\n--- Processing: ${title} (${priority}, fhash:${fhash}) ---`);

    // Step 1: First pass — ask Claude with notes only (no file yet) to identify target file
    let patch;
    try {
      patch = await generatePatch(anthropic, title, notes, null);
    } catch (e) {
      console.error(`  Claude error: ${e.message}`);
      results.push({ title, fhash, outcome: 'error', reason: e.message });
      if (!DRY_RUN) await tagCardAttempted(notion, card.id, 'auto-fix-failed');
      continue;
    }

    if (!patch.canFix) {
      console.log(`  Skipped: ${patch.reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason: patch.reason });
      if (!DRY_RUN) await tagCardAttempted(notion, card.id, 'auto-fix-skipped');
      continue;
    }

    // Step 2: Safety check on target file (code-level, not LLM)
    const targetFile = patch.target_file;
    if (!targetFile || !isAllowedFile(targetFile)) {
      const reason = `target_file "${targetFile}" is outside allowed paths (src/components/)`;
      console.log(`  Blocked: ${reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason });
      if (!DRY_RUN) await tagCardAttempted(notion, card.id, 'auto-fix-skipped');
      continue;
    }

    const absolutePath = path.join(ROOT, targetFile);
    if (!fs.existsSync(absolutePath)) {
      const reason = `target_file "${targetFile}" does not exist`;
      console.log(`  Skipped: ${reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason });
      if (!DRY_RUN) await tagCardAttempted(notion, card.id, 'auto-fix-skipped');
      continue;
    }

    // Step 3: Re-ask Claude with actual file contents for precise patch
    const fileContent = fs.readFileSync(absolutePath, 'utf8');
    try {
      patch = await generatePatch(anthropic, title, notes, { path: targetFile, content: fileContent });
    } catch (e) {
      console.error(`  Claude error (file pass): ${e.message}`);
      results.push({ title, fhash, outcome: 'error', reason: e.message });
      if (!DRY_RUN) await tagCardAttempted(notion, card.id, 'auto-fix-failed');
      continue;
    }

    if (!patch.canFix || !patch.changes?.length) {
      const reason = patch.reason || 'no changes generated';
      console.log(`  Skipped after file read: ${reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason });
      if (!DRY_RUN) await tagCardAttempted(notion, card.id, 'auto-fix-skipped');
      continue;
    }

    // Second safety check — re-verify target_file hasn't shifted
    if (!isAllowedFile(patch.target_file)) {
      const reason = `target_file "${patch.target_file}" blocked after file-read pass`;
      console.log(`  Blocked: ${reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason });
      if (!DRY_RUN) await tagCardAttempted(notion, card.id, 'auto-fix-skipped');
      continue;
    }

    console.log(`  Target: ${patch.target_file}`);
    for (const change of patch.changes) {
      console.log(`  Change: ${change.explanation}`);
      console.log(`    old: ${change.old_string.slice(0, 80).replace(/\n/g, '↵')}...`);
      console.log(`    new: ${change.new_string.slice(0, 80).replace(/\n/g, '↵')}...`);
    }

    if (DRY_RUN) {
      results.push({ title, fhash, outcome: 'dry-run', targetFile: patch.target_file });
      continue;
    }

    // Step 4: Check for existing PR branch (idempotency)
    const branchName = `auto-fix/${fhash}`;
    if (branchExists(branchName)) {
      console.log(`  Branch ${branchName} already exists — skipping (PR may already be open)`);
      results.push({ title, fhash, outcome: 'skipped', reason: 'branch already exists' });
      if (!DRY_RUN) await tagCardAttempted(notion, card.id, 'auto-fix-attempted');
      continue;
    }

    // Step 5: Apply patches
    const patchedFile = path.join(ROOT, patch.target_file);
    let applyError = null;
    for (const change of patch.changes) {
      try {
        applyPatch(patchedFile, change.old_string, change.new_string);
      } catch (e) {
        applyError = e.message;
        break;
      }
    }

    if (applyError) {
      revertFile(patch.target_file);
      console.log(`  Apply failed: ${applyError}`);
      results.push({ title, fhash, outcome: 'error', reason: applyError });
      await tagCardAttempted(notion, card.id, 'auto-fix-failed');
      continue;
    }

    // Step 6: Validate (tsc + lint)
    if (SKIP_VALIDATION) {
      console.log('  [--skip-validation] Skipping tsc + lint');
    } else {
      console.log('  Running tsc + lint...');
      const validation = runValidation();
      if (!validation.ok) {
        revertFile(patch.target_file);
        const reason = `tsc/lint failed: ${(validation.error || '').slice(0, 200)}`;
        console.log(`  Validation failed — reverted`);
        results.push({ title, fhash, outcome: 'validation-failed', reason });
        await tagCardAttempted(notion, card.id, 'auto-fix-failed');
        continue;
      }
      console.log('  Validation passed');
    }

    // Step 7: Create branch, commit, push, open draft PR
    // SKIP-VISUAL-CHECK: auto-fix creates draft PRs that require human review before merge.
    // Visual verification happens at PR review time, not at automated commit time.
    const commitMsg = `SKIP-VISUAL-CHECK: auto-fix draft PR — fix(auto-fix/${fhash}): ${title.slice(0, 60)}`;
    const prBody = `Closes Notion card: ${cardUrl}\n\n${patch.changes.map(c => c.explanation).join('\n\n')}\n\n> Auto-generated by posthog-friction-fixer`;

    try {
      createAndPushBranch(branchName, patch.target_file, commitMsg);
      const prUrl = createDraftPr(`auto-fix: ${title.slice(0, 60)}`, prBody);
      console.log(`  PR created: ${prUrl}`);

      // Step 8: Update Notion card — only after PR is successfully created
      await addPrUrlToCard(notion, card.id, prUrl);
      await tagCardAttempted(notion, card.id, 'auto-fix-pr-open');
      results.push({ title, fhash, outcome: 'fixed', prUrl });
    } catch (e) {
      revertFile(patch.target_file);
      console.error(`  PR creation failed: ${e.message}`);
      results.push({ title, fhash, outcome: 'error', reason: e.message });
      await tagCardAttempted(notion, card.id, 'auto-fix-failed');
    } finally {
      returnToMain();
    }
  }

  // Summary
  console.log('\n=== Summary ===');
  for (const r of results) {
    const icon = r.outcome === 'fixed' ? '✓' : r.outcome === 'dry-run' ? '○' : '✗';
    console.log(`${icon} [${r.outcome}] ${r.title}`);
    if (r.prUrl) console.log(`  ${r.prUrl}`);
    if (r.reason) console.log(`  reason: ${r.reason}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['## Auto-fix Friction Cards', ''];
    const fixed = results.filter(r => r.outcome === 'fixed');
    const skipped = results.filter(r => r.outcome !== 'fixed');
    if (fixed.length) {
      lines.push(`### Fixed ${fixed.length} card(s)`);
      for (const r of fixed) lines.push(`- [${r.title}](${r.prUrl})`);
      lines.push('');
    }
    if (skipped.length) {
      lines.push(`### Skipped/failed ${skipped.length} card(s)`);
      for (const r of skipped) lines.push(`- **${r.outcome}**: ${r.title}${r.reason ? ` — ${r.reason}` : ''}`);
    }
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
