/**
 * audit-notion-schedule-coupling.test.mjs — BRO-3431 reopen (prevention
 * requirement).
 *
 * Covers the pure predicates plus the two things an earlier hand-tuning pass
 * on real repo data actually got wrong before landing (both regression-
 * guarded here rather than trusted to "looked right when I ran it"):
 *   1. Whole-file substring matching false-positives on unrelated comments
 *      and on GitHub Actions `paths:` trigger lists that merely MENTION a
 *      script without ever executing it.
 *   2. A dependency's own signal bleeding into every one of its (possibly
 *      dozens of) callers once the allowlist should have absorbed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = require('./audit-notion-schedule-coupling.js');

test('findSignals: matches real code, ignores comments', () => {
  assert.deepEqual(src.findSignals('const x = TASKS_DIR;'), ['TASKS_DIR']);
  assert.deepEqual(src.findSignals('// TASKS_DIR is mentioned here only in prose'), []);
  assert.deepEqual(src.findSignals('/* notion-brain.js used to do X */\nconst y = 1;'), []);
  assert.deepEqual(src.findSignals('notionIdOf(task)'), ['notionIdOf(']);
  assert.deepEqual(src.findSignals('nothing coupled here'), []);
});

test('findSignals: block comment stripping does not eat real code either side of it', () => {
  const code = "const before = 'ok';\n/* comment */\nconst x = notionIdOf(t);";
  assert.deepEqual(src.findSignals(code), ['notionIdOf(']);
});

test('isAllowlisted: exact path match only', () => {
  assert.equal(src.isAllowlisted('scripts/notion-brain.js'), true);
  assert.equal(src.isAllowlisted('scripts/lib/owner-alert-router.js'), true);
  assert.equal(src.isAllowlisted('scripts/some-other-script.js'), false);
});

test('hasActiveScheduleTrigger: real cron trigger vs. commented-out vs. none', () => {
  const withCron = ['on:', '  schedule:', "    - cron: '0 6 * * *'", '  workflow_dispatch: {}'];
  assert.equal(src.hasActiveScheduleTrigger(withCron), true);

  const commentedOut = ['on:', '  # schedule:', "  #   - cron: '0 6 * * *'", '  workflow_dispatch: {}'];
  assert.equal(src.hasActiveScheduleTrigger(commentedOut), false);

  const dispatchOnly = ['on:', '  workflow_dispatch: {}'];
  assert.equal(src.hasActiveScheduleTrigger(dispatchOnly), false);

  // schedule: key present but the array item is missing/malformed — no real cron.
  const scheduleNoCron = ['on:', '  schedule:', '  workflow_dispatch: {}'];
  assert.equal(src.hasActiveScheduleTrigger(scheduleNoCron), false);
});

test('extractScriptTargets: only lines that actually invoke node/tsx, never bare mentions', () => {
  const fileContent = [
    'on:',
    '  push:',
    '    paths:',
    "      - 'scripts/mentioned-but-never-run.js'",
    'jobs:',
    '  x:',
    '    steps:',
    '      - run: node scripts/real-target.js --flag',
    '      - run: npx tsx scripts/ts-target.ts',
    '      - run: node --test scripts/some.test.mjs',
    '      - run: node scripts/tests/also-a-test.js',
    '      # a comment mentioning node scripts/should-not-count.js',
  ].join('\n');
  const targets = src.extractScriptTargets(fileContent);
  assert.deepEqual(targets.sort(), ['scripts/real-target.js', 'scripts/ts-target.ts']);
});

