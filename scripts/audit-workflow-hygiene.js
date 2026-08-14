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
 *     instead of `$?` directly. A bare `echo $?` on the same line as an
 *     earlier `||` (`cmd || echo $?`, `cmd || { echo $?; }`, `cmd ||
 *     (echo $?)`) is fine — that's reachable, since the `||` already
 *     protects the statement from `-e`.
 *     Scope note: this only fires when the block sets `pipefail` explicitly
 *     (matching both real incidents). GHA's shell already runs `-eo
 *     pipefail` by default even without an explicit `set` line, so a bare
 *     `echo $?` after an unguarded pipe can be dead code there too — but
 *     firing on every implicit-default case would flag most `echo $?` in
 *     the ~215 workflows here. Left as a known gap rather than a rule that
 *     drowns real hits in noise.
 *
 * (f) NEVER-RUN COVERAGE (advisory, task #737): a workflow registered on
 *     GitHub Actions with a LIFETIME run count of zero means its checkout /
 *     secrets / npm / script path has never once been exercised — the same
 *     class as #657 and #688. Detector is the pure `findNeverRunWorkflows`
 *     in scripts/lib/workflow-run-coverage.js (unit-tested in
 *     tests/unit/workflow-run-coverage.test.mjs); this file owns the GitHub
 *     API call and never fails the gate on what it finds — it's a warning
 *     row, printed here and written to data/audit/workflow-run-coverage.json
 *     for health-check.js's daily digest to surface next to the repeat-
 *     failure rows. Requires GH_TOKEN/GITHUB_TOKEN — silently skipped
 *     without one (e.g. this job's default CI environment). Also skipped on
 *     ordinary push-triggered runs to keep the blocking lint-workflows job
 *     fast; it runs for real on the daily schedule tick or any manual/local
 *     invocation (`node scripts/audit-workflow-hygiene.js`).
 *
 * (g) CORE-DATA-PUSH (task #1442): a `git add` of a specific `data/<file>`
 *     path — where `<file>` is one of push-core-data's CORE_FILES (read live
 *     from `.github/actions/push-core-data/action.yml`, never hardcoded here)
 *     — with no `uses: ./.github/actions/push-core-data` step in the SAME
 *     job. push-core-data's snapshot-diff logic is anchored to
 *     /tmp/core-data-snapshot, written by checkout-core-data at the start of
 *     that job — a private-repo push from a DIFFERENT job can't see the
 *     write, so this must be job-scoped like rule (d). This is the exact bug
 *     class fixed in task #1441 (update-tony-awards.yml git-added
 *     awards.json to the public repo but never pushed it to the private
 *     data repo, so the scrape silently never persisted). Scope note: only
 *     explicit `git add data/<file>` is checked, not broad `git add -A`/`.`
 *     — ingest-urls.yml's `git add -A` inside a `cd data/review-texts`
 *     subdirectory would be a false positive under a broader match, and the
 *     narrower signal is the one that actually recurred historically.
 *     Known gap (mirrors rule (e)'s scope note above): a `git add \` with the
 *     CORE_FILES path on a shell line-continuation is not detected — the
 *     matcher requires `git add` and `data/<file>` on the same physical
 *     line. No live workflow hits this today (checked at introduction,
 *     task #1442), but the idiom exists elsewhere in this repo
 *     (opening-night-checklist.yml, weekly-video-reviews.yml), so a future
 *     core-data write using it would slip past this gate silently.
 *
 * (h) DEAD-COMMIT-STEP (task #1461, generalizes #1460's manual sweep): a job
 *     that inline `git commit`s on the root checkout and also pushes (bare
 *     `git push` or `push-with-retry.sh`), but has ZERO `git add` anywhere in
 *     the job — including via one of the shared helper scripts that perform
 *     the add internally (`stage-data-changes.sh`, `git-add-existing.sh`,
 *     `safe-sync-review-texts.sh`, `sync-audit-checkout.sh`). Unlike rule
 *     (f)'s advisory posture, this one is unambiguous regardless of what the
 *     commit was meant to capture: a commit step with nothing ever staged is
 *     permanent dead code — `git commit` exits non-zero on a clean tree, so
 *     either the step silently no-ops (if guarded with `|| true`/`continue-
 *     on-error`) or fails every single run. Same job-scoped parsing as rules
 *     (d)/(g) — a `git add` in a DIFFERENT job doesn't stage anything for
 *     this job's checkout. Found by hand twice (task #1460's audit gap fix,
 *     then a 6-workflow cousin sweep) before being generalized here.
 *
 * Exemption annotations (add inside the workflow YAML — anywhere in the file):
 *   # hygiene-notify-ok: <reason>          — skip notify-failure check for this workflow
 *   # hygiene-playwright-ok: <reason>      — skip playwright check for this workflow
 *   # hygiene-push-ok: <reason>            — skip push-with-retry check for this workflow
 *   # hygiene-git-identity-ok: <reason>    — skip git-identity check for this workflow
 *   # hygiene-echo-exitcode-ok: <reason>   — skip pipefail-dead-echo check for this workflow
 *   # hygiene-core-data-push-ok: <reason>  — skip core-data-push check for this workflow
 *   # hygiene-dead-commit-ok: <reason>     — skip dead-commit-step check for this workflow
 *
 * No external deps. Parsed with plain regex, consistent with
 * audit-workflow-concurrency.js and audit-cron-health-coverage.js.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { findNeverRunWorkflows } = require('./lib/workflow-run-coverage');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');
const REPO = 'thomaspryor/Broadwayscore';
const NEVER_RUN_MIN_AGE_DAYS = 30;
const NEVER_RUN_SNAPSHOT_PATH = path.join(__dirname, '..', 'data', 'audit', 'workflow-run-coverage.json');
const NEVER_RUN_CONCURRENCY = 8;

// Triggers that make a workflow user-visible enough to require failure notifications.
const NOTIFICATION_TRIGGERS = ['schedule:', 'push:', 'workflow_dispatch:', 'workflow_run:', 'pull_request:'];

const indentOf = (line) => line.length - line.replace(/^ +/, '').length;

// Matches a `run:` step line, accepting both the common indented `run: |`/
// `run: <cmd>` style and the inline `- run: <cmd>` list-item shorthand (used
// elsewhere in this repo, e.g. .github/workflows/overnight-collect.yml:48).
// Shared by every rule below that scans `run:` content — a fix to this
// anchor previously had to be applied in 5 separate near-identical copies
// (task #1461 fixed only rule (h)'s copy; #1474 unifies the rest).
const RUN_LINE_RE = /^(?:-\s+)?run\s*:\s*(.*?)\s*$/;

/**
 * Find job block boundaries under a top-level `jobs:` map (indent-2 keys
 * directly under `jobs:`). Returns start-line indices with `lines.length`
 * appended as the final boundary; callers iterate [jobStarts[j], jobStarts[j+1])
 * as each job's line range.
 */
function findJobBoundaries(lines, jobsIdx) {
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
  return jobStarts;
}

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
    const runMatch = stripped.match(RUN_LINE_RE);
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

  const jobStarts = findJobBoundaries(lines, jobsIdx);

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
      const runMatch = stripped.match(RUN_LINE_RE);
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
 * Read push-core-data's live CORE_FILES list straight from its action.yml
 * (the single `CORE_FILES="..."` assignment in the "Sync core data files to
 * checkout" step) so this gate never carries its own second copy to drift
 * out of sync — that drift is exactly what made
 * scripts/migrate-add-core-data-push.js's hardcoded 9-file list stale (task
 * #1442).
 */
function getCoreFilesFromPushAction() {
  const actionPath = path.join(__dirname, '..', '.github', 'actions', 'push-core-data', 'action.yml');
  const raw = fs.readFileSync(actionPath, 'utf8');
  const match = raw.match(/CORE_FILES="([^"]+)"/);
  if (!match) {
    throw new Error(`Could not find CORE_FILES="..." in ${actionPath}`);
  }
  return match[1].split(/\s+/).filter(Boolean);
}

/**
 * Return job-scoped violations of rule (g): an explicit `git add data/<file>`
 * for one of `coreFiles`, with no `uses: ./.github/actions/push-core-data`
 * step anywhere in the same job (see header comment above for why job scope
 * matters — push-core-data's snapshot diff only sees writes from its own
 * job's checkout-core-data snapshot).
 */
function findCoreFileWritesWithoutPush(raw, coreFiles) {
  const violations = [];
  const escaped = coreFiles.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const coreFileRe = new RegExp(`\\bdata/(${escaped.join('|')})\\b`);

  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return violations;

  const jobStarts = findJobBoundaries(lines, jobsIdx);

  for (let j = 0; j < jobStarts.length - 1; j++) {
    const start = jobStarts[j];
    const end = jobStarts[j + 1];
    const jobName = lines[start].trim().replace(/:\s*$/, '');

    let hasPushCoreData = false;
    const writes = [];
    let inRunBlock = false;
    let runIndent = -1;

    for (let i = start; i < end; i++) {
      const line = lines[i];
      const stripped = line.trimStart();
      if (stripped.startsWith('#')) continue;

      if (/uses:\s*\.\/\.github\/actions\/push-core-data\b/.test(line)) {
        hasPushCoreData = true;
      }

      let textToCheck = null;
      const runMatch = stripped.match(RUN_LINE_RE);
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

      if (textToCheck !== null && !textToCheck.trimStart().startsWith('#')) {
        const match = textToCheck.match(coreFileRe);
        if (match && /\bgit\s+add\b/.test(textToCheck)) {
          writes.push({ lineNum: i + 1, text: line.trim(), coreFile: match[1] });
        }
      }
    }

    if (writes.length > 0 && !hasPushCoreData) {
      for (const w of writes) {
        violations.push({ job: jobName, lineNum: w.lineNum, text: w.text, coreFile: w.coreFile });
      }
    }
  }

  return violations;
}

// Shared helper scripts that perform `git add` internally — a job that
// invokes one of these has staged files even though the literal text
// "git add" never appears in the job's own YAML lines (see rule (h)).
// Matched against the full `scripts/lib/<name>` path (not the bare filename)
// inside actual run content only — a bare filename can appear incidentally in
// a commit message or step name ("Fixed per stage-data-changes.sh notes"),
// and matching that would silently defeat the exact dead-commit bug class
// this rule exists to catch (ship-check finding, task #1461).
const GIT_ADD_SATISFYING_SCRIPTS = [
  'stage-data-changes.sh',
  'git-add-existing.sh',
  'safe-sync-review-texts.sh',
  'sync-audit-checkout.sh',
];
const GIT_ADD_SATISFYING_SCRIPT_RE = new RegExp(
  `scripts/lib/(?:${GIT_ADD_SATISFYING_SCRIPTS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
);

/**
 * Return job-scoped violations of rule (h): a job with an inline `git
 * commit` on the root checkout and a push step (bare `git push` or
 * `push-with-retry.sh`), but zero `git add` anywhere in the job — see header
 * comment above for why this is unambiguous dead code and why job scope
 * matters (same reasoning as rules (d)/(g)).
 */
function findDeadCommitSteps(raw) {
  const violations = [];
  const lines = raw.split('\n');
  const jobsIdx = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (jobsIdx === -1) return violations;

  const jobStarts = findJobBoundaries(lines, jobsIdx);

  for (let j = 0; j < jobStarts.length - 1; j++) {
    const start = jobStarts[j];
    const end = jobStarts[j + 1];
    const jobName = lines[start].trim().replace(/:\s*$/, '');

    let hasGitAdd = false;
    let hasPush = false;
    const commitLines = [];
    let inRunBlock = false;
    let runIndent = -1;

    for (let i = start; i < end; i++) {
      const line = lines[i];
      const stripped = line.trimStart();
      if (stripped.startsWith('#')) continue;

      let textToCheck = null;
      const runMatch = stripped.match(RUN_LINE_RE);
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

      if (textToCheck !== null && !textToCheck.trimStart().startsWith('#')) {
        if (/\bgit\s+add\b/.test(textToCheck)) {
          hasGitAdd = true;
        }
        if (GIT_ADD_SATISFYING_SCRIPT_RE.test(textToCheck)) {
          hasGitAdd = true;
        }
        if (/\bgit push\b/.test(textToCheck) || /push-with-retry\.sh/.test(textToCheck)) {
          hasPush = true;
        }
        if (/\bgit commit\b/.test(textToCheck)) {
          commitLines.push({ lineNum: i + 1, text: line.trim() });
        }
      }
    }

    if (commitLines.length > 0 && hasPush && !hasGitAdd) {
      for (const c of commitLines) {
        violations.push({ job: jobName, lineNum: c.lineNum, text: c.text });
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
    const runMatch = stripped.match(RUN_LINE_RE);

    if (runMatch) {
      const content = runMatch[1];
      // Tolerates chomp/indent indicators in either order (|2, |2-, >+) and a
      // trailing comment (rules a-d's isBlockScalar checks don't need this).
      const isBlockScalar = /^[|>][0-9]?[-+]?(\s+#.*)?$/.test(content) || content === '';
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
      // Guarded on the same line — covers `cmd || echo $?`, brace groups
      // (`cmd || { echo $?; }`), and subshells (`cmd || (echo $?)`).
      if (/\|\|.*echo\s+"?\$\?"?/.test(l.text)) continue;
      violations.push({ lineNum: l.lineNum, text: l.text.trim() });
    }
  }

  return violations;
}

const API_TIMEOUT_MS = 10_000;

/**
 * Minimal GitHub REST GET with a hard request timeout. Mirrors the shape of
 * audit-workflow-activity.js's apiGet but kept local — this file is a
 * standalone CI gate and shouldn't import a sibling script. A stalled
 * socket must not be able to hold this job open indefinitely (ship-check
 * finding, task #737): without a timeout, one hung connection burns the
 * entire lint-workflows job budget.
 */
function apiGet(url, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'bwsc-audit-workflow-hygiene',
      },
      timeout: API_TIMEOUT_MS,
    };
    const req = https
      .get(url, opts, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(body));
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`GitHub API ${res.statusCode} for ${url}: ${body.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`GitHub API request timed out after ${API_TIMEOUT_MS}ms: ${url}`));
    });
  });
}

/** Bounded-concurrency map, matching the pool style in audit-workflow-activity.js. */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  const queue = items.map((item, i) => [item, i]);
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const [item, i] = queue.shift();
      results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fetches every registered workflow's { file, createdAt } plus a lifetime
 * run count, then applies the pure detector. Returns { skipped: true,
 * reason } when there's no token or this is an ordinary push-triggered CI
 * run (kept fast); otherwise { skipped: false, offenders, totalChecked }.
 * Never throws — a network/API failure degrades to skipped, since this
 * check must never be able to fail the CI gate.
 */
async function checkNeverRunWorkflowCoverage(files) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    return { skipped: true, reason: 'no GH_TOKEN/GITHUB_TOKEN in env' };
  }
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (eventName === 'push' || eventName === 'pull_request') {
    return {
      skipped: true,
      reason: `live scan skipped on '${eventName}' trigger to keep lint-workflows fast (runs on schedule + manual)`,
    };
  }

  try {
    const workflows = [];
    let page = 1;
    for (;;) {
      const data = await apiGet(
        `https://api.github.com/repos/${REPO}/actions/workflows?per_page=100&page=${page}`,
        token,
      );
      const batch = data.workflows || [];
      for (const wf of batch) {
        const file = path.basename(wf.path);
        if (files.includes(file)) workflows.push({ file, createdAt: wf.created_at });
      }
      if (batch.length < 100) break;
      page++;
    }

    // Per-workflow failures (403/429/timeout/malformed body) resolve to
    // `null` here rather than throwing — one flaky run-count request must
    // never collapse the entire scan to "skipped" (ship-check finding,
    // task #737). A `null` count means "unknown", not "zero"; those
    // workflows are excluded from offender consideration below rather than
    // risking a false positive.
    const runCountEntries = await mapWithConcurrency(workflows, NEVER_RUN_CONCURRENCY, async (wf) => {
      try {
        const data = await apiGet(
          `https://api.github.com/repos/${REPO}/actions/workflows/${encodeURIComponent(wf.file)}/runs?per_page=1`,
          token,
        );
        return [wf.file, typeof data.total_count === 'number' ? data.total_count : null];
      } catch {
        return [wf.file, null];
      }
    });
    const unknownCountFiles = runCountEntries.filter(([, count]) => count === null).map(([file]) => file);
    const runCountsByFile = Object.fromEntries(
      runCountEntries.filter(([, count]) => count !== null),
    );
    const knownWorkflows = workflows.filter((wf) => !unknownCountFiles.includes(wf.file));

    const offenders = findNeverRunWorkflows({
      workflows: knownWorkflows,
      runCountsByFile,
      now: Date.now(),
      minAgeDays: NEVER_RUN_MIN_AGE_DAYS,
    });

    return {
      skipped: false,
      offenders,
      totalChecked: knownWorkflows.length,
      unknownCount: unknownCountFiles.length,
    };
  } catch (err) {
    return { skipped: true, reason: `API error: ${err.message}` };
  }
}

