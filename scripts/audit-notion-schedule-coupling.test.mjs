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

test('findSignals: the mirror sync, action poller and mirror loader count as coupling (BRO-3018)', () => {
  // The escalation path in generate-remediation-plan.js ran exactly this after
  // filing in Linear; none of the original five signals matched it.
  assert.deepEqual(
    src.findSignals("execFileSync('node', [path.join(dir, 'notion-tasks-sync.js'), 'pull']);"),
    ['notion-tasks-sync.js'],
  );
  assert.deepEqual(src.findSignals("spawn('node', ['scripts/notion-action-poll.js']);"), ['notion-action-poll.js']);
  assert.deepEqual(src.findSignals('const t = loadNotionMirrorTasks();'), ['loadNotionMirrorTasks']);
  assert.deepEqual(src.findSignals('// notion-tasks-sync.js pull used to run here'), []);
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
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(workflowsDir, `inert-${i}.yml`), 'jobs: {}\n');
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
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(workflowsDir, `inert-${i}.yml`), 'jobs: {}\n');
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
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(workflowsDir, `inert-${i}.yml`), 'jobs: {}\n');
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

// BRO-5845: both live Notion-calling launchd jobs ran as `bash -c "cd ... && exec node scripts/X.js"`,
// which the old last-argument-only extractor never resolved, so the audit reported 0.
test('scriptsFromProgramArguments: resolves every node/bash target inside a bash -c string against its cd', () => {
  const plist = `<plist><dict><key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-c</string>
    <string>cd /Users/tompryor/Broadwayscore &amp;&amp; SYNC_TAG=x bash scripts/lib/sync-audit-checkout.sh &amp;&amp; exec node scripts/predispatch-queue-audit.js --fix</string>
  </array></dict></plist>`;
  const args = src.extractProgramArguments(plist);
  assert.match(args[2], /&& exec node/);
  assert.deepEqual(src.scriptsFromProgramArguments(args), [
    '/Users/tompryor/Broadwayscore/scripts/lib/sync-audit-checkout.sh',
    '/Users/tompryor/Broadwayscore/scripts/predispatch-queue-audit.js',
  ]);
  assert.deepEqual(src.scriptsFromProgramArguments(['/bin/bash', '-c', 'echo hi']), []);
  // relative target with no cd cannot be resolved; never guess
  assert.deepEqual(src.scriptsFromProgramArguments(['/bin/bash', '-c', 'node scripts/x.js']), []);
});

test('findSignals on shell scripts: comments and prose are clean, a real invocation is caught', () => {
  assert.deepEqual(src.findSignals('# leave notion-action-poll.js worktrees alone\necho ok\n', 'a.sh'), []);
  assert.deepEqual(src.findSignals('PROMPT="Notion is retired: never use notion-brain.js."\n', 'a.sh'), []);
  assert.deepEqual(src.findSignals('node "$REPO/scripts/notion-brain.js" update "$ID"\n', 'a.sh'), ['notion-brain.js']);
  // JS files keep the full signal set
  assert.deepEqual(src.findSignals("const { TASKS_DIR } = require('./bsc-next.js');", 'a.js'), ['TASKS_DIR']);
});

// Ship-check (BRO-5845): the first bash -c parser missed `/opt/homebrew/bin/node /abs/x.js`
// (dispatch-watchdog-health's real plist), quoted targets and `cd ~`, and dropped
// unresolvable targets silently instead of reporting incomplete coverage.
test('scriptsFromShellCommand: absolute interpreters, env, quotes, ~, repeated cd', () => {
  const home = os.homedir();
  assert.deepEqual(src.scriptsFromShellCommand('/opt/homebrew/bin/node /Users/t/Broadwayscore/scripts/dispatch-watchdog.js --health', null),
    ['/Users/t/Broadwayscore/scripts/dispatch-watchdog.js']);
  assert.deepEqual(src.scriptsFromShellCommand('cd /r && /usr/bin/env node --env-file=.env "scripts/a b.js"', null), ['/r/scripts/a b.js']);
  assert.deepEqual(src.scriptsFromShellCommand('cd ~/Broadwayscore; exec node scripts/x.js || true', null), [`${home}/Broadwayscore/scripts/x.js`]);
  assert.deepEqual(src.scriptsFromShellCommand('cd /a && node x.js && cd /b && bash y.sh | tee log', null), ['/a/x.js', '/b/y.sh']);
  assert.deepEqual(src.scriptsFromShellCommand('echo node x.js', '/a'), [], 'node as an argument is not an invocation');
});

