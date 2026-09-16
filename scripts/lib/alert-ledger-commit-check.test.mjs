import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { findMissingLedgerCommits, findRouterCallerScripts } = require('./alert-ledger-commit-check.js');

function withFixtureScripts(files, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-ledger-fixture-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MISSING_COMMIT_FIXTURE = `name: Bad Example
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        uses: actions/github-script@v7
        with:
          script: |
            const { routeAlert } = require('./scripts/lib/owner-alert-router.js');
            await routeAlert({ conditionKey: 'x', title: 'y', disposition: 'auto' });
      - name: Commit other stuff
        run: |
          git add data/audit/some-other-file.json
          git add data/audit/alert-router-attempts.jsonl 2>/dev/null || true
          git commit -m 'x'
`;

const DIRECT_COMMIT_FIXTURE = `name: Good Example (direct git add)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add data/audit/alert-ledger.json 2>/dev/null || true
          git add data/audit/alert-router-attempts.jsonl 2>/dev/null || true
          git commit -m 'x'
`;

const LOOP_COMMIT_FIXTURE = `name: Good Example (for-loop staging)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        uses: actions/github-script@v7
        with:
          script: |
            const { routeAlert } = require('./scripts/lib/owner-alert-router.js');
            await routeAlert({ conditionKey: 'x', title: 'y', disposition: 'digest' });
      - name: Commit
        run: |
          for f in data/audit/foo.json data/audit/alert-ledger.json data/audit/alert-digest-queue.json data/audit/alert-router-attempts.jsonl; do
            [ -e "$f" ] && git add "$f" || echo "skip (absent): $f"
          done
          git commit -m 'x'
`;

const DIGEST_NO_QUEUE_FIXTURE = `name: Bad Example (digest disposition without queue commit)
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        uses: actions/github-script@v7
        with:
          script: |
            const { routeAlert } = require('./scripts/lib/owner-alert-router.js');
            await routeAlert({ conditionKey: 'x', title: 'y', disposition: 'digest' });
      - name: Commit
        run: |
          git add data/audit/alert-ledger.json 2>/dev/null || true
          git add data/audit/alert-router-attempts.jsonl 2>/dev/null || true
          git commit -m 'x'
`;

const OTHER_JOB_COMMIT_FIXTURE = `name: Bad Example (commit in a DIFFERENT job)
on:
  push:
jobs:
  alerter:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
  committer:
    runs-on: ubuntu-latest
    steps:
      - name: Commit
        run: |
          git add data/audit/alert-ledger.json 2>/dev/null || true
          git commit -m 'x'
`;

const SPLIT_DO_LOOP_FIXTURE = `name: Good Example (for-loop with do on next line)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          for f in data/audit/foo.json data/audit/alert-ledger.json data/audit/alert-router-attempts.jsonl
          do
            [ -e "$f" ] && git add "$f" || echo "skip (absent): $f"
          done
          git commit -m 'x'
`;

const COMMENTED_OUT_STAGE_FIXTURE = `name: Bad Example (commented-out staging line)
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          # git add data/audit/alert-ledger.json 2>/dev/null || true
          git add data/audit/alert-router-attempts.jsonl 2>/dev/null || true
          git commit -m 'x'
`;

const MULTILINE_GIT_ADD_EXISTING_FIXTURE = `name: Good Example (git-add-existing.sh, multi-line args)
on:
  push:
jobs:
  dmarc:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          bash scripts/lib/git-add-existing.sh \\
            data/audit/dmarc-summary.json \\
            data/audit/dmarc-report-ledger.jsonl \\
            data/audit/alert-ledger.json \\
            data/audit/alert-digest-queue.json \\
            data/audit/alert-router-attempts.jsonl
          git commit -m 'x'
`;

const MULTILINE_BARE_GIT_ADD_FIXTURE = `name: Good Example (bare git add, multi-line args)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add \\
            data/video-reviews.json \\
            data/audit/alert-ledger.json \\
            data/audit/alert-router-attempts.jsonl \\
            public/images/video-reviews/

          git commit -m 'x'
`;

const MULTILINE_MISSING_TARGET_FIXTURE = `name: Bad Example (multi-line git add, target file NOT in the list)
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          bash scripts/lib/git-add-existing.sh \\
            data/audit/some-other-file.json \\
            data/audit/another-file.json \\
            data/audit/alert-router-attempts.jsonl
          git commit -m 'x'
`;

const NO_ROUTE_ALERT_FIXTURE = `name: Unrelated
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
`;

// BRO-3051: test.yml's own "page-worthy alert steps unreachable" audit step
// (BRO-2817) documents a DIFFERENT checker's blind spot with a prose example
// containing the literal text "routeAlert(" inside a `#` comment. No actual
// call exists in the job. Comment lines were already excluded from
// jobStagesFile()'s staging-detection scan for the same reason (a
// commented-out `git add` isn't real staging) — this fixture pins the
// opposite-direction case.
const COMMENT_ONLY_MENTION_FIXTURE = `name: Comment Mention Only
on:
  push:
jobs:
  lint-workflows:
    runs-on: ubuntu-latest
    steps:
      - name: Audit — page-worthy alert steps unreachable (advisory)
        # A hard-fail gate step upstream of a
        # routeAlert(disposition:'human', conditionKey: <page-worthy>) alert
        # step silently swallows that alert. Heuristic — it can't see
        # routeAlert() calls made from inside an invoked scripts/*.js file.
        run: node scripts/audit-alert-reachability.js
`;

test('no violation when routeAlert()/resolveCondition() only appears inside a # comment', () => {
  assert.deepEqual(findMissingLedgerCommits(COMMENT_ONLY_MENTION_FIXTURE), []);
});

test('flags a job that calls routeAlert() with no ledger commit', () => {
  const violations = findMissingLedgerCommits(MISSING_COMMIT_FIXTURE);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job 'broken'/);
  assert.match(violations[0], /alert-ledger\.json/);
});