async function main() {
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
    coreDataPush: [],
    deadCommit: [],
  };

  // Degrade rule (g) alone on a format change in push-core-data/action.yml
  // (e.g. CORE_FILES switched to single quotes or split across lines) —
  // must never crash rules (a)-(f), the same non-fatal posture rule (f)
  // already has for its own live-API failure mode.
  let coreFiles = null;
  try {
    coreFiles = getCoreFilesFromPushAction();
  } catch (err) {
    console.log(`ℹ️  Rule (g) core-data-push check skipped: ${err.message}`);
  }

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

    // ── Rule (g): CORE_FILES write with no push-core-data in the same job ─────
    if (coreFiles && !raw.includes('hygiene-core-data-push-ok:')) {
      const hits = findCoreFileWritesWithoutPush(raw, coreFiles);
      if (hits.length > 0) {
        violations.coreDataPush.push({ file, hits });
      }
    }

    // ── Rule (h): dead commit step — git commit + push with zero git add ──────
    if (!raw.includes('hygiene-dead-commit-ok:')) {
      const hits = findDeadCommitSteps(raw);
      if (hits.length > 0) {
        violations.deadCommit.push({ file, hits });
      }
    }
  }

  // ── Rule (f): never-run workflow coverage (advisory — never counts toward `total`) ─
  // Console-only here — this CLI entry point has no commit step (lint-workflows
  // just checks out code), so a snapshot written here would never leave the
  // ephemeral runner (ship-check finding, task #737). The persisted,
  // digest-visible source of truth is health-check.js, which reuses this same
  // checkNeverRunWorkflowCoverage() (exported below) and writes
  // NEVER_RUN_SNAPSHOT_PATH from within data-health-check.yml — a job that
  // already commits data/audit/* daily.
  const neverRun = await checkNeverRunWorkflowCoverage(files);
  if (neverRun.skipped) {
    console.log(`ℹ️  Never-run workflow coverage check skipped (${neverRun.reason}).`);
  } else {
    console.log(
      `ℹ️  Never-run workflow coverage: ${neverRun.offenders.length} offender(s) among ${neverRun.totalChecked} checked (>${NEVER_RUN_MIN_AGE_DAYS}d old, 0 lifetime runs)` +
        (neverRun.unknownCount ? `, ${neverRun.unknownCount} unknown (API errors, excluded)` : '') +
        '.',
    );
    if (neverRun.offenders.length > 0) {
      for (const f of neverRun.offenders) console.log(`   • ${f}`);
    }
  }

  const total =
    violations.notifyFailure.length +
    violations.playwright.length +
    violations.pushRetry.length +
    violations.gitIdentity.length +
    violations.echoExitcode.length +
    violations.coreDataPush.length +
    violations.deadCommit.length;

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

  if (violations.coreDataPush.length) {
    console.error('── (g) CORE_FILES write with no push-core-data in the same job ───────');
    console.error('This job `git add`s a data/<file> that push-core-data.CORE_FILES tracks, but');
    console.error('never calls push-core-data — the write reaches the public repo (if committed');
    console.error('there) but never the authoritative private data repo, so it silently never');
    console.error('persists for any other workflow\'s checkout-core-data (task #1441 bug class).\n');
    for (const { file, hits } of violations.coreDataPush) {
      console.error(`  • ${file}`);
      for (const h of hits) console.error(`      job "${h.job}" line ${h.lineNum} [${h.coreFile}]: ${h.text}`);
    }
    console.error('\nFix: add a push-core-data step in the SAME job, after the write:');
    console.error(`      - name: Push core data to private repo
        uses: ./.github/actions/push-core-data
        with:
          token: \${{ secrets.REVIEW_TEXTS_TOKEN }}
          message: 'data: <describe the write>'`);
    console.error("Exempt (legitimate): add  # hygiene-core-data-push-ok: <reason>  anywhere in the file.\n");
  }

  if (violations.deadCommit.length) {
    console.error('── (h) Dead commit step — git commit + push with zero git add ────────');
    console.error('This job runs `git commit` and pushes, but never stages anything in the');
    console.error('same job — including via stage-data-changes.sh/git-add-existing.sh/');
    console.error('safe-sync-review-texts.sh/sync-audit-checkout.sh. The commit is permanent');
    console.error('dead code: it either no-ops on a clean tree or fails every run (task #1461,');
    console.error('generalizes the #1460 bug class found twice by hand).\n');
    for (const { file, hits } of violations.deadCommit) {
      console.error(`  • ${file}`);
      for (const h of hits) console.error(`      job "${h.job}" line ${h.lineNum}: ${h.text}`);
    }
    console.error('\nFix: add the missing `git add` (or a step that stages files internally,');
    console.error('e.g. `bash scripts/lib/stage-data-changes.sh`) before the commit, in the');
    console.error('SAME job — or remove the dead commit/push steps entirely.');
    console.error("Exempt (legitimate): add  # hygiene-dead-commit-ok: <reason>  anywhere in the file.\n");
  }

  process.exit(1);
}

module.exports = {
  checkNeverRunWorkflowCoverage,
  NEVER_RUN_MIN_AGE_DAYS,
  NEVER_RUN_SNAPSHOT_PATH,
  findCoreFileWritesWithoutPush,
  getCoreFilesFromPushAction,
  findDeadCommitSteps,
  runLineMatches,
  findMissingGitIdentityCommits,
  findPipefailDeadExitCodeEcho,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