test('scriptsFromShellCommand: unresolvable targets are reported, never guessed', () => {
  const unresolved = [];
  assert.deepEqual(src.scriptsFromShellCommand('node scripts/x.js && node "$FOO/y.js"', null, unresolved), []);
  assert.deepEqual(unresolved, ['scripts/x.js', '$FOO/y.js']);
});

test('scriptsFromShellScript: follows a wrapper into the scripts it runs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsc-'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'lib', 'helper.js'), '');
  const sh = path.join(root, 'scripts', 'wrap.sh');
  fs.writeFileSync(sh, [
    '#!/bin/bash',
    'cd "$(dirname "$0")/.." || exit 1',
    '# node scripts/commented-out.js',
    'node scripts/child.js --flag',
    'node "$SCRIPT_DIR/lib/helper.js"',
    'node "$SCRIPT_DIR/lib/missing.js"',
  ].join('\n'));
  const unresolved = [];
  assert.deepEqual(src.scriptsFromShellScript(sh, unresolved), [
    path.join(root, 'scripts', 'child.js'),
    path.join(root, 'scripts', 'lib', 'helper.js'),
  ]);
  assert.deepEqual(unresolved, ['$SCRIPT_DIR/lib/missing.js']);
  fs.rmSync(root, { recursive: true, force: true });
});

// Second ship-check pass (BRO-5845): forms the first tokenizer dropped with no
// unresolved report, and the dispatcher that hid in ~/.claude/bin.
test('scriptsFromShellCommand: wrapper commands, substitutions, redirections, escapes, newlines', () => {
  const cases = {
    'X=$(node scripts/a.js; echo)': ['/r/scripts/a.js'],
    'if ! node scripts/a.js; then x; fi': ['/r/scripts/a.js'],
    'caffeinate -i node scripts/a.js': ['/r/scripts/a.js'],
    'timeout 60 nohup node scripts/a.js &': ['/r/scripts/a.js'],
    'node -r dotenv/config scripts/a.js': ['/r/scripts/a.js'],
    'node scripts/a.js>>log 2>&1': ['/r/scripts/a.js'],
    '(node scripts/a.js)': ['/r/scripts/a.js'],
    '/usr/bin/env -i node scripts/a.js': ['/r/scripts/a.js'],
    'cd /q\nnode a.js': ['/q/a.js'],
    'node "scripts/a\\"b.js"': ['/r/scripts/a"b.js'],
    'VAR=x node a.js': ['/r/a.js'],
    'echo node x.js; printf "node %s" y.js': [],
  };
  for (const [cmd, want] of Object.entries(cases)) {
    assert.deepEqual(src.scriptsFromShellCommand(cmd, '/r'), want, cmd);
  }
});

test('wrapper outside the repo: shell signals catch a frozen-store dispatcher, $REPO targets resolve', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nsc-home-'));
  const repo = path.join(home, 'Broadwayscore');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'bsc-next.js'), '');
  const wrapper = [
    '#!/bin/bash',
    'STORE="$HOME/.claude/tasks/broadwayscore"',
    `REPO="${repo}"`,
    'out=$(cd "$REPO" && node scripts/bsc-next.js --id "$id" 2>&1)',
    'node "$REPO/scripts/bsc-next.js" --list',
  ].join('\n');
  assert.deepEqual(src.findSignals(wrapper, 'driver.sh'), ['task-store path', 'bsc-next.js']);
  const sh = path.join(home, 'driver.sh');
  fs.writeFileSync(sh, wrapper);
  const unresolved = [];
  // outside any repo the variable-cd root is ~/Broadwayscore; $REPO/... resolves only where the file exists
  const got = src.scriptsFromShellScript(sh, unresolved);
  // both invocations are accounted for: resolved (to whichever root holds the
  // file) or reported unresolved, never silently dropped
  assert.equal(got.length + unresolved.length, 2, JSON.stringify({ got, unresolved }));
  for (const g of got) assert.match(g, /\/Broadwayscore\/scripts\/bsc-next\.js$/);
  fs.rmSync(home, { recursive: true, force: true });
});
