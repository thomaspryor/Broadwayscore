/**
 * BRO-2783: rebuild-fast.yml's push could lose all 20 push-with-retry.sh races
 * against a hot main and strand a fully scored rebuild (opening night
 * 2026-09-04). Board option (b): after a lost race, reset to fresh origin/main,
 * redo the fast rebuild, push again — bounded, jittered outer cycles.
 *
 * Pure decisions: scripts/lib/rebuild-fast-push-cycle.js (require()d below).
 * The loop: scripts/lib/rebuild-fast-push-cycle.sh, run for real against a
 * local bare repo with a competing writer, together with the real
 * scripts/rebuild-fast-redo.sh + scripts/rebuild-fast-stage-commit.sh. Only the
 * two expensive edges are injected: PUSH_CMD (a 20-attempt pusher that really
 * pushes and really loses while the competitor keeps landing commits) and
 * REBUILD_FAST_REGEN_CMD (stands in for rebuild-all-reviews.js +
 * generate-mobile-artifacts.sh, which need the private corpus).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cycle = require(path.join(REPO, 'scripts/lib/rebuild-fast-push-cycle.js'));
const LOOP = path.join(REPO, 'scripts/lib/rebuild-fast-push-cycle.sh');
const REDO = path.join(REPO, 'scripts/rebuild-fast-redo.sh');
const WORKFLOW = path.join(REPO, '.github/workflows/rebuild-fast.yml');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
  GIT_CONFIG_NOSYSTEM: '1', GITHUB_ACTIONS: '',
};
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } }).toString();
const write = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

describe('decision helper (pure)', () => {
  test('push success is done; hook rejection fails immediately; other losses redo until the budget ends', () => {
    assert.equal(cycle.decideAfterPush({ pushExit: 0, cycle: 1, maxCycles: 3 }).action, 'done');
    assert.equal(cycle.decideAfterPush({ pushExit: 4, cycle: 1, maxCycles: 3 }).action, 'fail');
    assert.equal(cycle.decideAfterPush({ pushExit: 1, cycle: 1, maxCycles: 3 }).action, 'redo');
    assert.equal(cycle.decideAfterPush({ pushExit: 1, cycle: 2, maxCycles: 3 }).action, 'redo');
    assert.equal(cycle.decideAfterPush({ pushExit: 1, cycle: 3, maxCycles: 3 }).action, 'fail');
    assert.equal(cycle.decideAfterPush({ pushExit: 124, cycle: 1, maxCycles: 3 }).action, 'redo');
  });

  test('budget is always bounded: default, clamp to hard cap, garbage fails closed', () => {
    assert.equal(cycle.resolveMaxCycles(undefined), cycle.DEFAULT_MAX_CYCLES);
    assert.equal(cycle.resolveMaxCycles('abc'), cycle.DEFAULT_MAX_CYCLES);
    assert.equal(cycle.resolveMaxCycles('0'), 1);
    assert.equal(cycle.resolveMaxCycles('1000000'), cycle.HARD_MAX_CYCLES);
    assert.equal(cycle.decideAfterPush({ pushExit: 1, cycle: cycle.HARD_MAX_CYCLES, maxCycles: 999 }).action, 'fail');
    assert.equal(cycle.decideAfterPush({ pushExit: 'x', cycle: 1, maxCycles: 3 }).action, 'fail');
    assert.equal(cycle.decideAfterPush({ pushExit: 1, cycle: 'nan', maxCycles: 3 }).action, 'fail');
  });

  test('after-redo: 0 pushes, 3 (nothing to commit) is done, anything else fails', () => {
    assert.equal(cycle.decideAfterRedo({ redoExit: 0 }).action, 'push');
    assert.equal(cycle.decideAfterRedo({ redoExit: 3 }).action, 'done');
    assert.equal(cycle.decideAfterRedo({ redoExit: 1 }).action, 'fail');
    assert.equal(cycle.decideAfterRedo({ redoExit: '' }).action, 'fail');
  });

  test('jitter stays within [0, cap] and grows with the cycle', () => {
    for (const r of [0, 0.5, 0.999999]) {
      for (const c of [1, 2, 5]) {
        const d = cycle.jitterDelaySec({ cycle: c, maxSec: 20, rand: () => r });
        assert.ok(d >= 0 && d <= 20, `delay ${d} out of range`);
      }
    }
    assert.ok(cycle.jitterDelaySec({ cycle: 3, maxSec: 20, rand: () => 0 })
      > cycle.jitterDelaySec({ cycle: 1, maxSec: 20, rand: () => 0 }));
    assert.equal(cycle.jitterDelaySec({ cycle: 3, maxSec: 0, rand: () => 0.9 }), 0);
  });
});

/**
 * origin (bare) <- seed; runner = depth-1 clone (like actions/checkout);
 * competitor = separate clone that keeps landing commits on hot files.
 */
function setupFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-fast-retry-'));
  const origin = path.join(tmp, 'origin.git');
  const seed = path.join(tmp, 'seed');
  const runner = path.join(tmp, 'runner');
  const competitor = path.join(tmp, 'competitor');
  sh(`git init -q --bare "${origin}"`, tmp);
  sh(`git -C "${origin}" symbolic-ref HEAD refs/heads/main`, tmp);
  fs.mkdirSync(seed);
  sh('git init -q -b main', seed);
  write(path.join(seed, '.gitignore'), 'inputs/\n');
  write(path.join(seed, 'public/data/shows/show-a.json'), JSON.stringify({ id: 'show-a', reviews: 10 }) + '\n');
  write(path.join(seed, 'public/data/shows/show-b.json'), JSON.stringify({ id: 'show-b', reviews: 5 }) + '\n');
  write(path.join(seed, 'data/audit/hot-ledger.jsonl'), '{"n":0}\n');
  write(path.join(seed, 'data/audit/orphan-unscored-show-c.json'), '{"show":"show-c"}\n');
  // Union-merged alert ledger (real registry merger) + two plain state files.
  write(path.join(seed, 'data/audit/alert-ledger.json'), JSON.stringify({
    conditions: { seed: { status: 'open', lastSeen: '2026-10-01T00:00:00.000Z' } },
  }, null, 2) + '\n');
  write(path.join(seed, 'data/audit/verify-all-scored-state.json'), '{"run":"seed"}\n');
  write(path.join(seed, 'data/audit/critic-outlets-baseline.json'), '{"outlets":1}\n');
  sh('git add -A && git commit -q -m base', seed);
  sh(`git push -q "${origin}" main`, seed);
  sh(`git clone -q --depth=1 --branch main "file://${origin}" "${runner}"`, tmp);
  sh(`git clone -q "file://${origin}" "${competitor}"`, tmp);

  // The scored rebuild input (stands in for the private core data, which a
  // reset of the public checkout never touches): show-a now has 13 reviews.
  // show-b's job-start input is unchanged (5), so the first pass does not
  // touch it; the regen still rewrites EVERY show, like the real one.
  write(path.join(runner, 'inputs/show-a.count'), '13\n');
  write(path.join(runner, 'inputs/show-b.count'), '5\n');
  const regen = path.join(tmp, 'regen.sh');
  write(regen, `#!/usr/bin/env bash
set -euo pipefail
n=$(cat inputs/show-a.count)
printf '{"id":"show-a","reviews":%s}\\n' "$n" > public/data/shows/show-a.json
printf '{"id":"show-b","reviews":%s}\\n' "$(cat inputs/show-b.count)" > public/data/shows/show-b.json
echo "{\\"show\\":\\"show-a\\"}" > data/audit/orphan-unscored-show-a.json
rm -f data/audit/orphan-unscored-show-c.json
`);
  // Competing writer: lands one commit per call on hot files (never show-a).
  const compete = path.join(tmp, 'compete.sh');
  write(compete, `#!/usr/bin/env bash
set -euo pipefail
cd "${competitor}"
git pull -q --rebase origin main
n=$(( $(wc -l < data/audit/hot-ledger.jsonl) ))
echo "{\\"n\\":$n}" >> data/audit/hot-ledger.jsonl
printf '{"id":"show-b","reviews":%s}\\n' "$((5 + n))" > public/data/shows/show-b.json
node -e '
const fs = require("fs"); const f = "data/audit/alert-ledger.json";
const l = JSON.parse(fs.readFileSync(f, "utf8"));
l.conditions["comp-" + process.argv[1]] = { status: "open", lastSeen: new Date().toISOString() };
fs.writeFileSync(f, JSON.stringify(l, null, 2) + "\\n"); /* test-data-write-guard-allow: temp competitor clone */' "$n"
echo "{\\"run\\":\\"comp-$n\\"}" > data/audit/verify-all-scored-state.json
git add -A && git commit -q -m "competitor $n" && git push -q origin HEAD:main
`);
  // Replays one push-with-retry.sh budget of 20 attempts: before each
  // attempt the competitor lands a commit while it still has races left
  // (counter file), so every attempt is a real non-fast-forward rejection.
  // With the "forever" marker the competitor lands one commit per cycle
  // instead (the pusher never fetches, so all 20 attempts still reject);
  // that keeps the never-ending-contention tests fast.
  const pusher = path.join(tmp, 'pusher.sh');
  const races = path.join(tmp, 'races-left');
  const attempts = path.join(tmp, 'attempts');
  write(pusher, `#!/usr/bin/env bash
set -uo pipefail
echo "cycle-push" >> "${path.join(tmp, 'push-invocations')}"
for i in $(seq 1 20); do
  left=$(cat "${races}")
  if [ "$left" = forever ]; then
    [ "$i" -eq 1 ] && bash "${compete}" >/dev/null
  elif [ "$left" -gt 0 ]; then bash "${compete}" >/dev/null; echo $((left - 1)) > "${races}"; fi
  echo x >> "${attempts}"
  if git push -q origin HEAD:main 2>/dev/null; then exit 0; fi
done
echo "All push attempts failed after 20 attempts" >&2
exit 1
`);
  for (const f of [regen, compete, pusher]) fs.chmodSync(f, 0o755);
  for (const [k, v] of [['user.email', 't@t.t'], ['user.name', 't']]) sh(`git config ${k} ${v}`, runner);
  return { tmp, origin, runner, competitor, regen, pusher, races, attempts };
}

