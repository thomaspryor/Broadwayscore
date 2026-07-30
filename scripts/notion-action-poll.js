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

// Load .env from project root. Shared with opening-night-monitor-launch.js and
// any other job that runs outside a login shell (launchd/cron get no shell env).
require('./lib/load-env.js').loadEnv(path.join(__dirname, '..'));

const DRY_RUN = process.argv.includes('--dry-run');
const REPO_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(require('os').homedir(), 'Library', 'Logs');
const MEMORY_DIR = path.join(__dirname, 'agent-memory');
const { BRAIN_DATABASE_ID: DATABASE_ID } = require('./lib/notion-constants');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `notion-action-poll.js — Notion Action Queue Poller.

Usage:
  node scripts/notion-action-poll.js [options]
  node scripts/notion-action-poll.js --help, -h    print this usage and exit
`;
// Reply-loop state: per-card session IDs + comment watermarks so owner comments
// resume the SAME Claude session (conversation continuity from the Notion app).
const STATE_DIR = path.join(require('os').homedir(), '.claude-action-dispatcher');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const REPLY_WINDOW_DAYS = 7; // stop watching a card's comments this long after last activity
const MAX_ATTEMPTS = 3; // failed runs before the card is un-queued (prevents 5-min crash loops)

// Multi-stage pipelines: one Action click runs the full chain, each stage a
// FRESH headless session (so Review genuinely has independent eyes on Plan).
// "Fix" = end-to-end, zero owner involvement. "Plan+Review" = stops after the
// reviewed plan lands on the card; owner sets Action=Start when satisfied.
const PIPELINES = {
  Fix: ['Investigate', 'Plan', 'Review', 'Start'],
  'Plan+Review': ['Investigate', 'Plan', 'Review'],
};

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { cards: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // Atomic write: a kill mid-write must not truncate state.json (loadState's
  // catch would silently reset all session/watermark tracking).
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// Single-instance lock: a >5-min run (Claude sessions take up to 30 min) must
// not race a fresh launchd tick or a manual run on state.json (last-writer-wins
// would corrupt attempts/sessionId/watermarks). Stale locks (>35 min, older
// than any possible live run) are stolen.
const LOCK_FILE = path.join(STATE_DIR, 'poll.lock');

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        // Liveness first: a dead holder's lock is stale immediately, and a
        // LIVE holder's lock is never stolen — a Fix pipeline can legitimately
        // hold it for hours (4 stages × 30 min). When the PID can't be
        // checked (corrupt/old-format lock content), fall back to the lock's
        // own embedded acquiredAt rather than fs mtime — mtime is trivially
        // reset by any unrelated process touching the lock file (the
        // #476/#485 bug class). mtime is the LAST-resort fallback, used only
        // when acquiredAt itself is also unreadable/missing (old bare-PID
        // format written before this fix).
        const raw = fs.readFileSync(LOCK_FILE, 'utf8');
        let holderPid = NaN;
        let acquiredAt = NaN;
        try {
          const content = JSON.parse(raw);
          holderPid = content.pid;
          acquiredAt = Date.parse(content.acquiredAt);
        } catch {
          holderPid = parseInt(raw, 10); // old-format: bare PID string
        }
        let holderAlive = false;
        if (Number.isFinite(holderPid) && holderPid > 0) {
          try { process.kill(holderPid, 0); holderAlive = true; } catch { holderAlive = false; }
        }
        if (holderAlive) return false;
        if (!Number.isFinite(holderPid)) {
          const age = Number.isFinite(acquiredAt)
            ? Date.now() - acquiredAt
            : Date.now() - fs.statSync(LOCK_FILE).mtimeMs; // unreadable PID + no acquiredAt: mtime fallback
          if (age < 150 * 60 * 1000) return false;
        }
        fs.unlinkSync(LOCK_FILE);
        continue; // stale — retry acquisition once
      } catch { continue; } // lock vanished between open and stat — retry
    }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

// Unique per-card slug for logs/branches/temp files. Notion page IDs created
// close in time share their leading bytes (UUIDv7-style), so slice(0,8)
// collides across same-day cards — use the random tail instead.
function cardSlug(id) {
  return id.replace(/-/g, '').slice(-12);
}

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

