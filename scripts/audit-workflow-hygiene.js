#!/usr/bin/env node
/**
 * Guard: five workflow hygiene rules enforced at CI time.
 *
 * (a) NOTIFY-FAILURE: any workflow that runs on schedule/push/workflow_dispatch/
 *     workflow_run/pull_request must include the `notify-failure` composite action.
 *     This ensures failures surface in the daily digest and critical workflows can
 *     send real-time alerts. Added as LAST step in the last job.
 *
 * (b) PLAYWRIGHT: no workflow may contain inline `npx playwright install`. Use the
 *     shared composite action `.github/actions/setup-playwright` instead — it caches
 *     the browser install (~15s saved per run) and keeps browser versions consistent.
 *
 * (c) PUSH-WITH-RETRY: any `git push` to origin in a workflow must use
 *     `scripts/lib/push-with-retry.sh` rather than a bare `git push`. The retry
 *     script does automatic conflict resolution and exits 1 on failure; bare pushes
 *     either silently eat failures (`|| echo "::warning::..."`) or error out without
 *     retrying (the most common cause of "push conflict" opening-night incidents).
 *
 * (d) GIT-IDENTITY: any inline `git commit -m` on the root checkout (i.e. not
 *     inside a `uses:` composite-action call) must be preceded, in the same job,
 *     by a git identity setup — either inline `git config user.name`/`user.email`,
 *     or a `uses: ./.github/actions/setup-node` step with `configure-git: 'true'`
 *     (that composite action runs `git config --local` in the root checkout when
 *     the flag is set). Composite actions like checkout-core-data/push-core-data
 *     do NOT count — they configure git only inside their own nested checkout dirs
 *     (/tmp/core-data-checkout, data/review-texts), never the root checkout where
 *     these inline commits run. Without identity, `git commit` fails with
 *     "fatal: empty ident name" (task #659, discover-regional-serp-reviews.yml).
 *
 * (e) PIPEFAIL-DEAD-ECHO: within a single `run:` block that sets `pipefail`
 *     (e.g. `set -o pipefail`), a bare `echo $?` (or `echo "$?" >`) is dead
 *     code. GHA's default shell is `bash -eo pipefail` — when a `set -o
 *     pipefail` pipeline earlier in the SAME step fails, `-e` aborts the step
 *     right there, so a bare `echo $?` on a later line never runs and the
 *     exit-code file it was meant to write is never created (task #663
 *     discover-historical-shows.yml, task #667 update-show-status.yml — both
 *     shipped independently, caught only by manual review). The fix is to
 *     guard the pipeline with `|| EC=$?` (making the assignment, not the
 *     pipeline, the statement `-e` sees) and echo the captured variable
 *     instead of `$?` directly. A bare `echo $?` immediately after `||` on
 *     the SAME line (`cmd || echo $?`) is fine — that's reachable, since the
 *     `||` already protects the statement from `-e`.
 *
 * Exemption annotations (add inside the workflow YAML — anywhere in the file):
 *   # hygiene-notify-ok: <reason>          — skip notify-failure check for this workflow
 *   # hygiene-playwright-ok: <reason>      — skip playwright check for this workflow
 *   # hygiene-push-ok: <reason>            — skip push-with-retry check for this workflow
 *   # hygiene-git-identity-ok: <reason>    — skip git-identity check for this workflow
 *   # hygiene-echo-exitcode-ok: <reason>   — skip pipefail-dead-echo check for this workflow
 *
 * No external deps. Parsed with plain regex, consistent with
 * audit-workflow-concurrency.js and audit-cron-health-coverage.js.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

// Triggers that make a workflow user-visible enough to require failure notifications.
const NOTIFICATION_TRIGGERS = ['schedule:', 'push:', 'workflow_dispatch:', 'workflow_run:', 'pull_request:'];

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;

/** Return true if the workflow's top-level `on:` block contains any of the listed triggers. */
function hasNotificationTrigger(raw) {
  const lines = raw.split('\n');
  const onIdx = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l) && indentOf(l) === 0);
  if (onIdx === -1) return false;
  const onIndent = indentOf(lines[onIdx]);
  for (let i = onIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (indentOf(line) <= onIndent) break; // left the `on:` block
    for (const trigger of NOTIFICATION_TRIGGERS) {
      if (line.includes(trigger)) return true;
    }
  }
  return false;
}