function firstPassCommit(fx) {
  // What the workflow's first pass does: regenerate, the alert router /
  // verify-all-scored write their data/audit state (NOT re-run by the redo),
  // then the real stage+commit.
  sh(`bash "${fx.regen}"`, fx.runner);
  const ledgerPath = path.join(fx.runner, 'data/audit/alert-ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  ledger.conditions['ours-row'] = { status: 'open', lastSeen: '2026-10-12T00:00:00.000Z' };
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n'); // test-data-write-guard-allow: temp runner clone
  write(path.join(fx.runner, 'data/audit/verify-all-scored-state.json'), '{"run":"ours"}\n');
  write(path.join(fx.runner, 'data/audit/critic-outlets-baseline.json'), '{"outlets":2}\n');
  const r = spawnSync('bash', [path.join(REPO, 'scripts/rebuild-fast-stage-commit.sh')], {
    cwd: fx.runner, env: { ...process.env, ...GIT_ENV, REVIEWS_BEFORE: '10', REVIEWS_AFTER: '13', REBUILD_REASON: 'test' },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}

function runLoop(fx, extraEnv = {}) {
  return spawnSync('bash', [LOOP], {
    cwd: fx.runner,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env, ...GIT_ENV,
      PUSH_CMD: `bash "${fx.pusher}"`,
      REBUILD_FAST_REDO_CMD: `bash "${REDO}"`,
      REBUILD_FAST_REGEN_CMD: `bash "${fx.regen}"`,
      REBUILD_FAST_SAFE_TO_PUBLISH: 'true',
      REBUILD_FAST_JITTER_MAX_SEC: '0',
      REVIEWS_BEFORE: '10', REVIEWS_AFTER: '13', REBUILD_REASON: 'test',
      ...extraEnv,
    },
  });
}

const originFile = (fx, p) => sh(`git --git-dir="${fx.origin}" show main:${p}`, fx.tmp);
const originHas = (fx, p) => spawnSync('git', [`--git-dir=${fx.origin}`, 'cat-file', '-e', `main:${p}`]).status === 0;
const lines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length : 0);

describe('replayed contention against a local bare repo', () => {
  test('a push that loses all 20 races still lands its +N reviews within one redo cycle', () => {
    const fx = setupFixture();
    try {
      firstPassCommit(fx);
      fs.writeFileSync(fx.races, '20\n'); // competitor wins exactly the first 20 races
      const r = runLoop(fx);
      const out = r.stdout + r.stderr;
      assert.equal(r.status, 0, out);
      assert.equal(lines(fx.attempts), 21, `expected 20 lost attempts + 1 landing attempt\n${out}`);
      assert.equal(lines(path.join(fx.tmp, 'push-invocations')), 2, 'landed on the 2nd cycle (one redo)');
      assert.match(out, /lost its push race/);
      assert.match(out, /landed on cycle 2/);

      // +3 reviews for show-a landed on origin...
      assert.deepEqual(JSON.parse(originFile(fx, 'public/data/shows/show-a.json')), { id: 'show-a', reviews: 13 });
      assert.match(sh(`git --git-dir="${fx.origin}" log -1 --format=%B main`, fx.tmp), /\(\+3 reviews\)/);
      // ...on top of all 20 competitor commits, none of which were clobbered.
      assert.equal(originFile(fx, 'data/audit/hot-ledger.jsonl').trim().split('\n').length, 21);
      // (a) show-b: the redo's regen rewrote it from this job's stale input
      // (5 reviews) but it is not in the lost commit, so the competitor's
      // newer file (25) survives un-reverted.
      assert.deepEqual(JSON.parse(originFile(fx, 'public/data/shows/show-b.json')), { id: 'show-b', reviews: 25 },
        'redo reverted a show file another writer updated on fresh main');
      assert.match(out, /kept main's version: public\/data\/shows\/show-b\.json/);
      // The redo carried the lost commit's orphan-marker add AND delete.
      assert.ok(originHas(fx, 'data/audit/orphan-unscored-show-a.json'));
      assert.ok(!originHas(fx, 'data/audit/orphan-unscored-show-c.json'));
      // (b) alert ledger: the lost commit's row AND every competitor row survive
      // (conflicting hunks resolved by the registry's 3-way merger).
      const conds = JSON.parse(originFile(fx, 'data/audit/alert-ledger.json')).conditions;
      assert.ok(conds['ours-row'], 'lost commit\'s ledger row was dropped by the redo');
      for (let n = 1; n <= 20; n++) assert.ok(conds[`comp-${n}`], `competitor ledger row comp-${n} was clobbered`);
      assert.ok(conds.seed);
      assert.match(out, /merged: data\/audit\/alert-ledger\.json/);
      // A state file only this run changed is replayed cleanly...
      assert.deepEqual(JSON.parse(originFile(fx, 'data/audit/critic-outlets-baseline.json')), { outlets: 2 });
      // ...and one both sides changed, with no merger, keeps main's copy (never ours blindly).
      assert.deepEqual(JSON.parse(originFile(fx, 'data/audit/verify-all-scored-state.json')), { run: 'comp-20' });
      assert.match(out, /verify-all-scored-state\.json conflicts with fresh main/);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('the loop is bounded: a competitor that never stops gets exactly MAX_CYCLES pushes, then a non-zero exit', () => {
    const fx = setupFixture();
    try {
      firstPassCommit(fx);
      fs.writeFileSync(fx.races, 'forever\n');
      const r = runLoop(fx, { REBUILD_FAST_MAX_CYCLES: '3' });
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
      assert.equal(lines(path.join(fx.tmp, 'push-invocations')), 3);
      assert.equal(lines(fx.attempts), 60);
      assert.match(r.stdout + r.stderr, /failed for good after 3\/3 cycle/);
      assert.deepEqual(JSON.parse(originFile(fx, 'public/data/shows/show-a.json')), { id: 'show-a', reviews: 10 });
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('an absurd REBUILD_FAST_MAX_CYCLES is clamped to the hard cap', () => {
    const fx = setupFixture();
    try {
      firstPassCommit(fx);
      fs.writeFileSync(fx.races, 'forever\n');
      const r = runLoop(fx, { REBUILD_FAST_MAX_CYCLES: '999' });
      assert.notEqual(r.status, 0);
      assert.equal(lines(path.join(fx.tmp, 'push-invocations')), cycle.HARD_MAX_CYCLES);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('the redo refuses (no push) when the staleness guard did not clear the run', () => {
    const fx = setupFixture();
    try {
      firstPassCommit(fx);
      fs.writeFileSync(fx.races, '20\n');
      const r = runLoop(fx, { REBUILD_FAST_SAFE_TO_PUBLISH: 'false' });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout + r.stderr, /redo refused/);
      assert.equal(lines(path.join(fx.tmp, 'push-invocations')), 1);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('lost commit identity (third review, HIGH)', () => {
  test('a push that fails leaving a merge commit as HEAD: the redo still replays the pre-push commit', () => {
    const fx = setupFixture();
    try {
      firstPassCommit(fx);
      const ours = sh('git rev-parse HEAD', fx.runner).trim();
      // push-with-retry.sh's merge fallback: the competitor lands, the pusher
      // `merge -X ours`es origin/main into HEAD, still loses, exits 1 with the
      // merge commit M as HEAD (restore_head_if_moved keeps a descendant).
      // Second cycle: a plain push that lands.
      const mergingPusher = path.join(fx.tmp, 'merging-pusher.sh');
      const calls = path.join(fx.tmp, 'push-invocations');
      write(mergingPusher, `#!/usr/bin/env bash
set -uo pipefail
echo "cycle-push" >> "${calls}"
if [ "$(wc -l < "${calls}")" -eq 1 ]; then
  echo 1 > "${fx.races}"
  bash "${path.join(fx.tmp, 'compete.sh')}" >/dev/null
  git fetch -q origin main
  git merge -q --no-edit -X ours FETCH_HEAD >/dev/null
  exit 1
fi
git push -q origin HEAD:main
`);
      fs.chmodSync(mergingPusher, 0o755);
      const r = runLoop(fx, { PUSH_CMD: `bash "${mergingPusher}"` });
      const out = r.stdout + r.stderr;
      assert.equal(r.status, 0, out);
      assert.match(out, new RegExp(`using the pre-push commit ${ours} as the lost commit`));
      assert.match(out, new RegExp(`lost commit ${ours}`));
      // This run's own changes landed (with M^..M they would have been dropped)...
      assert.deepEqual(JSON.parse(originFile(fx, 'public/data/shows/show-a.json')), { id: 'show-a', reviews: 13 });
      assert.ok(JSON.parse(originFile(fx, 'data/audit/alert-ledger.json')).conditions['ours-row']);
      assert.ok(originHas(fx, 'data/audit/orphan-unscored-show-a.json'));
      // ...and the competitor's newer show-b was not republished from a stale copy.
      assert.deepEqual(JSON.parse(originFile(fx, 'public/data/shows/show-b.json')), { id: 'show-b', reviews: 6 });
      assert.equal(originFile(fx, 'data/audit/hot-ledger.jsonl').trim().split('\n').length, 2);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  test('the redo refuses a merge commit as the lost commit', () => {
    const fx = setupFixture();
    try {
      firstPassCommit(fx);
      fs.writeFileSync(fx.races, '1\n');
      sh(`bash "${path.join(fx.tmp, 'compete.sh')}"`, fx.tmp);
      sh('git fetch -q origin main && git merge -q --no-edit -X ours FETCH_HEAD', fx.runner);
      const merge = sh('git rev-parse HEAD', fx.runner).trim();
      const r = spawnSync('bash', [REDO], {
        cwd: fx.runner, encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV, REBUILD_FAST_SAFE_TO_PUBLISH: 'true', REBUILD_FAST_LOST_COMMIT: merge, REBUILD_FAST_REGEN_CMD: 'true' },
      });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /is a merge commit/);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('replay-audit validates a clean apply (third review, MEDIUM)', () => {
  test('a clean `git apply -3` that yields invalid JSON falls back to main\'s copy', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-fast-replay-'));
    try {
      sh('git init -q -b main', tmp);
      const f = 'data/audit/some-state.json';
      write(path.join(tmp, f), '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n');
      write(path.join(tmp, 'data/audit/ok-state.json'), '{"ok":1}\n');
      sh('git add -A && git commit -q -m base', tmp);
      // The lost commit: its edit to some-state.json is not valid JSON (a dropped
      // comma); ok-state.json is a normal, valid edit.
      write(path.join(tmp, f), '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4\n  "e": 6\n}\n');
      write(path.join(tmp, 'data/audit/ok-state.json'), '{"ok":2}\n');
      sh('git add -A && git commit -q -m lost', tmp);
      const lost = sh('git rev-parse HEAD', tmp).trim();
      // Fresh main: another writer changed a non-adjacent line, so apply -3 is clean.
      sh('git reset -q --hard HEAD^', tmp);
      write(path.join(tmp, f), '{\n  "a": 100,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n');
      sh('git add -A && git commit -q -m other-writer', tmp);
      const head = fs.readFileSync(path.join(tmp, f), 'utf8');
      const r = spawnSync('node', [path.join(REPO, 'scripts/lib/rebuild-fast-replay-audit.js'), lost], { cwd: tmp, encoding: 'utf8' });
      const out = r.stdout + r.stderr;
      assert.equal(r.status, 0, out);
      assert.match(out, /clean apply of data\/audit\/some-state\.json produced invalid json/);
      assert.match(out, /kept-remote: data\/audit\/some-state\.json/);
      assert.equal(fs.readFileSync(path.join(tmp, f), 'utf8'), head, 'invalid JSON was left in place');
      assert.equal(sh(`git diff --cached --name-only -- ${f}`, tmp).trim(), '', 'invalid JSON was left staged');
      assert.match(out, /applied: data\/audit\/ok-state\.json/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'data/audit/ok-state.json'), 'utf8')), { ok: 2 });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

describe('rebuild-fast.yml wiring', () => {
  test('the push step runs the bounded cycle with the redo, fail-closed on the staleness verdict', () => {
    const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
    const step = doc.jobs['rebuild-fast'].steps.find((s) => s.name === 'Commit and push changes');
    assert.ok(step);
    assert.match(step.run, /scripts\/lib\/rebuild-fast-push-cycle\.sh/);
    assert.match(step.run, /REBUILD_FAST_REDO_CMD="bash scripts\/rebuild-fast-redo\.sh"/);
    assert.match(step.run, /scripts\/rebuild-fast-stage-commit\.sh/);
    assert.equal(step.env.REBUILD_FAST_SAFE_TO_PUBLISH, '${{ steps.staleness.outputs.safe_to_publish }}');
    const max = Number(step.env.REBUILD_FAST_MAX_CYCLES);
    assert.ok(max >= 2 && max <= cycle.HARD_MAX_CYCLES, `REBUILD_FAST_MAX_CYCLES=${max}`);
    // Worst case must fit the job timeout WITH margin for the always() steps
    // after the push: ~600s of earlier steps + first push deadline + per redo
    // (jitter 20s + fetch 30s + ~180s rebuild + redo push deadline) + ~300s of
    // post-push steps (core-data push, deploy trigger, failure notify), and at
    // least 5 min spare (mirrors the job's timeout-minutes comment).
    const worstSec = 600 + Number(step.env.PUSH_DEADLINE_SEC)
      + (max - 1) * (20 + 30 + 180 + Number(step.env.REBUILD_FAST_REDO_PUSH_DEADLINE_SEC)) + 300;
    assert.ok(worstSec + 300 <= doc.jobs['rebuild-fast']['timeout-minutes'] * 60,
      `worst case ${worstSec}s (+300s margin) exceeds timeout-minutes`);
  });
});

describe('staging lists stay in lockstep', () => {
  // The workflow stages inline (its lints read staging from the YAML) and the
  // redo stages via rebuild-fast-stage-commit.sh. Drift would make a redo
  // publish a different set of files than the first pass.
  const addLines = (text) => text.split('\n')
    .map((l) => l.trim())
    .filter((l) => !l.startsWith('#') && /(\bgit add\b|git-add-existing\.sh)/.test(l))
    .map((l) => l.replace(/^bash\s+("\$SCRIPT_DIR\/lib\/|scripts\/lib\/)/, 'bash scripts/lib/').replace(/"(?=\s|$)/, ''))
    .sort();
  test('every git add in the workflow push step is in rebuild-fast-stage-commit.sh and vice versa', () => {
    const doc = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));
    const step = doc.jobs['rebuild-fast'].steps.find((s) => s.name === 'Commit and push changes');
    const script = fs.readFileSync(path.join(REPO, 'scripts/rebuild-fast-stage-commit.sh'), 'utf8');
    const wf = addLines(step.run);
    assert.ok(wf.length >= 8, `expected the workflow's staging lines, got ${wf.length}`);
    assert.deepEqual(addLines(script), wf);
  });
});

describe('commit message review counts', () => {
  const commitWith = (env) => {
    const fx = setupFixture();
    try {
      sh(`bash "${fx.regen}"`, fx.runner);
      const r = spawnSync('bash', [path.join(REPO, 'scripts/rebuild-fast-stage-commit.sh')], {
        cwd: fx.runner, env: { ...process.env, ...GIT_ENV, REBUILD_REASON: 'test', ...env }, encoding: 'utf8',
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return sh('git log -1 --format=%B', fx.runner);
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  };

  test('measured counts report the delta', () => {
    const msg = commitWith({ REVIEWS_BEFORE: '10', REVIEWS_AFTER: '13' });
    assert.match(msg, /^data: Fast rebuild - test \(\+3 reviews\)/);
    assert.match(msg, /Reviews: 10 → 13/);
  });

  test('an unmeasured after-count is not reported as a drop to 0 (288ec4cb7)', () => {
    const msg = commitWith({ REVIEWS_BEFORE: '28702', REVIEWS_AFTER: '' });
    assert.match(msg, /^data: Fast rebuild - test\n/);
    assert.doesNotMatch(msg, /→ 0|-28702/);
    assert.match(msg, /count not measured \(before=28702, after=unset\)/);
  });

  test('a drop is reported with its negative delta', () => {
    const msg = commitWith({ REVIEWS_BEFORE: '20', REVIEWS_AFTER: '15' });
    assert.match(msg, /^data: Fast rebuild - test \(-5 reviews\)/);
    assert.match(msg, /Reviews: 20 → 15/);
  });

  test('an unmeasured before-count is not reported as a gain from 0', () => {
    const msg = commitWith({ REVIEWS_BEFORE: '', REVIEWS_AFTER: '28702' });
    assert.doesNotMatch(msg, /\+28702/);
    assert.match(msg, /count not measured \(before=unset, after=28702\)/);
  });
});