test('clean: direct `git add ... alert-ledger.json` in the same job', () => {
  assert.deepEqual(findMissingLedgerCommits(DIRECT_COMMIT_FIXTURE), []);
});

test('clean: for-loop staging pattern (audit-aggregator-gap.yml style)', () => {
  assert.deepEqual(findMissingLedgerCommits(LOOP_COMMIT_FIXTURE), []);
});

test('clean: for-loop with `do` on its own next line', () => {
  assert.deepEqual(findMissingLedgerCommits(SPLIT_DO_LOOP_FIXTURE), []);
});

test('clean: for-loop with a trailing comment after `do` (task #763 exemption-marker case)', () => {
  const fixture = LOOP_COMMIT_FIXTURE.replace(
    '; do\n',
    '; do # workflow-line-length-ok: fixed list, not a growing one\n'
  );
  assert.deepEqual(findMissingLedgerCommits(fixture), []);
});

test('flags disposition:\'digest\' with no alert-digest-queue.json commit', () => {
  const violations = findMissingLedgerCommits(DIGEST_NO_QUEUE_FIXTURE);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job 'broken'/);
  assert.match(violations[0], /alert-digest-queue\.json/);
});

test('flags a job whose only "staging" is a commented-out git add line', () => {
  const violations = findMissingLedgerCommits(COMMENTED_OUT_STAGE_FIXTURE);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job 'broken'/);
});

test('flags routeAlert in one job when the commit happens in a DIFFERENT job', () => {
  const violations = findMissingLedgerCommits(OTHER_JOB_COMMIT_FIXTURE);
  // Two rules fire, because the alerting job stages NEITHER file: the ledger
  // and (BRO-3662) the router attempts log. Both must name the alerting job —
  // the committer job's staging is in the wrong job and must not excuse it.
  assert.equal(violations.length, 2);
  for (const v of violations) assert.match(v, /job 'alerter'/);
  assert.ok(violations.some(v => /alert-ledger\.json/.test(v)));
  assert.ok(violations.some(v => /alert-router-attempts\.jsonl/.test(v)));
});

test('clean: git-add-existing.sh with args on separate continuation lines (finance-ingest.yml dmarc shape)', () => {
  assert.deepEqual(findMissingLedgerCommits(MULTILINE_GIT_ADD_EXISTING_FIXTURE), []);
});

test('clean: bare `git add \\` with args on separate continuation lines (weekly-video-reviews.yml shape)', () => {
  assert.deepEqual(findMissingLedgerCommits(MULTILINE_BARE_GIT_ADD_FIXTURE), []);
});

test('flags multi-line git-add-existing.sh whose continuation args do NOT include the ledger file', () => {
  const violations = findMissingLedgerCommits(MULTILINE_MISSING_TARGET_FIXTURE);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job 'broken'/);
});