/** Return lines in `run:` blocks that contain `pattern` (non-comment). */
function runLineMatches(raw, pattern) {
  const lines = raw.split('\n');
  const hits = [];
  let inRunBlock = false;
  let runIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trimStart();

    // Detect start of a `run:` block.
    // `run: |` and `run: >` are block scalars — NOT an inline command.
    // `run: echo foo` is an inline command on the same line.
    const runMatch = stripped.match(/^run\s*:\s*(.*?)\s*$/);
    if (runMatch) {
      const content = runMatch[1];
      const isBlockScalar = /^[|>][-+]?\d*$/.test(content) || content === '';

      if (isBlockScalar) {
        // Block scalar — subsequent indented lines are the command body
        inRunBlock = true;
        runIndent = indentOf(line);
        continue;
      } else {
        // Inline run: content is on the same line after the colon
        inRunBlock = false;
        if (!content.trimStart().startsWith('#') && pattern.test(content)) {
          hits.push({ lineNum: i + 1, text: line.trimEnd() });
        }
        continue;
      }
    }

    if (inRunBlock) {
      // End of block: a line at <= runIndent indent (excluding blank lines)
      if (stripped !== '' && indentOf(line) <= runIndent) {
        inRunBlock = false;
        // Still check this line — it might be a new `run:` on the next iteration
        i--;
        continue;
      }
      if (stripped.startsWith('#')) continue; // comment inside run block
      if (pattern.test(line)) {
        hits.push({ lineNum: i + 1, text: line.trimEnd() });
      }
    }
  }

  return hits;
}

/**
 * Return job-scoped violations: an inline `git commit -m` in a `run:` block
 * with no git identity configured earlier in the same job (see rule (d) above).
 */
function findMissingGitIdentityCommits(raw) {
  const lines = raw.split('\n');
  const violations = [];

  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return violations;

  // Job blocks are indent-2 keys directly under the top-level `jobs:` map.
  const jobStarts = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (indentOf(line) === 0) break;
    if (indentOf(line) === 2 && /^ {2}[A-Za-z0-9_.-]+\s*:\s*$/.test(line)) {
      jobStarts.push(i);
    }
  }
  jobStarts.push(lines.length);

  for (let j = 0; j < jobStarts.length - 1; j++) {
    const start = jobStarts[j];
    const end = jobStarts[j + 1];
    const jobName = lines[start].trim().replace(/:\s*$/, '');

    let identityConfigured = false;
    let inRunBlock = false;
    let runIndent = -1;

    for (let i = start; i < end; i++) {
      const line = lines[i];
      const stripped = line.trimStart();
      if (stripped.startsWith('#')) continue;

      // The shared setup-node composite action configures git on the ROOT
      // checkout (not a nested one) when called with configure-git: 'true'.
      if (/uses:\s*\.\/\.github\/actions\/setup-node\b/.test(line)) {
        const lookahead = lines.slice(i, i + 6).join('\n');
        if (/configure-git:\s*['"]?true['"]?/.test(lookahead)) {
          identityConfigured = true;
        }
      }

      let textToCheck = null;
      const runMatch = stripped.match(/^run\s*:\s*(.*?)\s*$/);
      if (runMatch) {
        const content = runMatch[1];
        const isBlockScalar = /^[|>][-+]?\d*$/.test(content) || content === '';
        if (isBlockScalar) {
          inRunBlock = true;
          runIndent = indentOf(line);
          continue;
        }
        inRunBlock = false;
        textToCheck = content;
      } else if (inRunBlock) {
        if (stripped !== '' && indentOf(line) <= runIndent) {
          inRunBlock = false;
        } else {
          textToCheck = line;
        }
      }

      if (textToCheck !== null) {
        if (/git config\s+(--local\s+|--global\s+)?user\.(name|email)/.test(textToCheck)) {
          identityConfigured = true;
        }
        if (/\bgit commit\s+-m\b/.test(textToCheck) && !identityConfigured) {
          violations.push({ job: jobName, lineNum: i + 1, text: line.trim() });
        }
      }
    }
  }

  return violations;
}

/**
 * Split a workflow file into its `run:` block-scalar bodies (one entry per
 * step's `run: |`/`run: >` block). Inline `run: <cmd>` steps are single
 * commands and can never contain a `set -o pipefail` + later-line `echo $?`
 * pair, so they're not tracked here.
 */