test('extractProgramArguments + scriptFromProgramArguments: reads a plist ProgramArguments array', () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.broadwayscore.example</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/tompryor/Broadwayscore/scripts/example.js</string>
    <string>--flag</string>
  </array>
</dict>
</plist>`;
  const args = src.extractProgramArguments(plist);
  assert.deepEqual(args, ['/opt/homebrew/bin/node', '/Users/tompryor/Broadwayscore/scripts/example.js', '--flag']);
  assert.equal(src.scriptFromProgramArguments(args), '/Users/tompryor/Broadwayscore/scripts/example.js');
  assert.equal(src.scriptFromProgramArguments(['/opt/homebrew/bin/node', '--flag']), null);
});

test('repoRelativeStable: anchors on the scripts/ directory, not the repo folder name', () => {
  assert.equal(
    src.repoRelativeStable('/Users/tompryor/Broadwayscore/scripts/bsc-prune.js'),
    'scripts/bsc-prune.js'
  );
  // Worktree checkout: repo folder name appears once, but nested — the
  // literal-folder-name approach this replaced returned a bogus
  // '.claude/worktrees/x/scripts/...' here; anchoring on '/scripts/' does not.
  assert.equal(
    src.repoRelativeStable('/Users/tompryor/Broadwayscore/.claude/worktrees/job-x/scripts/lib/foo.js'),
    'scripts/lib/foo.js'
  );
  // GitHub Actions checkout path repeats the repo name twice.
  assert.equal(
    src.repoRelativeStable('/home/runner/work/Broadwayscore/Broadwayscore/scripts/foo.js'),
    'scripts/foo.js'
  );
});

// ── Filesystem-backed regression cases ──────────────────────────────────────
// Both bugs below were caught by running the scanner against the REAL repo,
// not by reasoning about the code — see the script's own header for why a
// whole-file regex and a caller-attributed allowlist check both had to
// change. Reproduced here on a throwaway fixture tree so they can't regress
// silently.

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-coupling-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('scanWorkflowsForCoupling: a schedule whose target script is clean is not reported', () => {
  withTempDir((dir) => {
    const workflowsDir = path.join(dir, '.github', 'workflows');
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'clean.yml'),
      ['on:', '  schedule:', "    - cron: '0 6 * * *'", 'jobs:', '  x:', '    steps:', '      - run: node scripts/clean.js'].join('\n')
    );
    fs.writeFileSync(path.join(scriptsDir, 'clean.js'), "console.log('no coupling here');\n");

    const result = src.scanWorkflowsForCoupling({ workflowsDir, repo: dir });
    assert.equal(result.ok, true);
    assert.equal(result.findings.length, 0);
    assert.equal(result.scannedWorkflows, 1);
  });
});

test('scanWorkflowsForCoupling: a schedule whose target script reads TASKS_DIR is reported', () => {
  withTempDir((dir) => {
    const workflowsDir = path.join(dir, '.github', 'workflows');
    const scriptsDir = path.join(dir, 'scripts');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'coupled.yml'),
      ['on:', '  schedule:', "    - cron: '0 6 * * *'", 'jobs:', '  x:', '    steps:', '      - run: node scripts/coupled.js'].join('\n')
    );
    fs.writeFileSync(path.join(scriptsDir, 'coupled.js'), "const dir = TASKS_DIR;\nconsole.log(dir);\n");

    const result = src.scanWorkflowsForCoupling({ workflowsDir, repo: dir });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].script, 'scripts/coupled.js');
    assert.deepEqual(result.findings[0].signals, ['TASKS_DIR']);
  });
});

test('readScriptWithLocalDeps (via scanWorkflowsForCoupling): an allowlisted dep does not leak its signal onto its caller', () => {
  withTempDir((dir) => {
    const workflowsDir = path.join(dir, '.github', 'workflows');
    const scriptsDir = path.join(dir, 'scripts');
    const libDir = path.join(scriptsDir, 'lib');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, 'caller.yml'),
      ['on:', '  schedule:', "    - cron: '0 6 * * *'", 'jobs:', '  x:', '    steps:', '      - run: node scripts/caller.js'].join('\n')
    );
    // caller.js pulls in the real (allowlisted) owner-alert-router.js path —
    // its own code has zero coupling signals itself.
    fs.writeFileSync(
      path.join(scriptsDir, 'caller.js'),
      "const { routeAlert } = require('./lib/owner-alert-router.js');\nrouteAlert();\n"
    );
    fs.writeFileSync(
      path.join(libDir, 'owner-alert-router.js'),
      "const NOTION_BRAIN = require('../notion-brain.js');\nmodule.exports = { routeAlert: () => NOTION_BRAIN };\n"
    );

    const result = src.scanWorkflowsForCoupling({ workflowsDir, repo: dir });
    assert.equal(result.findings.length, 0, 'allowlisted dep signal must not attach to its caller');
  });
});

test('scanLaunchdForCoupling: reports {ok:false} off-darwin instead of silently finding nothing', () => {
  if (os.platform() === 'darwin') return; // exercised for real by the CI/non-mac case only
  const result = src.scanLaunchdForCoupling();
  assert.equal(result.ok, false);
  assert.match(result.reason, /darwin/);
  assert.deepEqual(result.findings, []);
});