// BRO-3662 regression: the shape that was live in 14 workflows — the ledger IS
// staged, so the pre-existing rule reported clean, while alert-router-attempts
// .jsonl (rewritten by logDispatchAttempt() on every dispatch attempt) was left
// unstaged. A tracked file modified and left unstaged makes `git rebase` refuse
// pre-flight, which silently forced push-with-retry.sh onto `merge -X ours` for
// all 10 retry attempts of process-feedback.yml run 34852355418.
const LEDGER_STAGED_ATTEMPTS_MISSING_FIXTURE = `name: Bad Example (ledger staged, attempts log not)
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add data/audit/alert-ledger.json 2>/dev/null || true
          git commit -m 'x'
`;

test('flags a job that stages the ledger but NOT alert-router-attempts.jsonl', () => {
  const violations = findMissingLedgerCommits(LEDGER_STAGED_ATTEMPTS_MISSING_FIXTURE);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /job 'broken'/);
  assert.match(violations[0], /alert-router-attempts\.jsonl/);
});

test('clean once alert-router-attempts.jsonl is staged alongside the ledger', () => {
  const fixed = LEDGER_STAGED_ATTEMPTS_MISSING_FIXTURE.replace(
    "          git commit -m 'x'\n",
    "          git add data/audit/alert-router-attempts.jsonl 2>/dev/null || true\n          git commit -m 'x'\n"
  );
  assert.deepEqual(findMissingLedgerCommits(fixed), []);
});

test('no violation when the workflow never calls routeAlert/resolveCondition', () => {
  assert.deepEqual(findMissingLedgerCommits(NO_ROUTE_ALERT_FIXTURE), []);
});

test('no violation on text with no jobs: section', () => {
  assert.deepEqual(findMissingLedgerCommits('name: no-jobs\non:\n  push:\n'), []);
});

test('every real .github/workflows/*.yml is clean', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yml'));
  assert.ok(files.length > 50, 'sanity check: expected many workflow files');

  // BRO-3671: computed once (repo-wide) and passed to every call, same split
  // as scripts/lib/ledger-coverage-check.js's ledgerScripts — a job that
  // invokes any of these scripts is a router caller even with no literal
  // routeAlert()/resolveCondition() text in its own YAML.
  const routerCallerScripts = findRouterCallerScripts(path.join(repoRoot, 'scripts'));
  assert.ok(routerCallerScripts.size > 0, 'sanity check: expected real router-caller scripts to be found');

  const failures = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
    const violations = findMissingLedgerCommits(text, routerCallerScripts);
    if (violations.length) failures.push(`${file}: ${violations.join('; ')}`);
  }
  assert.deepEqual(failures, []);
});

// --- findRouterCallerScripts (BRO-3671 require-graph resolution) ---

test('findRouterCallerScripts: flags a script that directly requires+calls the router (hop 0)', () => {
  withFixtureScripts(
    {
      'lib/owner-alert-router.js': `
        function routeAlert(opts) { return opts; }
        function resolveCondition(key) { return key; }
        module.exports = { routeAlert, resolveCondition };
      `,
      'direct-caller.js': `#!/usr/bin/env node
        const { routeAlert } = require('./lib/owner-alert-router.js');
        async function main() { await routeAlert({ conditionKey: 'x' }); }
        main();
      `,
    },
    (dir) => {
      const found = findRouterCallerScripts(dir);
      assert.ok(found.has('direct-caller.js'));
    }
  );
});

test('findRouterCallerScripts: does NOT flag a script that requires the router but never calls it', () => {
  withFixtureScripts(
    {
      'lib/owner-alert-router.js': `
        function routeAlert(opts) { return opts; }
        function loadLedger() { return {}; }
        module.exports = { routeAlert, loadLedger };
      `,
      'ledger-reader-only.js': `#!/usr/bin/env node
        const { loadLedger } = require('./lib/owner-alert-router.js');
        console.log(loadLedger());
      `,
    },
    (dir) => {
      const found = findRouterCallerScripts(dir);
      assert.ok(!found.has('ledger-reader-only.js'));
    }
  );
});

