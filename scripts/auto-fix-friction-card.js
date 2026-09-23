#!/usr/bin/env node

/**
 * auto-fix-friction-card.js — Reads P0/P1 friction issues from Linear,
 * applies safe single-file UI fixes as draft GitHub PRs.
 *
 * BRO-3487: was Notion-backed (@notionhq/client against BRAIN_DATABASE_ID),
 * reading cards scripts/posthog-friction-analyzer.js used to file onto the
 * retired board. BRO-3430 already repointed the analyzer at Linear
 * (createLinearIssue), which left this script reading a board the analyzer
 * had stopped writing to — every weekly run found zero eligible cards.
 * Migrated to read/write the SAME Linear issues the analyzer now creates.
 *
 * Linear has no multi_select "Tags" property, so — matching the analyzer's
 * own fhash: convention (posthog-friction-analyzer.js) — both eligibility
 * signals live as plain text in the issue's description:
 *   - `fhash:XXXXXXXX` (written by the analyzer) marks an analyzer-generated
 *     friction issue.
 *   - `[auto-fix-attempted:<outcome>]` (appended by this script) marks an
 *     issue this pipeline has already processed, so a stalled Claude call or
 *     a re-run of the same weekly job never double-processes it.
 *
 * Safety model: code-level file allowlist, NOT LLM classification. Claude generates
 * the patch (old_string → new_string); we validate it fits within allowed paths and
 * that tsc + lint pass. Draft PRs only — human always reviews before merge.
 *
 * Outputs one of: fixed | skipped | error (per card, to stdout and GITHUB_STEP_SUMMARY)
 *
 * Env vars:
 *   LINEAR_API_KEY      - Linear API token (see scripts/lib/linear-client.js)
 *   ANTHROPIC_API_KEY   - Claude API key
 *   GITHUB_TOKEN        - For gh pr create (must have pull-requests: write)
 *
 * Usage:
 *   node scripts/auto-fix-friction-card.js                  # live run (up to 3 cards)
 *   node scripts/auto-fix-friction-card.js --dry-run         # print proposed patches, no git/PR/Linear writes
 *   node scripts/auto-fix-friction-card.js --issue=BRO-123   # scope to one issue (still real writes unless --dry-run)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const { CLAUDE_SONNET } = require('./lib/models');
const linearClient = require('./lib/linear-client');
const { TERMINAL_STATE_TYPES } = require('./lib/linear-state-types.js');

// Load .env
require('./lib/load-env').loadEnv();

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_VALIDATION = process.argv.includes('--skip-validation');
// A malformed --issue (e.g. '--issue=' with an empty value) must NOT
// silently fall through to the full pending-issues sweep — that's the exact
// bug class caught in notion-action-poll.js's --card flag (task #725):
// ISSUE_ARG_RAW tracks flag presence separately from the parsed value so
// main() can fail closed instead of scoping wider than the operator intended.
const ISSUE_ARG_RAW = process.argv.find(a => a.startsWith('--issue='));
const ISSUE_ARG = ISSUE_ARG_RAW ? ISSUE_ARG_RAW.slice('--issue='.length) || null : null;
const CARDS_PER_RUN_CAP = 3;
const FHASH_RE = /fhash:([0-9a-f]{8})/;
const ATTEMPTED_RE = /\[auto-fix-attempted:/i;
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

// --- Linear helpers ---

// Fetches every open (non-terminal) issue's id/description/priority in one
// paginated pass — cheap enough to filter client-side rather than lean on
// Linear's filter DSL for `fhash:`/priority substring matching (same
// client-side-filter convention as linear-client.js's own searchIssues()).
// Not added to scripts/lib/linear-dispatch.js's shared query builders
// (CLAUDE.md rule 18: dispatch-layer changes need a review pass first) —
// this query is scoped to this one pipeline, same as linear-brain.js's own
// inline --probe query.
async function getOpenIssuesForFrictionScan() {
  const team = await linearClient.getTeam();
  const issues = [];
  let after = null;
  for (;;) {
    const data = await linearClient.graphql(
      `query($teamId: String!, $after: String) {
        team(id: $teamId) {
          issues(
            first: 100
            after: $after
            filter: { state: { type: { nin: ${JSON.stringify(TERMINAL_STATE_TYPES)} } } }
          ) {
            nodes { id identifier title description url priority }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { teamId: team.id, after }
    );
    const { nodes, pageInfo } = data.team.issues;
    issues.push(...nodes);
    if (!pageInfo || !pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }
  return issues;
}

// Linear's raw priority ints: 0 = No priority, 1 = Urgent, 2 = High. Mirrors
// the analyzer's own PRIORITY_MAP: 'P0 Now' -> 1, 'P1 Next' -> 2 — the two
// tiers the old Notion filter (`P0 Now`/`P1 Next`) admitted.
const ELIGIBLE_PRIORITIES = [1, 2];
// createMissingShowIssue (posthog-friction-analyzer.js) also stamps
// `fhash:`/'friction' and files at P1 — but its notes are explicitly
// "Next step (manual — do NOT auto-add)" (CLAUDE.md Rule 3: a human must
// validate venue/date before any shows.json entry). Excluded here by its own
// `missing-show` marker rather than trusting Claude's canFix:false to always
// catch it (ship-check finding).
const MISSING_SHOW_RE = /\bmissing-show\b/i;

// `[auto-fix-attempted:...]` used to live on the issue DESCRIPTION (see git
// history), but that overwrote the description with a stale in-memory
// snapshot fetched before the Claude calls + tsc/lint + git operations below
// — tens of seconds to minutes during which a human edit or a second run's
// marker would get silently clobbered by this script's own read-modify-write
// (ship-check finding). Comments are append-only, so eligibility now needs a
// per-candidate getIssue() (which fetches comments) rather than trusting the
// bulk scan above — cheap, since the priority+fhash+missing-show filter has
// already narrowed the candidate set to a handful.
async function getPendingFrictionIssues() {
  const all = await getOpenIssuesForFrictionScan();
  const candidates = all.filter((issue) => (
    ELIGIBLE_PRIORITIES.includes(Number(issue.priority)) &&
    FHASH_RE.test(issue.description || '') &&
    !MISSING_SHOW_RE.test(issue.description || '')
  ));
  const eligible = [];
  for (const candidate of candidates) {
    const full = await linearClient.getIssue(candidate.identifier);
    if (full && !hasAttemptedComment(full)) eligible.push(full);
  }
  return eligible;
}

function hasAttemptedComment(issue) {
  const comments = (issue.comments && issue.comments.nodes) || [];
  return comments.some((c) => ATTEMPTED_RE.test(c.body || ''));
}

function getIssueFhash(issue) {
  const m = FHASH_RE.exec(issue.description || '');
  return m ? m[1] : null;
}

// Posts the outcome marker (and, for the pr-open outcome, the PR link) as a
// COMMENT rather than mutating the issue's description — see
// getPendingFrictionIssues' header for why. Matches the analyzer's own
// fhash: text-marker idiom (Linear has no card-tag property), just append-only.
async function markIssueAttempted(issue, outcome, extra) {
  const body = [`[auto-fix-attempted:${outcome}]`, extra].filter(Boolean).join('\n\n');
  await linearClient.createComment(issue.id, body);
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

const { revertFile: revertFileAt } = require('./lib/friction-revert-file.js');
function revertFile(filePath) {
  revertFileAt(filePath, ROOT);
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
  const missing = ['LINEAR_API_KEY', 'ANTHROPIC_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (!DRY_RUN && !process.env.GITHUB_TOKEN) {
    console.error('Missing GITHUB_TOKEN — required for PR creation');
    process.exit(1);
  }
  if (ISSUE_ARG_RAW && !ISSUE_ARG) {
    console.error('--issue requires a value, e.g. --issue=BRO-123');
    process.exit(1);
  }
  // The Notion-era flag was --card-id=<notion-page-uuid>. Silently ignoring
  // it here would fall through to the full pending-issues sweep instead of
  // scoping to one issue — exactly the "malformed --issue" bug class
  // ISSUE_ARG_RAW above already guards against (ship-check finding).
  if (process.argv.some(a => a.startsWith('--card-id'))) {
    console.error('--card-id was the Notion-era flag (a page UUID) and no longer applies — use --issue=BRO-123.');
    process.exit(1);
  }

  if (DRY_RUN) console.log('[dry-run] No git/PR/Linear writes will happen.\n');

  const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  let issues;
  if (ISSUE_ARG) {
    console.log(`Fetching specific issue: ${ISSUE_ARG}`);
    const issue = await linearClient.getIssue(ISSUE_ARG);
    if (!issue) {
      console.error(`FATAL: no such issue: ${ISSUE_ARG}`);
      process.exit(1);
    }
    issues = [issue];
    console.log(`Issue: ${issue.title}`);
  } else {
    console.log('Fetching pending friction issues from Linear...');
    issues = await getPendingFrictionIssues();
    console.log(`Found ${issues.length} eligible issue(s) (cap: ${CARDS_PER_RUN_CAP})`);
  }

  const toProcess = issues.slice(0, CARDS_PER_RUN_CAP);
  const results = [];

  for (const issue of toProcess) {
    const fhash = getIssueFhash(issue) || require('crypto').createHash('sha256').update(issue.id).digest('hex').slice(0, 8);
    const title = issue.title;
    const notes = issue.description || '';
    const issueUrl = issue.url;

    console.log(`\n--- Processing: ${title} (${issue.identifier}, fhash:${fhash}) ---`);

    // Step 1: First pass — ask Claude with notes only (no file yet) to identify target file
    let patch;
    try {
      patch = await generatePatch(anthropic, title, notes, null);
    } catch (e) {
      console.error(`  Claude error: ${e.message}`);
      results.push({ title, fhash, outcome: 'error', reason: e.message });
      if (!DRY_RUN) await markIssueAttempted(issue, 'failed', e.message.slice(0, 300));
      continue;
    }

    if (!patch.canFix) {
      console.log(`  Skipped: ${patch.reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason: patch.reason });
      if (!DRY_RUN) await markIssueAttempted(issue, 'skipped', patch.reason);
      continue;
    }

    // Step 2: Safety check on target file (code-level, not LLM)
    const targetFile = patch.target_file;
    if (!targetFile || !isAllowedFile(targetFile)) {
      const reason = `target_file "${targetFile}" is outside allowed paths (src/components/)`;
      console.log(`  Blocked: ${reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason });
      if (!DRY_RUN) await markIssueAttempted(issue, 'skipped', reason);
      continue;
    }

    const absolutePath = path.join(ROOT, targetFile);
    if (!fs.existsSync(absolutePath)) {
      const reason = `target_file "${targetFile}" does not exist`;
      console.log(`  Skipped: ${reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason });
      if (!DRY_RUN) await markIssueAttempted(issue, 'skipped', reason);
      continue;
    }

    // Step 3: Re-ask Claude with actual file contents for precise patch
    const fileContent = fs.readFileSync(absolutePath, 'utf8');
    try {
      patch = await generatePatch(anthropic, title, notes, { path: targetFile, content: fileContent });
    } catch (e) {
      console.error(`  Claude error (file pass): ${e.message}`);
      results.push({ title, fhash, outcome: 'error', reason: e.message });
      if (!DRY_RUN) await markIssueAttempted(issue, 'failed', e.message.slice(0, 300));
      continue;
    }

    if (!patch.canFix || !patch.changes?.length) {
      const reason = patch.reason || 'no changes generated';
      console.log(`  Skipped after file read: ${reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason });
      if (!DRY_RUN) await markIssueAttempted(issue, 'skipped', reason);
      continue;
    }

    // Second safety check — re-verify target_file hasn't shifted
    if (!isAllowedFile(patch.target_file)) {
      const reason = `target_file "${patch.target_file}" blocked after file-read pass`;
      console.log(`  Blocked: ${reason}`);
      results.push({ title, fhash, outcome: 'skipped', reason });
      if (!DRY_RUN) await markIssueAttempted(issue, 'skipped', reason);
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
      await markIssueAttempted(issue, 'attempted', 'branch already exists');
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
      await markIssueAttempted(issue, 'failed', applyError.slice(0, 300));
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
        await markIssueAttempted(issue, 'failed', reason);
        continue;
      }
      console.log('  Validation passed');
    }

    // Step 7: Create branch, commit, push, open draft PR
    // SKIP-VISUAL-CHECK: auto-fix creates draft PRs that require human review before merge.
    // Visual verification happens at PR review time, not at automated commit time.
    const commitMsg = `SKIP-VISUAL-CHECK: auto-fix draft PR — fix(auto-fix/${fhash}): ${title.slice(0, 60)}`;
    const prBody = `Closes Linear issue: ${issueUrl}\n\n${patch.changes.map(c => c.explanation).join('\n\n')}\n\n> Auto-generated by posthog-friction-fixer`;

    try {
      createAndPushBranch(branchName, patch.target_file, commitMsg);
      const prUrl = createDraftPr(`auto-fix: ${title.slice(0, 60)}`, prBody);
      console.log(`  PR created: ${prUrl}`);

      // Step 8: Update Linear issue — only after PR is successfully created
      await markIssueAttempted(issue, 'pr-open', `## Auto-fix PR\n${prUrl}`);
      results.push({ title, fhash, outcome: 'fixed', prUrl });
    } catch (e) {
      revertFile(patch.target_file);
      console.error(`  PR creation failed: ${e.message}`);
      results.push({ title, fhash, outcome: 'error', reason: e.message });
      await markIssueAttempted(issue, 'failed', e.message.slice(0, 300));
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
