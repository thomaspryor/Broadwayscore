#!/usr/bin/env node
/**
 * Notion Action Queue Poller
 *
 * Polls the BWSC Roadmap database for cards with an Action set
 * (Investigate / Plan / Start). For each card found, spawns a
 * Claude CLI session with the card context as a prompt.
 *
 * After Claude finishes:
 *   1. Appends findings to the card's Outcome field
 *   2. Adds a Notion comment (triggers push notification)
 *   3. Clears the Action property LAST (prevents orphaned cards)
 *
 * Usage:
 *   node scripts/notion-action-poll.js [--dry-run]
 *
 * Env: NOTION_API_KEY (Internal Integration token with access to BWSC workspace)
 */

const { Client } = require('@notionhq/client');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env from project root (manual parse to avoid dotenv dependency)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const val = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

const DRY_RUN = process.argv.includes('--dry-run');
const REPO_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(require('os').homedir(), 'Library', 'Logs');
const MEMORY_DIR = path.join(__dirname, 'agent-memory');
const DATABASE_ID = 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6';

// Tag → agent memory file mapping
const TAG_MEMORY_MAP = {
  scraping: 'agent-scraper.md',
  scoring: 'agent-scoring.md',
  'opening-night': 'agent-opening-night.md',
  infra: 'agent-infra.md',
  'data-quality': 'agent-scraper.md', // data quality often involves scraping
  email: 'agent-infra.md',
};

// Keywords for auto-inferring tags when none are set
const TAG_KEYWORDS = {
  scraping: ['scrape', 'scraper', 'crawl', 'fetch', 'gather', 'aggregator', 'brightdata', 'scrapingbee', 'playwright', 'bww', 'dtli'],
  scoring: ['score', 'scoring', 'tier', 'composite', 'blended', 'llm-score', 'review text', 'ensemble'],
  'opening-night': ['opening night', 'opening-night', 'poller', 'orchestrator', 'premiere'],
  infra: ['workflow', 'ci', 'deploy', 'vercel', 'launchd', 'cron', 'github action', 'plist', 'health check'],
  commercial: ['recoup', 'gross', 'commercial', 'box office', 'ticket'],
  email: ['email', 'broadcast', 'resend', 'buttondown', 'newsletter', 'subscriber'],
  'west-end': ['west end', 'london', 'olivier', 'wet', 'the stage'],
};

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function getRichTextValue(prop) {
  if (!prop || prop.type !== 'rich_text') return '';
  return prop.rich_text.map(t => t.plain_text).join('');
}

function getTitleValue(prop) {
  if (!prop || prop.type !== 'title') return '';
  return prop.title.map(t => t.plain_text).join('');
}

function getSelectValue(prop) {
  if (!prop || prop.type !== 'select' || !prop.select) return null;
  return prop.select.name;
}

function getMultiSelectValues(prop) {
  if (!prop || prop.type !== 'multi_select') return [];
  return prop.multi_select.map(s => s.name);
}

// ── Agent Memory ─────────────────────────────────────────────────────

function inferTags(card) {
  const text = `${card.name} ${card.notes}`.toLowerCase();
  const inferred = [];
  for (const [tag, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      inferred.push(tag);
    }
  }
  return inferred;
}

function getEffectiveTags(card) {
  if (card.tags.length > 0) return card.tags.map(t => t.toLowerCase());
  const inferred = inferTags(card);
  if (inferred.length > 0) {
    log(`  No tags on card — inferred: [${inferred.join(', ')}]`);
  }
  return inferred;
}