// Regression (ship-check/Codex adversarial review): acorn allocates TWO
// distinct Identifier node objects for a shorthand destructure like
// `const { routeAlert } = require(...)` — `prop.key` and `prop.value` are
// NOT the same object despite matching name/position. Excluding only
// `prop.value` from "declaration site" left `prop.key` looking like a real
// usage the moment the walk visited the declaration statement itself,
// flagging EVERY script that merely imports routeAlert/resolveCondition —
// even with zero further use — as a router caller.
test('findRouterCallerScripts: does NOT flag a script that shorthand-destructures the router export but never uses it', () => {
  withFixtureScripts(
    {
      'lib/owner-alert-router.js': `
        function routeAlert(opts) { return opts; }
        module.exports = { routeAlert };
      `,
      'imports-only.js': `#!/usr/bin/env node
        const { routeAlert } = require('./lib/owner-alert-router.js');
        console.log('imported but never called or referenced again');
      `,
    },
    (dir) => {
      const found = findRouterCallerScripts(dir);
      assert.ok(!found.has('imports-only.js'));
    }
  );
});

test('findRouterCallerScripts: flags a script that reaches the router one hop through a lib wrapper', () => {
  withFixtureScripts(
    {
      'lib/owner-alert-router.js': `
        function routeAlert(opts) { return opts; }
        module.exports = { routeAlert };
      `,
      'lib/opening-night-sla.js': `
        const { routeAlert } = require('./owner-alert-router');
        async function dispatchSla(x) { return routeAlert(x); }
        module.exports = { dispatchSla };
      `,
      'sla-caller.js': `#!/usr/bin/env node
        const { dispatchSla } = require('./lib/opening-night-sla.js');
        async function main() { await dispatchSla({}); }
        main();
      `,
    },
    (dir) => {
      const found = findRouterCallerScripts(dir);
      assert.ok(found.has('sla-caller.js'));
    }
  );
});

// Real bug the naive `grep -rl owner-alert-router scripts/*.js` (the
// ticket's own repro command) would have introduced: a script that only
// mentions "routeAlert()"/"owner-alert-router" in a PROSE COMMENT, with no
// actual require() of the router, must not be flagged. Pins the real
// scripts/audit-reverse-discovery.js / scripts/check-opening-night-
// completeness.js finding from BRO-3671's investigation — both call
// discord-notify.js's sendAlert() directly and only mention the router in a
// comment ("// notifyOk mirrors owner-alert-router's routeAlert() gate").
test('findRouterCallerScripts: does NOT flag a script that only mentions the router in a comment', () => {
  withFixtureScripts(
    {
      'lib/owner-alert-router.js': `
        function routeAlert(opts) { return opts; }
        module.exports = { routeAlert };
      `,
      'lib/discord-notify.js': `
        function sendAlert(msg) { return msg; }
        module.exports = { sendAlert };
      `,
      'comment-only-mention.js': `#!/usr/bin/env node
        // Direct sendAlert, not routeAlert — this already has its own cooldown.
        // notifyOk mirrors owner-alert-router's routeAlert() gate: warning
        const { sendAlert } = require('./lib/discord-notify.js');
        sendAlert('hello');
      `,
    },
    (dir) => {
      const found = findRouterCallerScripts(dir);
      assert.ok(!found.has('comment-only-mention.js'));
    }
  );
});

// Real case (BRO-3671): scripts/opening-night-checklist.js requires
// `routeAlert` and passes it BY REFERENCE into another function's options
// object (`executeRemediations(planned, { ..., routeAlert, ... })`) — the
// actual call happens inside opening-night-remediation.js, which never
// require()s the router itself. A pure call-callee walk misses this
// entirely; referenceCountsAsReach (opt-in for this checker only) catches it.
test('findRouterCallerScripts: flags a script that requires the router and passes it by reference (DI pattern)', () => {
  withFixtureScripts(
    {
      'lib/owner-alert-router.js': `
        function routeAlert(opts) { return opts; }
        module.exports = { routeAlert };
      `,
      'lib/remediation.js': `
        async function executeRemediations(planned, opts) { return opts.routeAlert(planned); }
        module.exports = { executeRemediations };
      `,
      'di-caller.js': `#!/usr/bin/env node
        const { routeAlert } = require('./lib/owner-alert-router.js');
        const { executeRemediations } = require('./lib/remediation.js');
        async function main() {
          await executeRemediations([], { routeAlert, appendLedger: () => {} });
        }
        main();
      `,
    },
    (dir) => {
      const found = findRouterCallerScripts(dir);
      assert.ok(found.has('di-caller.js'));
    }
  );
});

// --- findMissingLedgerCommits with routerCallerScripts (BRO-3671) ---