## Phase 3: Ship Check (BEFORE pushing — the push gate enforces this)
Review your own changes as if you were a different engineer:
- Read the full diff (\`git diff origin/main\`)
- Are there any regressions, missing edge cases, or broken callers?
- Did you introduce any security issues (hardcoded secrets, injection, XSS)?
- Are there related files that need the same fix but were missed?
Fix everything you find. THEN record the review verdict — the local pre-push
gate blocks any push of >30 gated code lines without it:
\`node scripts/lib/review-gate.mjs --query=record --reviewer=ship-check --result=pass\`
Record pass ONLY if your review genuinely found no remaining issues; if you fixed
findings after recording, re-run the record command so the verdict covers the
final code.

## Phase 4: Push & Verify Deploy
- Push to main
- If push touches src/public/config: confirm deploy workflow triggered via \`gh run list --limit 3\`
- If deploy fails: fix it NOW, do not leave it broken

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
    const branch = `action-${cardSlug(card.id)}`;
    const wtPath = path.join(REPO_DIR, '.claude', 'worktrees', branch);
    // unbounded-fetch-ok: this script only ever runs via launchd on the
    // owner's Mac against a full (non-shallow) local clone — it is not
    // invoked by any GH Actions workflow (test.yml only mentions it in a
    // comment), so the shallow-checkout unbounded-fetch hazard the guard
    // warns about does not apply here.
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

// Returns true if the worktree was KEPT (unpushed commits), false if removed/none.
function teardownActionWorktree(wt) {
  if (!wt) return false;
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
      return true;
    }
    execSync(`git worktree remove --force "${wt.path}"`, { cwd: REPO_DIR, stdio: 'ignore' });
    try { execSync(`git branch -D "${wt.branch}"`, { cwd: REPO_DIR, stdio: 'ignore' }); } catch {}
    return false;
  } catch (e) {
    log(`  worktree teardown skipped: ${e.message}`);
    return false;
  }
}

// ── Run Claude CLI ───────────────────────────────────────────────────

// opts.resumeSessionId — continue a prior session (owner replied in comments).
// opts.reuseRunDir    — cwd of the original run, if it still exists (kept worktree
//                       or REPO_DIR). Session transcripts are keyed by cwd, and
//                       provisionActionWorktree() paths are deterministic per card,
//                       so a re-provisioned worktree resolves to the same transcript.
function runClaude(prompt, card, opts = {}) {
  const logFile = path.join(LOG_DIR, `action-dispatcher-${cardSlug(card.id)}.log`);
  log(`Spawning Claude for "${card.name}" (${card.action}${opts.resumeSessionId ? ', resume' : ''}). Log: ${logFile}`);

  // Isolate the automated session in its own worktree (falls back to REPO_DIR).
  let wt = null;
  let runDir;
  if (opts.reuseRunDir && fs.existsSync(opts.reuseRunDir)) {
    runDir = opts.reuseRunDir; // kept worktree (or REPO_DIR fallback) from the original run
  } else {
    wt = provisionActionWorktree(card);
    runDir = wt ? wt.path : REPO_DIR;
  }

  let keptWorktree = false;
  try {
    // Prompt via stdin (input:) with NO shell pipe: execSync's timeout kills
    // only the shell, leaving a piped `claude` grandchild alive with repo write
    // access while the finally-block force-removes its worktree. execFileSync
    // targets the claude process directly so the timeout actually stops it.
    const args = ['--print', '--output-format', 'json', '--dangerously-skip-permissions'];
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    const raw = require('child_process').execFileSync('claude', args, {
      cwd: runDir,
      input: prompt,
      timeout: 30 * 60 * 1000, // 30 min max
      killSignal: 'SIGKILL',
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: require('os').homedir(),
        PATH: process.env.PATH,
      },
    });

    // Write full output to log (append on resume so the card's history accumulates)
    if (opts.resumeSessionId) fs.appendFileSync(logFile, `\n\n===== RESUME ${new Date().toISOString()} =====\n${raw}`);
    else fs.writeFileSync(logFile, raw);

    // --output-format json → single JSON object with .result and .session_id.
    // Fall back to raw text if parsing fails (e.g. CLI change).
    let text = raw;
    let sessionId = opts.resumeSessionId || null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.result === 'string') text = parsed.result;
      if (parsed.session_id) sessionId = parsed.session_id;
    } catch { /* keep raw text */ }

    // Extract result and memory update between markers (single pass)
    const resultMatch = text.match(/===ACTION_RESULT_START===([\s\S]*?)===ACTION_RESULT_END===/);
    const memoryMatch = text.match(/===MEMORY_UPDATE_START===([\s\S]*?)===MEMORY_UPDATE_END===/);

    return {
      result: resultMatch ? resultMatch[1].trim() : text.slice(-3000),
      memoryUpdate: memoryMatch ? memoryMatch[1].trim() : null,
      sessionId,
      runDir,
      failed: false,
      get keptWorktree() { return keptWorktree; },
    };
  } catch (err) {
    const errMsg = `Claude session failed: ${err.message}`;
    log(errMsg);
    fs.appendFileSync(logFile, `\n\nERROR: ${errMsg}`);
    const stdoutTail = err.stdout ? String(err.stdout).slice(-300) : '';
    return {
      result: `[Automated session error] ${err.message.slice(0, 500)}${stdoutTail ? ` | stdout: ${stdoutTail}` : ''}`,
      memoryUpdate: null,
      sessionId: opts.resumeSessionId || null,
      runDir,
      failed: true,
      get keptWorktree() { return keptWorktree; },
    };
  } finally {
    keptWorktree = teardownActionWorktree(wt);
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

function prependOutcome(existing, action, result) {
  const date = new Date().toISOString().slice(0, 10);
  const header = `## ${date} — Automated ${action}`;
  return existing ? `${header}\n\n${result}\n\n---\n\n${existing}` : `${header}\n\n${result}`;
}