function extractRunBlocks(raw) {
  const lines = raw.split('\n');
  const blocks = [];
  let inRunBlock = false;
  let runIndent = -1;
  let current = null;

  const closeCurrent = () => {
    if (current) blocks.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trimStart();
    const runMatch = stripped.match(/^run\s*:\s*(.*?)\s*$/);

    if (runMatch) {
      const content = runMatch[1];
      const isBlockScalar = /^[|>][-+]?\d*$/.test(content) || content === '';
      closeCurrent();
      if (isBlockScalar) {
        inRunBlock = true;
        runIndent = indentOf(line);
        current = { lines: [] };
      } else {
        inRunBlock = false;
      }
      continue;
    }

    if (inRunBlock) {
      if (stripped !== '' && indentOf(line) <= runIndent) {
        inRunBlock = false;
        closeCurrent();
        i--;
        continue;
      }
      current.lines.push({ lineNum: i + 1, text: line });
    }
  }
  closeCurrent();

  return blocks;
}

/**
 * Return violations of rule (e): a `run:` block that sets `pipefail` and
 * also contains a bare `echo $?` (dead code — see header comment above).
 * Exempt: `echo $?` immediately preceded by `|| ` on the same line, since
 * that construct is reachable under `bash -e` (the `||` protects it).
 */
function findPipefailDeadExitCodeEcho(raw) {
  const violations = [];

  for (const block of extractRunBlocks(raw)) {
    const hasPipefail = block.lines.some(
      (l) => !l.text.trimStart().startsWith('#') && /\bpipefail\b/.test(l.text),
    );
    if (!hasPipefail) continue;

    for (const l of block.lines) {
      const stripped = l.text.trimStart();
      if (stripped.startsWith('#')) continue;
      if (!/echo\s+"?\$\?"?/.test(l.text)) continue;
      if (/\|\|\s*echo\s+"?\$\?"?/.test(l.text)) continue; // guarded on the same line
      violations.push({ lineNum: l.lineNum, text: l.text.trim() });
    }
  }

  return violations;
}