const ROUTER_CALLER_SCRIPTS = new Set(['router-wrapper.js']);

test('findMissingLedgerCommits: flags a job invoking a router-caller script with no ledger commit', () => {
  const fixture = `name: Indirect Caller
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/router-wrapper.js
      - name: Commit other stuff
        run: |
          git add data/audit/some-other-file.json
          git commit -m 'x'
`;
  const violations = findMissingLedgerCommits(fixture, ROUTER_CALLER_SCRIPTS);
  assert.equal(violations.length, 2);
  for (const v of violations) assert.match(v, /job 'broken'/);
});

test('findMissingLedgerCommits: clean when a job invoking a router-caller script stages both files', () => {
  const fixture = `name: Indirect Caller (clean)
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/router-wrapper.js
      - name: Commit
        run: |
          git add data/audit/alert-ledger.json 2>/dev/null || true
          git add data/audit/alert-router-attempts.jsonl 2>/dev/null || true
          git commit -m 'x'
`;
  assert.deepEqual(findMissingLedgerCommits(fixture, ROUTER_CALLER_SCRIPTS), []);
});

test('findMissingLedgerCommits: does not flag a job invoking an unrelated script', () => {
  const fixture = `name: Unrelated script
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Run
        run: node scripts/some-other-script.js
`;
  assert.deepEqual(findMissingLedgerCommits(fixture, ROUTER_CALLER_SCRIPTS), []);
});

// --- jobStagesFile widening (BRO-3671: git add -A / . / covering dir arg) ---

test('clean: `git add -A` covers the target file (opening-night-poller.yml shape)', () => {
  const fixture = `name: Broad add -A
on:
  push:
jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add data/audit/alert-ledger.json 2>/dev/null || true
          git add -A
          git commit -m 'x'
`;
  assert.deepEqual(findMissingLedgerCommits(fixture), []);
});

test('clean: `git add .` covers the target file', () => {
  const fixture = `name: Broad add dot
on:
  push:
jobs:
  ok:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add .
          git commit -m 'x'
`;
  assert.deepEqual(findMissingLedgerCommits(fixture), []);
});

test('clean: `git add -u data/audit/` covers the target file via directory prefix (rebuild-reviews.yml shape)', () => {
  const fixture = `name: Dir prefix via -u
on:
  push:
jobs:
  rebuild:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add -u data/audit/ 2>/dev/null || true
          git commit -m 'x'
`;
  assert.deepEqual(findMissingLedgerCommits(fixture), []);
});

test('clean: git-add-existing.sh with a bare covering directory arg (llm-ensemble-score.yml shape)', () => {
  const fixture = `name: Dir prefix via git-add-existing.sh
on:
  push:
jobs:
  ensemble:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          bash scripts/lib/git-add-existing.sh data/collection-state/ data/audit/
          git commit -m 'x'
`;
  assert.deepEqual(findMissingLedgerCommits(fixture), []);
});

// opening-night-express.yml's real shape: `git add data/audit/*.json` covers
// the .json ledger file at actual shell-glob-expansion runtime, but this
// checker deliberately does NOT evaluate glob semantics (same conservative
// choice as scripts/lib/ledger-coverage-check.js) — a glob operand must
// still be treated as non-covering.
test('still flags a job whose only "coverage" is a glob operand', () => {
  const fixture = `name: Glob does not count
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add data/audit/*.json 2>/dev/null || true
          git commit -m 'x'
`;
  const violations = findMissingLedgerCommits(fixture);
  assert.equal(violations.length, 2);
});

// Regression (ship-check/Codex adversarial review): `-A`/`.` must be the
// ONLY token on the git add line. `git add -A src/` or `git add . public/`
// scope the add to that pathspec — they do NOT stage the whole worktree —
// so treating any line merely containing `-A`/`.` as broad coverage would
// wrongly clear a job whose add never touches data/audit/ at all.
test('still flags a job whose `git add -A <path>` is scoped to an unrelated pathspec', () => {
  const fixture = `name: Scoped -A does not count as broad
on:
  push:
jobs:
  broken:
    runs-on: ubuntu-latest
    steps:
      - name: Alert
        run: |
          node -e "require('./scripts/lib/owner-alert-router.js').resolveCondition('x')"
      - name: Commit
        run: |
          git add -A src/
          git commit -m 'x'
`;
  const violations = findMissingLedgerCommits(fixture);
  assert.equal(violations.length, 2);
});