function getAgentMemory(card) {
  const tags = getEffectiveTags(card);
  const seen = new Set();
  const sections = [];

  for (const tag of tags) {
    const file = TAG_MEMORY_MAP[tag];
    if (!file || seen.has(file)) continue;
    seen.add(file);

    const filePath = path.join(MEMORY_DIR, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      sections.push(`### ${file.replace('agent-', '').replace('.md', '')} knowledge\n${content}`);
    } catch {
      log(`  Warning: no memory file for tag "${tag}" (expected ${filePath})`);
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : '';
}

function writeMemoryUpdate(card, memoryText) {
  if (!memoryText) return;

  const tags = getEffectiveTags(card);
  // Write to the first matched memory file
  const targetFile = tags.map(t => TAG_MEMORY_MAP[t]).find(f => f);
  if (!targetFile) {
    log(`  No memory file target for tags [${tags.join(', ')}] — skipping memory update`);
    return;
  }

  const filePath = path.join(MEMORY_DIR, targetFile);
  const date = new Date().toISOString().slice(0, 10);
  const entry = `\n### ${date} — ${card.name}\n${memoryText.trim()}\n`;

  try {
    let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '---AUTO-APPENDED---\n';

    // Find the auto-appended separator
    const separator = '---AUTO-APPENDED---';
    const sepIndex = content.indexOf(separator);
    if (sepIndex === -1) {
      // No separator — append at end with separator
      content += `\n${separator}${entry}`;
    } else {
      // Insert after separator
      const before = content.slice(0, sepIndex + separator.length);
      const after = content.slice(sepIndex + separator.length);
      content = before + entry + after;
    }

    // Enforce 200-line cap on auto-appended section only
    const lines = content.split('\n');
    const sepLineIndex = lines.findIndex(l => l.trim() === separator);
    if (sepLineIndex !== -1 && lines.length > 200) {
      // Keep everything up to separator + first 200-sepLineIndex lines after
      const maxAutoLines = 200 - sepLineIndex - 1;
      if (maxAutoLines > 0) {
        const kept = [...lines.slice(0, sepLineIndex + 1), ...lines.slice(sepLineIndex + 1, sepLineIndex + 1 + maxAutoLines)];
        content = kept.join('\n');
      }
    }

    fs.writeFileSync(filePath, content);
    log(`  Updated memory: ${targetFile} (+${entry.split('\n').length} lines)`);
  } catch (err) {
    log(`  Warning: failed to write memory update to ${targetFile}: ${err.message}`);
  }
}

// ── Query for actionable cards ───────────────────────────────────────

async function getActionableCards() {
  // v5 SDK: query moved from databases to dataSources
  const response = await notion.dataSources.query({
    data_source_id: DATABASE_ID,
    filter: {
      property: 'Action',
      select: { is_not_empty: true },
    },
  });

  return response.results.map(page => ({
    id: page.id,
    url: page.url,
    name: getTitleValue(page.properties.Name),
    action: getSelectValue(page.properties.Action),
    status: page.properties.Status?.status?.name || 'Unknown',
    priority: getSelectValue(page.properties.Priority),
    category: getSelectValue(page.properties.Category),
    tags: getMultiSelectValues(page.properties.Tags),
    notes: getRichTextValue(page.properties.Notes),
    outcome: getRichTextValue(page.properties.Outcome),
  }));
}

// ── Build Claude prompt for a card ───────────────────────────────────

function buildPrompt(card) {
  const actionInstructions = {
    Investigate: `INVESTIGATE this card. Search the codebase, git history, related files, and existing patterns. Write your findings as a structured summary. Do NOT make any code changes.`,
    Plan: `PLAN the implementation for this card. First investigate (codebase, git history, patterns), then write a detailed implementation plan with specific files, functions, and steps. Do NOT make any code changes.`,
    Review: `REVIEW the implementation plan in "Existing Outcome" above. You are a senior engineer doing a pre-implementation review. Do NOT make any code changes.

Your job is to find problems that will waste time or break things — not to nitpick style.

For each file mentioned in the plan:
1. Read the current state of the file
2. Check if the planned changes are compatible with the existing code
3. Look for hidden dependencies the plan doesn't mention

Find these problems:
1. **Will it compile?** Check that every new reference (variable, function, import, constant) actually exists or is being created.
2. **Is anything missing?** Are there callers of modified functions that need updating? Use grep to find all call sites.
3. **Will it break existing behavior?** Check for changes to function signatures, renamed/removed exports, changed return types.
4. **Is the fix systematic?** Does the plan fix just one instance of a problem, or the root cause?
5. **Edge cases in real data:** Check actual data files for edge cases the plan doesn't handle — null values, missing fields, empty arrays.

Output format:
**BLOCKERS** (must fix before implementing):
- [specific issue with file:line reference]

**WARNINGS** (should fix, easy to miss):
- [specific issue with file:line reference]

**SUGGESTIONS** (nice to have):
- [specific improvement]

**VERDICT:** "Ready to Start" / "Fix N blockers first" / "Rethink approach"`,
    Start: `IMPLEMENT this card. First investigate and plan, then actually build it. Use a worktree for any src/ changes. Push code and trigger deploys as needed. This is a full implementation session.

IMPORTANT — If the Existing Outcome contains a Review with BLOCKERS, address every blocker before implementing. Do not ignore review findings.

Follow this sequence strictly. Do NOT skip steps.

## Phase 1: Implement
- Read the Plan and Review in Existing Outcome
- Address all Review blockers
- Make the code changes
- Commit frequently (never >2 uncommitted files)

## Phase 2: Does It Work? (MANDATORY before push)
Run ALL of these and check output — "looks correct" is not verification:
1. \`npx tsc --noEmit\` — zero TypeScript errors
2. \`npx next lint\` — no new warnings
3. For changed scripts: run each with smallest scope (--limit 1, --dry-run, or a representative test) and confirm non-zero, semantically correct results
4. For changed src/ files: verify the build succeeds
5. \`node scripts/validate-data.js 2>&1 | tail -10\` — exit code 0
6. Check: did you break anything adjacent? grep for callers of functions you changed. Run related tests.

If ANY check fails, fix before pushing.

## Phase 3: Push & Verify Deploy
- Push to main
- If push touches src/public/config: confirm deploy workflow triggered via \`gh run list --limit 3\`
- If deploy fails: fix it NOW, do not leave it broken

## Phase 4: Ship Check
After pushing, review your own changes as if you were a different engineer:
- Read the full diff (\`git diff HEAD~1\`)
- Are there any regressions, missing edge cases, or broken callers?
- Did you introduce any security issues (hardcoded secrets, injection, XSS)?
- Are there related files that need the same fix but were missed?

## Phase 5: What Else? (Adjacent discoveries)
Before wrapping up, apply these lenses to what you just built:
- **Pattern reuse:** Did you create something that solves a problem elsewhere too? Did you fix a bug that has cousins in other files?
- **Edges:** What was harder than expected? What does that imply about adjacent work? Where did you hit architecture limits?
- **Data quality:** Did you discover data issues, gaps, or inconsistencies while working?
- **Compounding:** What's the obvious next step someone would ask about?

## Phase 6: Wrap Up & Create Cards
This is MANDATORY — do not skip.
1. For EVERY issue, TODO, edge case, adjacent improvement, or "what-else" discovery: create a new Notion card in the BWSC Roadmap (data source: collection://fa7b3ff2-c073-4097-b54c-0a78e56e06b6) with Name, Status="Not started", appropriate Priority and Tags, and a one-line Notes description. Do NOT just mention discoveries in the Outcome — they MUST become cards.
2. Write your implementation summary (what changed, why, gotchas, cards created) — this goes in the ACTION_RESULT markers below.
3. If the card's work is fully complete, note "CARD STATUS: Done" in your result. If partially done or blocked, note "CARD STATUS: Paused" with the reason.`,
  };

  const instruction = actionInstructions[card.action] || actionInstructions.Investigate;

  const agentMemory = getAgentMemory(card);
  const memorySection = agentMemory
    ? `\n## Domain Knowledge\nThe following operational knowledge has been accumulated from prior sessions. Follow these rules.\n\n${agentMemory}\n`
    : '';

  return `You are an automated Claude session triggered by the Notion Action Queue.

## Card Details
- **Name:** ${card.name}
- **Action:** ${card.action}
- **Status:** ${card.status}
- **Priority:** ${card.priority || 'None'}
- **Category:** ${card.category || 'None'}
- **Tags:** ${card.tags.join(', ') || 'None'}
- **Notion URL:** ${card.url}

## Notes
${card.notes || '(none)'}

## Existing Outcome
${card.outcome || '(none)'}
${memorySection}
## Instructions
${instruction}

When done, output your findings in this exact format between markers:

===ACTION_RESULT_START===
[Your structured findings/plan/implementation summary here]
===ACTION_RESULT_END===

If you learned something durable that would help future automated sessions on this subsystem (gotchas, patterns that worked, things that broke), also output it between these markers. Only include reusable operational lessons, not session-specific details:

===MEMORY_UPDATE_START===
[Durable lessons learned, if any]
===MEMORY_UPDATE_END===

Be thorough but concise. Focus on actionable information.`;
}

// ── Per-action worktree isolation ────────────────────────────────────
// The automated session runs with --dangerously-skip-permissions in cwd. Running
// it in the SHARED main checkout means its code edits get silently reverted by the
// worktree-first git hooks / parallel CI, and its pushes come from a possibly-dirty
// tree. Isolate each action in its own git worktree off origin/main (shares the
// object store — cheap). Gitignored deps the session needs are symlinked in —
// worktree-LOCAL and NEVER committed, so the stray-committed-symlink CI landmine
// (feedback_stray_symlink_crashes_pipeline) does not apply; node_modules resolves
// via the parent main repo automatically. EVERY step is best-effort: on ANY failure
// we fall back to REPO_DIR (prior behavior), so this can never break the dispatcher.
function provisionActionWorktree(card) {
  try {
    const branch = `action-${card.id.slice(0, 8)}`;
    const wtPath = path.join(REPO_DIR, '.claude', 'worktrees', branch);
    execSync('git fetch origin main --quiet', { cwd: REPO_DIR, timeout: 60000, stdio: 'ignore' });
    // Idempotent: clear any stale worktree/branch left by a previous run of this card.
    try { execSync(`git worktree remove --force "${wtPath}"`, { cwd: REPO_DIR, stdio: 'ignore' }); } catch {}
    try { execSync(`git branch -D "${branch}"`, { cwd: REPO_DIR, stdio: 'ignore' }); } catch {}
    execSync(`git worktree add --force -b "${branch}" "${wtPath}" origin/main`, { cwd: REPO_DIR, timeout: 60000, stdio: 'ignore' });
    for (const dep of ['.env', 'data/review-texts', 'data/shows.json', 'data/reviews.json']) {
      const src = path.join(REPO_DIR, dep), dst = path.join(wtPath, dep);
      try {
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.symlinkSync(src, dst);
        }
      } catch { /* dep optional */ }
    }
    log(`  isolated session in worktree ${wtPath} (branch ${branch})`);
    return { path: wtPath, branch };
  } catch (e) {
    log(`  worktree isolation unavailable (${e.message}); running in main`);
    return null;
  }
}

function teardownActionWorktree(wt) {
  if (!wt) return;
  try {
    // Preserve the session's work if it committed but did NOT push/merge to main —
    // never delete a branch with unpushed commits.
    let unpushed = '0';
    try {
      unpushed = execSync(`git -C "${wt.path}" rev-list --count origin/main..HEAD`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { /* if we can't tell, err on the side of keeping it */ unpushed = '?'; }
    if (unpushed !== '0') {
      log(`  KEEPING worktree ${wt.path} — ${unpushed} unpushed commit(s); session work not on main, review manually`);
      return;
    }
    execSync(`git worktree remove --force "${wt.path}"`, { cwd: REPO_DIR, stdio: 'ignore' });
    try { execSync(`git branch -D "${wt.branch}"`, { cwd: REPO_DIR, stdio: 'ignore' }); } catch {}
  } catch (e) {
    log(`  worktree teardown skipped: ${e.message}`);
  }
}

// ── Run Claude CLI ───────────────────────────────────────────────────

function runClaude(prompt, card) {
  const logFile = path.join(LOG_DIR, `action-dispatcher-${card.id.slice(0, 8)}.log`);
  log(`Spawning Claude for "${card.name}" (${card.action}). Log: ${logFile}`);

  // Write prompt to temp file to avoid shell escaping issues
  const tmpPrompt = path.join(require('os').tmpdir(), `action-prompt-${card.id.slice(0, 8)}.txt`);

  // Isolate the automated session in its own worktree (falls back to REPO_DIR).
  const wt = provisionActionWorktree(card);
  const runDir = wt ? wt.path : REPO_DIR;

  try {
    fs.writeFileSync(tmpPrompt, prompt);

    // Pipe prompt via stdin; --print for non-interactive, --verbose for logging
    // --dangerously-skip-permissions so automated session can operate freely
    const result = execSync(
      `cat "${tmpPrompt}" | claude --print --dangerously-skip-permissions --verbose`,
      {
        cwd: runDir,
        timeout: 30 * 60 * 1000, // 30 min max
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: require('os').homedir(),
          PATH: process.env.PATH,
        },
      }
    );

    // Write full output to log
    fs.writeFileSync(logFile, result);

    // Extract result and memory update between markers (single pass)
    const resultMatch = result.match(/===ACTION_RESULT_START===([\s\S]*?)===ACTION_RESULT_END===/);
    const memoryMatch = result.match(/===MEMORY_UPDATE_START===([\s\S]*?)===MEMORY_UPDATE_END===/);

    return {
      result: resultMatch ? resultMatch[1].trim() : result.slice(-3000),
      memoryUpdate: memoryMatch ? memoryMatch[1].trim() : null,
    };
  } catch (err) {
    const errMsg = `Claude session failed: ${err.message}`;
    log(errMsg);
    fs.appendFileSync(logFile, `\n\nERROR: ${errMsg}`);
    return { result: `[Automated session error] ${err.message.slice(0, 500)}`, memoryUpdate: null };
  } finally {
    try { fs.unlinkSync(tmpPrompt); } catch {}
    teardownActionWorktree(wt);
  }
}

// ── Retry helper for Notion API (handles network timeouts) ───────────

async function withRetry(fn, label, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < retries && (err.message.includes('fetch failed') || err.message.includes('ETIMEDOUT'))) {
        log(`  Retry ${attempt + 1}/${retries} for ${label}: ${err.message}`);
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
}

// ── Update card after processing ─────────────────────────────────────

async function updateCardOutcome(card, result) {
  const date = new Date().toISOString().slice(0, 10);
  const header = `## ${date} — Automated ${card.action}`;
  const newOutcome = card.outcome
    ? `${header}\n\n${result}\n\n---\n\n${card.outcome}`
    : `${header}\n\n${result}`;

  // 1. Update Outcome (prepend new result) — with retry for network timeouts
  await withRetry(() => notion.pages.update({
    page_id: card.id,
    properties: {
      Outcome: {
        rich_text: [{ type: 'text', text: { content: newOutcome.slice(0, 2000) } }],
      },
    },
  }), 'updateOutcome');
  log(`Updated Outcome for "${card.name}"`);
}

async function addComment(card, result) {
  // 2. Add comment (triggers push notification) — with retry
  const summary = result.length > 300 ? result.slice(0, 297) + '...' : result;
  await withRetry(() => notion.comments.create({
    parent: { page_id: card.id },
    rich_text: [
      {
        type: 'text',
        text: {
          content: `Action Dispatcher completed "${card.action}" for this card.\n\n${summary}`,
        },
      },
    ],
  }), 'addComment');
  log(`Added comment to "${card.name}"`);
}

async function clearAction(card) {
  // 3. Clear Action LAST (prevents orphaned cards) — with retry
  await withRetry(() => notion.pages.update({
    page_id: card.id,
    properties: {
      Action: { select: null },
    },
  }), 'clearAction');
  log(`Cleared Action for "${card.name}"`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.NOTION_API_KEY) {
    console.error('NOTION_API_KEY not set in .env');
    process.exit(1);
  }

  log('Polling Notion Action Queue...');
  const cards = await getActionableCards();

  if (cards.length === 0) {
    log('No actionable cards. Exiting.');
    return;
  }

  log(`Found ${cards.length} actionable card(s):`);
  for (const card of cards) {
    log(`  - "${card.name}" [${card.action}] (${card.priority || 'no priority'})`);
  }

  for (const card of cards) {
    log(`\n${'='.repeat(60)}`);
    log(`Processing: "${card.name}" [${card.action}]`);
    log(`${'='.repeat(60)}`);

    if (DRY_RUN) {
      log('[DRY RUN] Would spawn Claude with prompt:');
      log(buildPrompt(card).slice(0, 500) + '...');
      continue;
    }

    const prompt = buildPrompt(card);
    const { result, memoryUpdate } = runClaude(prompt, card);

    try {
      await updateCardOutcome(card, result);
      await addComment(card, result);
      if (memoryUpdate) {
        writeMemoryUpdate(card, memoryUpdate);
      }
      await clearAction(card);
      log(`Done processing "${card.name}"`);
    } catch (err) {
      log(`ERROR updating Notion for "${card.name}": ${err.message}`);
      // Don't clear Action on error — card stays in queue for retry
    }
  }

  log('\nAction Queue processing complete.');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