function main() {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  const violations = {
    notifyFailure: [],
    playwright: [],
    pushRetry: [],
    gitIdentity: [],
    echoExitcode: [],
  };

  for (const file of files) {
    const raw = fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8');

    // ── Rule (a): notify-failure ──────────────────────────────────────────────
    if (
      !raw.includes('hygiene-notify-ok:') &&
      hasNotificationTrigger(raw) &&
      !raw.includes('notify-failure')
    ) {
      violations.notifyFailure.push(file);
    }

    // ── Rule (b): no inline npx playwright install ────────────────────────────
    if (!raw.includes('hygiene-playwright-ok:')) {
      const hits = runLineMatches(raw, /npx playwright install/);
      if (hits.length > 0) {
        violations.playwright.push({ file, hits });
      }
    }

    // ── Rule (c): git push must use push-with-retry.sh ────────────────────────
    // Flag any `run:` line with `git push` that does NOT also reference push-with-retry.
    // Exemptions: lines that are annotated with push-with-retry or use the script.
    if (!raw.includes('hygiene-push-ok:')) {
      const hits = runLineMatches(raw, /\bgit push\b/).filter(
        (h) => !h.text.includes('push-with-retry'),
      );
      if (hits.length > 0) {
        violations.pushRetry.push({ file, hits });
      }
    }

    // ── Rule (d): git commit needs a prior git identity config in the same job ─
    if (!raw.includes('hygiene-git-identity-ok:')) {
      const hits = findMissingGitIdentityCommits(raw);
      if (hits.length > 0) {
        violations.gitIdentity.push({ file, hits });
      }
    }

    // ── Rule (e): pipefail + bare `echo $?` (dead exit-code capture) ──────────
    if (!raw.includes('hygiene-echo-exitcode-ok:')) {
      const hits = findPipefailDeadExitCodeEcho(raw);
      if (hits.length > 0) {
        violations.echoExitcode.push({ file, hits });
      }
    }
  }

  const total =
    violations.notifyFailure.length +
    violations.playwright.length +
    violations.pushRetry.length +
    violations.gitIdentity.length +
    violations.echoExitcode.length;

  if (total === 0) {
    console.log(`✅ Workflow hygiene guard passed (${files.length} workflows checked).`);
    return;
  }

  console.error('❌ Workflow hygiene violations found.\n');

  if (violations.notifyFailure.length) {
    console.error('── (a) Missing notify-failure action ──────────────────────────────────');
    console.error('These workflows trigger on schedule/push/dispatch but have no notify-failure step.');
    console.error('Failures won\'t surface in the daily digest or real-time alerts.\n');
    for (const f of violations.notifyFailure) {
      console.error(`  • ${f}`);
    }
    console.error('\nFix: add as the LAST step in each affected job:');
    console.error(`      - name: Notify on failure
        if: failure()
        uses: ./.github/actions/notify-failure
        with:
          title: 'Workflow Name Failed'
          severity: 'warning'`);
    console.error("Exempt (legitimate): add  # hygiene-notify-ok: <reason>  anywhere in the file.\n");
  }

  if (violations.playwright.length) {
    console.error('── (b) Inline npx playwright install ──────────────────────────────────');
    console.error('Use the shared composite action instead (caches browsers, ~15s saved/run).\n');
    for (const { file, hits } of violations.playwright) {
      console.error(`  • ${file}`);
      for (const h of hits) console.error(`      line ${h.lineNum}: ${h.text.trim()}`);
    }
    console.error('\nFix: replace with:\n      - name: Setup Playwright\n        uses: ./.github/actions/setup-playwright');
    console.error("Exempt (legitimate): add  # hygiene-playwright-ok: <reason>  anywhere in the file.\n");
  }

  if (violations.pushRetry.length) {
    console.error('── (c) Bare git push (should use push-with-retry.sh) ─────────────────');
    console.error('Bare pushes silently eat failures or fail without retrying. Use the retry');
    console.error('script, which retries 7×, auto-resolves conflicts, and exits 1 on failure.\n');
    for (const { file, hits } of violations.pushRetry) {
      console.error(`  • ${file}`);
      for (const h of hits) console.error(`      line ${h.lineNum}: ${h.text.trim()}`);
    }
    console.error('\nFix: replace with:  bash scripts/lib/push-with-retry.sh');
    console.error('     (commits must already be done before calling)');
    console.error("Exempt (external remotes, custom loops): add  # hygiene-push-ok: <reason>  anywhere in the file.\n");
  }

  if (violations.gitIdentity.length) {
    console.error('── (d) git commit with no git identity configured in the same job ────');
    console.error('`git commit -m` fails with "fatal: empty ident name" unless something in');
    console.error('this job already set user.name/user.email on the ROOT checkout. Nested');
    console.error('checkout-core-data/push-core-data composite actions do NOT count — they');
    console.error('configure git only inside their own nested checkout dirs.\n');
    for (const { file, hits } of violations.gitIdentity) {
      console.error(`  • ${file}`);
      for (const h of hits) console.error(`      job "${h.job}" line ${h.lineNum}: ${h.text}`);
    }
    console.error('\nFix: add before the commit, in the same job — either inline:');
    console.error(`      git config user.name "github-actions[bot]"
      git config user.email "github-actions[bot]@users.noreply.github.com"`);
    console.error('     or use the shared composite action earlier in the job:');
    console.error(`      - uses: ./.github/actions/setup-node
        with:
          configure-git: 'true'`);
    console.error("Exempt (legitimate): add  # hygiene-git-identity-ok: <reason>  anywhere in the file.\n");
  }

  if (violations.echoExitcode.length) {
    console.error('── (e) pipefail + bare `echo $?` (dead exit-code capture) ────────────');
    console.error('GHA runs `bash -eo pipefail`: if the pipefail\'d pipeline earlier in this');
    console.error('step fails, `-e` aborts the step right there — a later bare `echo $?` never');
    console.error('runs, so the exit-code file is never written (task #663, #667).\n');
    for (const { file, hits } of violations.echoExitcode) {
      console.error(`  • ${file}`);
      for (const h of hits) console.error(`      line ${h.lineNum}: ${h.text}`);
    }
    console.error('\nFix: guard the pipeline with `|| EC=$?` and echo the captured variable:');
    console.error(`      EC=0
      cmd | tee /tmp/out.txt || EC=$?
      echo "$EC" > /tmp/exitcode.txt`);
    console.error("Exempt (legitimate): add  # hygiene-echo-exitcode-ok: <reason>  anywhere in the file.\n");
  }

  process.exit(1);
}

main();
