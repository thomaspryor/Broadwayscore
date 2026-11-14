/**
 * BRO-2129 — push-with-retry.sh's content-survival check false-positived
 * ("[content-survival] FAILED — N file(s) silently REVERTED") on a clean
 * rebase of a tiny commit under heavy main churn.
 *
 * Root cause: SCRIPT_ENTRY_BASE was merge-base(HEAD, LOCAL origin/main) with no
 * fetch. With a stale local origin ref the base is old, so base..HEAD also holds
 * foreign main commits already merged into the branch; push-content-survival.js
 * counted those foreign lines as "ours", and once main rewrote them the check
 * reported content that was never ours as reverted — on every retry.
 *
 * Fixture: runner branch contains foreign commit M1 (b.mjs line 30) but the
 * runner's refs/remotes/origin/main still points at the pre-M1 commit. Main then
 * gets M2 (rewrites line 30) before our push, and a post-receive hook lands an
 * unrelated churn commit on b.mjs right after our push (so the pushed blob !=
 * final blob, which rules out the "superseded" downgrade).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(fileURLToPath(new URL('../../scripts/lib/push-with-retry.sh', import.meta.url)));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t',
  GITHUB_ACTIONS: '',
};

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', env: ENV }).toString();

function edit(dir, file, from, to) {
  const p = path.join(dir, file);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(new RegExp(`^${from}$`, 'm'), to));
}

// fastForward=false: M2 lands before our push (rejected push -> loop fetch path).
// fastForward=true: no M2, attempt 1 pushes cleanly as a fast-forward and the
// churn commit rewrites the foreign M1 line itself right after our push.
for (const fastForward of [false, true]) {
test(`stale local origin ref + main churn does not flag foreign lines as reverted (${fastForward ? 'first-attempt fast-forward' : 'rejected push, loop fetch'})`, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-survival-fp-'));
  try {
    const origin = path.join(tmp, 'origin.git');
    const seed = path.join(tmp, 'seed');
    const runner = path.join(tmp, 'runner');
    const churner = path.join(tmp, 'churner');
    const nums = Array.from({ length: 40 }, (_, i) => i + 1).join('\n') + '\n';

    sh(`git init -q --bare -b main "${origin}"`, tmp);
    sh(`git init -q "${seed}"`, tmp);
    sh('git branch -M main', seed);
    fs.writeFileSync(path.join(seed, 'a.js'), nums);
    fs.writeFileSync(path.join(seed, 'b.mjs'), nums);
    sh('git add -A && git commit -qm base', seed);
    sh(`git push -q "${origin}" main`, seed);
    sh(`git clone -q -b main "${origin}" runner`, tmp);
    sh(`git clone -q -b main "${origin}" churner`, tmp);

    // M1 lands on main; the runner pulls it into its branch but its
    // refs/remotes/origin/main is left at the pre-M1 commit (stale).
    edit(seed, 'b.mjs', '30', '30-m1');
    sh('git commit -qam m1', seed);
    sh(`git push -q "${origin}" main`, seed);
    const m0 = sh('git rev-parse origin/main', runner).trim();
    sh('git fetch -q origin main:refs/heads/tmp', runner);
    sh(`git update-ref refs/remotes/origin/main ${m0}`, runner);
    sh('git checkout -q -b job/x tmp', runner);

    if (!fastForward) {
      // M2 rewrites M1's line on main.
      edit(seed, 'b.mjs', '30-m1', '30-m2');
      sh('git commit -qam m2', seed);
      sh(`git push -q "${origin}" main`, seed);
    }

    // Our tiny commit: two files, one line each.
    edit(runner, 'a.js', '20', '20-edited');
    edit(runner, 'b.mjs', '5', '5-edited');
    sh('git commit -qam "our edit"', runner);

    // Repo-local hooksPath: a global core.hooksPath (CI/husky) would otherwise
    // silently stop this fixture's hook from running.
    sh(`git config core.hooksPath "${origin}/hooks"`, origin);

    // Churn landing right after our push, rewriting another line of b.mjs.
    fs.writeFileSync(path.join(origin, 'hooks', 'post-receive'), `#!/usr/bin/env bash
cat >/dev/null
if [ ! -f "${tmp}/churned" ]; then
  touch "${tmp}/churned"
  unset GIT_DIR GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
  cd "${churner}" && git pull -q --rebase origin main && sed -i.bak -e 's/^35$/35-churn/' -e 's/^30-m1$/30-m1-churn/' b.mjs && rm -f b.mjs.bak \\
    && git commit -qam churn && git push -q origin main \\
    || echo "churn failed" >> "${tmp}/churn.log"
fi
`, { mode: 0o755 });

    const r = spawnSync('bash', [SCRIPT, '3', 'main'], { cwd: runner, env: ENV, encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    assert.doesNotMatch(out, /\[content-survival\] FAILED/, out);
    assert.equal(r.status, 0, out);

    assert.ok(fs.existsSync(`${tmp}/churned`), 'post-receive churn hook never ran\n' + out);
    const finalB = sh('git show main:b.mjs', origin);
    const finalA = sh('git show main:a.js', origin);
    assert.match(finalB, /^5-edited$/m);
    assert.match(finalA, /^20-edited$/m);
    assert.match(finalB, fastForward ? /^30-m1-churn$/m : /^30-m2$/m, 'foreign content must be untouched: ' + (fs.existsSync(`${tmp}/churn.log`) ? fs.readFileSync(`${tmp}/churn.log`, 'utf8') : 'churn ran'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
}