async function setCardOutcome(cardId, text) {
  await withRetry(() => notion.pages.update({
    page_id: cardId,
    properties: {
      Outcome: {
        rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }],
      },
    },
  }), 'updateOutcome');
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
          content: `Action Dispatcher completed "${card.action}" for this card.\n\n${summary}\n\n💬 Reply in these comments to ask follow-ups or request changes — I'll pick it up within ~5 minutes and answer here.`,
        },
      },
    ],
  }), 'addComment');
  log(`Added comment to "${card.name}"`);
}

// Fire-and-forget comments (start / failure) — never let a notification error
// break card processing. Returns true if delivered (reply loop rolls back its
// watermark on false so the owner's comment isn't silently lost).
async function addInfoComment(cardId, content, label) {
  try {
    await withRetry(() => notion.comments.create({
      parent: { page_id: cardId },
      rich_text: [{ type: 'text', text: { content: content.slice(0, 1900) } }],
    }), label);
    return true;
  } catch (err) {
    log(`  ${label} comment failed (non-fatal): ${err.message}`);
    return false;
  }
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

// ── Comment-reply loop ───────────────────────────────────────────────
// For every card the dispatcher has worked (state entry, ≤REPLY_WINDOW_DAYS old),
// look for NEW owner comments and resume the card's Claude session with them.
// The reply is posted back as a comment → push notification on the owner's phone.

async function listAllComments(cardId) {
  const all = [];
  let cursor;
  do {
    const resp = await withRetry(() => notion.comments.list({
      block_id: cardId,
      ...(cursor ? { start_cursor: cursor } : {}),
    }), 'listComments');
    all.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);
  return all;
}

async function pollReplies(state, botId) {
  const now = Date.now();
  for (const [cardId, entry] of Object.entries(state.cards)) {
    if (now - new Date(entry.updatedAt || 0).getTime() > REPLY_WINDOW_DAYS * 86400000) {
      delete state.cards[cardId];
      continue;
    }
    let comments;
    try {
      comments = await listAllComments(cardId);
    } catch (err) {
      log(`  Comment poll failed for "${entry.name}": ${err.message}`);
      continue;
    }

    const watermark = new Date(entry.lastCommentCheck || 0);
    const fresh = comments.filter(c =>
      c.created_by.id !== botId && new Date(c.created_time) > watermark
    );
    if (fresh.length === 0) continue;

    const followUp = fresh
      .map(c => c.rich_text.map(t => t.plain_text).join(''))
      .join('\n\n')
      .trim();
    // Advance watermark BEFORE running so a crash can't re-process the same
    // comment every 5 minutes forever (rolled back below if the reply is
    // never delivered — otherwise the owner's question would be silently lost).
    const priorWatermark = entry.lastCommentCheck;
    entry.lastCommentCheck = new Date().toISOString();
    saveState(state);
    if (!followUp) continue;

    const pseudoCard = { id: cardId, name: entry.name, action: 'Reply' };
    const prompt = `The owner replied on the Notion card "${entry.name}" (this is a continuation of your earlier session on it):

${followUp}

Respond helpfully. If they're asking a question, answer it from your existing context (re-verify against the code/data if needed). If they're asking for additional work, DO the work now — you have full repo access — then summarize what you did. Keep the reply under 1500 characters; it will be posted as a Notion comment. Output ONLY the reply text between markers:
===ACTION_RESULT_START===
[your reply]
===ACTION_RESULT_END===`;

    let run = null;
    if (entry.sessionId) {
      log(`Owner replied on "${entry.name}" — resuming session ${entry.sessionId.slice(0, 8)}…`);
      run = runClaude(prompt, pseudoCard, {
        resumeSessionId: entry.sessionId,
        reuseRunDir: entry.runDir,
      });
    }

    // No session (JSON parse failed on the original run) or transcript
    // unreachable (pruned / original cwd gone) → fresh session seeded with the
    // card's current Notes + Outcome so the owner still gets a useful answer.
    if (!run || (run.failed && /No conversation found/i.test(run.result))) {
      log(`  ${run ? 'Resume unavailable' : 'No stored session'} for "${entry.name}" — fresh session with card context`);
      let cardContext = '';
      try {
        const page = await withRetry(() => notion.pages.retrieve({ page_id: cardId }), 'retrieveCard');
        const notes = getRichTextValue(page.properties?.Notes);
        const outcome = getRichTextValue(page.properties?.Outcome);
        cardContext = `\n\n## Card Notes\n${notes || '(none)'}\n\n## Card Outcome so far\n${outcome || '(none)'}`;
      } catch { /* answer without context if the fetch fails */ }
      run = runClaude(
        `You are answering a follow-up comment on the Notion card "${entry.name}". You do NOT have the prior session's context — rely on the card content below and re-verify against the repo as needed.${cardContext}\n\n## Owner's comment\n${followUp}\n\nRespond helpfully; if they ask for work, do it. Keep the reply under 1500 characters. Output ONLY the reply text between markers:\n===ACTION_RESULT_START===\n[your reply]\n===ACTION_RESULT_END===`,
        pseudoCard,
        {}
      );
    }

    if (run.sessionId) entry.sessionId = run.sessionId;
    entry.updatedAt = new Date().toISOString();
    // Only touch runDir if this run provisioned its own dir (a reused kept
    // worktree is still on disk — leave its path alone).
    if (run.runDir !== entry.runDir) {
      entry.runDir = (run.keptWorktree || run.runDir === REPO_DIR) ? run.runDir : null;
    }
    saveState(state);

    const delivered = await addInfoComment(cardId, run.failed
      ? `⚠️ I hit an error picking up your reply — see ~/Library/Logs/action-dispatcher-${cardSlug(cardId)}.log. Reply again to retry.`
      : run.result, 'replyComment');
    if (!delivered) {
      // Reply never reached the owner — roll the watermark back so the next
      // poll re-processes their comment instead of dropping it. Capped: each
      // retry re-runs a full Claude session, so persistent Notion-write
      // failure must not become an uncapped 5-min loop (same class as the
      // main-loop retry cap).
      entry.deliveryFailures = (entry.deliveryFailures || 0) + 1;
      if (entry.deliveryFailures <= MAX_ATTEMPTS) {
        entry.lastCommentCheck = priorWatermark;
        log(`  Reply delivery failed for "${entry.name}" (${entry.deliveryFailures}/${MAX_ATTEMPTS}) — watermark rolled back for retry`);
      } else {
        log(`  Reply delivery failed ${entry.deliveryFailures}x for "${entry.name}" — giving up on this comment (watermark kept)`);
      }
      saveState(state);
    } else {
      entry.deliveryFailures = 0;
      saveState(state);
      log(`Replied on "${entry.name}"`);
    }
  }
  saveState(state);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  if (!process.env.NOTION_API_KEY) {
    console.error('NOTION_API_KEY not set in .env');
    process.exit(1);
  }

  if (!DRY_RUN && !acquireLock()) {
    log('Another dispatcher instance holds the lock — exiting.');
    return;
  }

  log('Polling Notion Action Queue...');
  const state = loadState();

  // Reply loop FIRST: replies are quick and a Fix pipeline can hold this
  // process for hours — the owner's follow-up comments must not wait for it.
  if (!DRY_RUN) {
    try {
      const me = await withRetry(() => notion.users.me(), 'usersMe');
      // Test-only: lets an E2E test author "owner" comments with the bot token.
      // Requires BOTH the env var and the explicit CLI flag — an env var alone
      // leaking into prod .env must not disable the self-reply guard (that
      // would make the bot answer its own comments in a 5-min loop).
      const botId = (process.env.POLL_REPLIES_BOT_ID_OVERRIDE && process.argv.includes('--test-bot-override'))
        ? process.env.POLL_REPLIES_BOT_ID_OVERRIDE
        : me.id;
      await pollReplies(state, botId);
    } catch (err) {
      log(`Reply loop error (non-fatal): ${err.message}`);
    }
  }

  const cards = await getActionableCards();

  if (cards.length > 0) {
    log(`Found ${cards.length} actionable card(s):`);
    for (const card of cards) {
      log(`  - "${card.name}" [${card.action}] (${card.priority || 'no priority'})`);
    }
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

    const entry = state.cards[card.id] || { attempts: 0 };

    // Retry cap: a persistently-failing card must not crash-loop every 5 min.
    // clearAction FIRST — if the un-queue itself fails, skip the comment so a
    // Notion outage doesn't turn this guard into a comment-spam loop.
    if (entry.attempts >= MAX_ATTEMPTS) {
      log(`"${card.name}" has failed ${entry.attempts}x — un-queuing.`);
      try {
        await clearAction(card);
        entry.attempts = 0;
        await addInfoComment(card.id,
          `⚠️ "${card.action}" failed ${MAX_ATTEMPTS} times — pausing. Log: ~/Library/Logs/action-dispatcher-${cardSlug(card.id)}.log. Set the Action again to retry.`,
          'failureComment');
      } catch (err) {
        log(`  clearAction failed (will retry next poll): ${err.message}`);
      }
      state.cards[card.id] = { ...entry, name: card.name, updatedAt: new Date().toISOString() };
      saveState(state);
      continue;
    }

    // Pipeline actions (Fix / Plan+Review) run every stage back-to-back, each
    // as a FRESH session — the Review stage has genuinely independent eyes on
    // the Plan. Single actions are a 1-stage pipeline through the same path.
    const stages = PIPELINES[card.action] || [card.action];
    const isPipeline = stages.length > 1;

    await addInfoComment(card.id,
      isPipeline
        ? `🤖 Started "${card.action}" pipeline: ${stages.join(' → ')}. Each stage runs hands-free; you'll get a comment as stages land and a full summary at the end.`
        : `🤖 Started "${card.action}" — working on it now. You'll get a comment here when it's done.`,
      'startComment');

    // Watermark from BEFORE the run: owner comments posted while the session is
    // working are picked up by the reply loop on the next poll (bot comments are
    // author-filtered, so the start/completion comments don't trigger replies).
    const startedAt = new Date().toISOString();

    // Pipeline resume: a retry after a stage failure continues from the FAILED
    // stage — never re-runs completed stages (no duplicate sessions/outcome).
    let stagesToRun = stages;
    let outcomeAccum = card.outcome;
    if (entry.pipelineAction === card.action && Array.isArray(entry.pipelineRemaining) && entry.pipelineRemaining.length) {
      const remaining = entry.pipelineRemaining.filter(s => stages.includes(s));
      // If the pipeline definition changed and nothing survives the filter,
      // fall back to the full pipeline — an empty stage list would leave
      // `run` null and crash below.
      if (remaining.length) {
        stagesToRun = remaining;
        if (typeof entry.pipelineOutcome === 'string') outcomeAccum = entry.pipelineOutcome;
        log(`  Resuming "${card.action}" pipeline at stage ${stagesToRun[0]}`);
      }
    }
    let run = null;
    let failedStage = null;
    for (let i = 0; i < stagesToRun.length; i++) {
      const stage = stagesToRun[i];
      const stageCard = { ...card, action: stage, outcome: outcomeAccum };
      run = runClaude(buildPrompt(stageCard), stageCard);
      if (run.failed) { failedStage = stage; break; }
      outcomeAccum = prependOutcome(outcomeAccum, stage, run.result);
      if (run.memoryUpdate) writeMemoryUpdate(stageCard, run.memoryUpdate);
      if (isPipeline && i < stagesToRun.length - 1) {
        // Persist per-stage progress so a mid-pipeline crash loses at most one
        // stage, and the owner can watch it move in real time.
        try { await setCardOutcome(card.id, outcomeAccum); } catch (err) { log(`  stage outcome write failed (non-fatal): ${err.message}`); }
        await addInfoComment(card.id, `✅ ${stage} done → ${stagesToRun[i + 1]}…`, 'stageComment');
      }
    }

    if (run.failed) {
      log(`Stage "${failedStage}" failed for "${card.name}".`);
      entry.attempts += 1;
      state.cards[card.id] = {
        ...entry,
        name: card.name,
        // Never let a failed attempt wipe a working session from a prior run.
        sessionId: run.sessionId || entry.sessionId || null,
        runDir: (run.keptWorktree || run.runDir === REPO_DIR) ? run.runDir : (entry.runDir || null),
        updatedAt: new Date().toISOString(),
        lastCommentCheck: entry.lastCommentCheck || startedAt,
        // Pipeline resume point: retry continues at the failed stage with the
        // completed stages' output intact (no duplicate sessions).
        pipelineAction: card.action,
        pipelineRemaining: stagesToRun.slice(stagesToRun.indexOf(failedStage)),
        pipelineOutcome: outcomeAccum,
      };
      saveState(state);
      log(`Session failed (attempt ${entry.attempts}/${MAX_ATTEMPTS}) — Action left set for retry.`);
      continue;
    }

    try {
      await setCardOutcome(card.id, outcomeAccum);
      log(`Updated Outcome for "${card.name}"`);
      await addComment(card, run.result);
      await clearAction(card);
      state.cards[card.id] = {
        name: card.name,
        action: card.action,
        sessionId: run.sessionId,
        runDir: (run.keptWorktree || run.runDir === REPO_DIR) ? run.runDir : null,
        attempts: 0,
        lastCommentCheck: startedAt,
        updatedAt: new Date().toISOString(),
      };
      saveState(state);
      if (!run.sessionId) {
        log(`  WARNING: no session_id captured for "${card.name}" — comment replies will use context-fallback for this card`);
      }
      log(`Done processing "${card.name}"`);
    } catch (err) {
      log(`ERROR updating Notion for "${card.name}": ${err.message}`);
      // Card stays queued for retry, but it MUST count toward the retry cap:
      // otherwise persistent Notion-write failures re-run a full (expensive)
      // Claude session every 5 minutes with no ceiling.
      entry.attempts += 1;
      state.cards[card.id] = {
        ...entry,
        name: card.name,
        sessionId: run.sessionId || entry.sessionId || null,
        // MUST record a kept worktree here too: the run itself SUCCEEDED, so
        // unpushed commits may exist — losing this path would let a later
        // resume's provisionActionWorktree() force-remove that work.
        runDir: (run.keptWorktree || run.runDir === REPO_DIR) ? run.runDir : (entry.runDir || null),
        updatedAt: new Date().toISOString(),
        lastCommentCheck: entry.lastCommentCheck || startedAt,
      };
      saveState(state);
    }
  }

  if (!DRY_RUN) releaseLock();
  log('\nAction Queue processing complete.');
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  // Only release if this process could have held the lock — a crashing
  // --dry-run must not delete a live instance's lock out from under it.
  if (!DRY_RUN) releaseLock();
  process.exit(1);
});
