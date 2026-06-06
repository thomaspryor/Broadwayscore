#!/usr/bin/env node
/**
 * Guard: three workflow hygiene rules enforced at CI time.
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
 * Exemption annotations (add inside the workflow YAML — anywhere in the file):
 *   # hygiene-notify-ok: <reason>    — skip notify-failure check for this workflow
 *   # hygiene-playwright-ok: <reason>— skip playwright check for this workflow
 *   # hygiene-push-ok: <reason>      — skip push-with-retry check for this workflow
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

function main() {
  const files = fs
    .readdirSync(WORKFLOW_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort();

  const violations = { notifyFailure: [], playwright: [], pushRetry: [] };

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
  }

  const total = violations.notifyFailure.length + violations.playwright.length + violations.pushRetry.length;

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

  process.exit(1);
}

main();
