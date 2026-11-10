// Fault-injection tests for review-texts-checkpoint.js (BRO-7171 Stage 1).
// Real git: a temp bare origin named like the production repo (push-with-retry
// switches to review-texts mode on that name), our writer's clone, a "CI"
// clone that pushes between our commit and our push, and the real
// push-with-retry.sh. Nothing touches ~/broadway-review-texts.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_PUSH = path.join(HERE, 'push-with-retry.sh');

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rt-checkpoint-')));
process.env.REVIEW_TEXTS_LOCK_PATH = path.join(ROOT, 'review-texts.lock');
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@example.com',
  PUSH_SKIP_LEDGER: '1', PUSH_SKIP_FAILURE_LEDGER: '1', PUSH_SKIP_UNSHALLOW: '1',
  PUSH_API_FALLBACK_DISABLE: '1', PUSH_RESCUE_DISABLE: '1', PUSH_SKIP_STALL_DIAGNOSTICS: '1',
  PUSH_FAILURE_LOG: path.join(ROOT, 'push-failures.jsonl'),
  PUSH_DEADLINE_SEC: '60',
});

const { checkpointReviewTexts, retryPendingPushes, ReviewTextsPushError, ReviewTextsLandingError, readPending, contentKey, createWriteTracker } = require('./review-texts-checkpoint.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const review = (fullText, extra = {}) => JSON.stringify({ showId: 'show-2026', fullText, ...extra }, null, 2) + '\n';

let n = 0;
/** Fresh origin + our clone + CI clone, and a push wrapper that can inject a CI commit. */
function setup() {
  const dir = path.join(ROOT, `case-${++n}`);
  fs.mkdirSync(dir);
  const origin = path.join(dir, 'broadway-review-texts.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(dir, 'seed');
  git(dir, 'clone', '-q', origin, seed);
  fs.mkdirSync(path.join(seed, 'show-2026'));
  fs.writeFileSync(path.join(seed, 'show-2026', 'nytimes--a.json'), review('stub text'));
  fs.writeFileSync(path.join(seed, 'show-2026', 'variety--b.json'), review('other stub'));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const local = path.join(dir, 'local');
  const ci = path.join(dir, 'ci');
  git(dir, 'clone', '-q', origin, local);
  git(dir, 'clone', '-q', origin, ci);
  // The wrapper runs a CI-side commit+push (when INJECT points at a script)
  // after our commit exists and before our push: the race this module must survive.
  const pushScript = path.join(dir, 'push-wrapper.sh');
  fs.writeFileSync(pushScript, `#!/bin/bash\nif [ -n "$INJECT" ] && [ ! -e "$INJECT.done" ]; then bash "$INJECT" || exit 97; touch "$INJECT.done"; fi\nexec bash "${REAL_PUSH}" "$@"\n`);
  const pendingPath = path.join(dir, 'pending.json');
  return { dir, origin, local, ci, pushScript, pendingPath, file: path.join(local, 'show-2026', 'nytimes--a.json') };
}

/** A CI commit to `rel` (in the CI clone), pushed to origin when the wrapper runs it. */
function ciInjection(env, rel, content) {
  const script = path.join(env.dir, `inject-${path.basename(rel)}.sh`);
  const target = path.join(env.ci, rel);
  const body = path.join(env.dir, `inject-${path.basename(rel)}.body`);
  fs.writeFileSync(body, content);
  fs.writeFileSync(script, `set -e\ncd "${env.ci}"\ngit pull -q --rebase origin main\ncp "${body}" "${target}"\ngit add -A\ngit commit -q -m "data: Rebuild reviews.json (CI)"\ngit push -q origin HEAD:main\n`);
  return script;
}

const originHas = (env, rel) => { try { return git(env.origin, 'show', `main:${rel}`); } catch { return null; } };
const REL = 'show-2026/nytimes--a.json';
const RECOVERED = 'Recovered full review text. '.repeat(40);

before(() => {
  assert.ok(fs.existsSync(REAL_PUSH), 'push-with-retry.sh must exist');
});

test('CI commit lands between our commit and our push: nothing lost, onLanded only after the text is on origin', () => {
  const env = setup();
  fs.writeFileSync(env.file, review(RECOVERED));
  const landedCalls = [];
  const res = checkpointReviewTexts({
    repoDir: env.local,
    paths: [env.file],
    message: 'feat: test recovery',
    pendingPath: env.pendingPath,
    pushScript: env.pushScript,
    pushEnv: { INJECT: ciInjection(env, 'show-2026/variety--b.json', review('CI rebuilt text')) },
    onLanded: (l) => {
      // 'recovered' may only be recorded once origin really holds our text.
      const remote = originHas(env, l.path);
      landedCalls.push({ path: l.path, onOrigin: remote !== null && contentKey(remote) === l.fullTextHash });
    },
  });
  assert.equal(res.pushed, true);
  assert.deepEqual(landedCalls, [{ path: REL, onOrigin: true }]);
  assert.equal(JSON.parse(originHas(env, REL)).fullText, RECOVERED, 'our recovered text is on origin');
  assert.equal(JSON.parse(originHas(env, 'show-2026/variety--b.json')).fullText, 'CI rebuilt text', "CI's commit survived");
  assert.deepEqual(readPending(env.pendingPath), [], 'pending entry cleared once landed');
});

test('CI commit edits the SAME review file before our push: landed is reported only if origin holds our text', () => {
  const env = setup();
  fs.writeFileSync(env.file, review(RECOVERED));
  const calls = [];
  let res;
  try {
    res = checkpointReviewTexts({
      repoDir: env.local, paths: [env.file], message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript,
      pushEnv: { INJECT: ciInjection(env, REL, review('stub text', { llmScore: { score: 70 } })) },
      onLanded: (l) => calls.push(l),
    });
  } catch (e) {
    // A conflict push-with-retry cannot resolve is a hard failure, never a silent landed.
    assert.ok(e instanceof ReviewTextsPushError, e.message);
    assert.deepEqual(calls, []);
    assert.equal(readPending(env.pendingPath).length, 1);
    return;
  }
  const remote = JSON.parse(originHas(env, REL));
  if (remote.fullText === RECOVERED) {
    assert.equal(res.landed.length, 1);
    assert.equal(calls.length, 1);
  } else {
    assert.equal(res.notLanded.length, 1, 'text lost to the conflict must be reported not landed');
    assert.deepEqual(calls, []);
  }
});

test('push rejected: throws, keeps the pending entry, never reports landed; the next run pushes it', () => {
  const env = setup();
  const hook = path.join(env.origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/bash\necho "rejected for test" >&2\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(env.file, review(RECOVERED));
  const landed = [];
  assert.throws(
    () => checkpointReviewTexts({ repoDir: env.local, paths: [env.file], message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1, onLanded: (l) => landed.push(l) }),
    (e) => e instanceof ReviewTextsPushError && e.code === 'EREVIEWTEXTSPUSH',
  );
  assert.deepEqual(landed, [], 'no landed callback for a commit that never reached origin');
  assert.equal(readPending(env.pendingPath).length, 1, 'pending entry recorded');
  assert.equal(JSON.parse(originHas(env, REL)).fullText, 'stub text');

  // Still rejected: the next run's retry throws BEFORE any new work.
  assert.throws(() => retryPendingPushes({ repoDir: env.local, pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1 }), ReviewTextsPushError);

  fs.unlinkSync(hook);
  const r = retryPendingPushes({ repoDir: env.local, pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1, onLanded: (l) => landed.push(l) });
  assert.equal(r.landed.length, 1);
  assert.deepEqual(landed.map((l) => l.path), [REL]);
  assert.equal(JSON.parse(originHas(env, REL)).fullText, RECOVERED);
  assert.deepEqual(readPending(env.pendingPath), []);
});

test('a concurrent reset --hard wipes the unpushed commit: the next run restores it from the object store', () => {
  const env = setup();
  const hook = path.join(env.origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/bash\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(env.file, review(RECOVERED));
  assert.throws(() => checkpointReviewTexts({ repoDir: env.local, paths: [env.file], message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1 }), ReviewTextsPushError);
  // Another local session "syncs" the checkout the dangerous way.
  git(env.local, 'fetch', '-q', 'origin');
  git(env.local, 'reset', '-q', '--hard', 'origin/main');
  assert.equal(JSON.parse(fs.readFileSync(env.file, 'utf8')).fullText, 'stub text', 'the wipe really happened');
  fs.unlinkSync(hook);
  const landed = [];
  const r = retryPendingPushes({ repoDir: env.local, pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1, onLanded: (l) => landed.push(l.path) });
  assert.equal(r.restored.length, 1, JSON.stringify(r));
  assert.deepEqual(landed, [REL]);
  assert.equal(JSON.parse(originHas(env, REL)).fullText, RECOVERED, 'recovered text restored and pushed');
  assert.deepEqual(readPending(env.pendingPath), []);
});

test('wiped commit is NOT restored over a newer remote edit of the same file', () => {
  const env = setup();
  const hook = path.join(env.origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/bash\n[ -e "$GIT_DIR/../allow" ] && exit 0\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(env.file, review(RECOVERED));
  assert.throws(() => checkpointReviewTexts({ repoDir: env.local, paths: [env.file], message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1 }), ReviewTextsPushError);
  fs.writeFileSync(path.join(env.dir, 'allow'), '');
  fs.writeFileSync(path.join(env.ci, REL), review('someone else fixed this by hand'));
  git(env.ci, 'commit', '-q', '-am', 'manual fix');
  git(env.ci, 'push', '-q', 'origin', 'HEAD:main');
  git(env.local, 'fetch', '-q', 'origin');
  git(env.local, 'reset', '-q', '--hard', 'origin/main');
  const landed = [];
  const r = retryPendingPushes({ repoDir: env.local, pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1, onLanded: (l) => landed.push(l.path) });
  assert.equal(r.restored.length, 0);
  assert.equal(r.notLanded.length, 1);
  assert.match(r.notLanded[0].why, /remote changed/);
  assert.deepEqual(landed, []);
  assert.equal(JSON.parse(originHas(env, REL)).fullText, 'someone else fixed this by hand');
});

test('only tracked paths are committed: another writer\'s dirty file stays out of our commit', () => {
  const env = setup();
  fs.writeFileSync(env.file, review(RECOVERED));
  const other = path.join(env.local, 'show-2026', 'variety--b.json');
  fs.writeFileSync(other, review('half-written by another local writer'));
  const res = checkpointReviewTexts({ repoDir: env.local, paths: [env.file], message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript });
  assert.equal(res.landed.length, 1);
  assert.deepEqual(git(env.local, 'show', '--name-only', '--format=', res.commit).trim().split('\n'), [REL]);
  assert.equal(JSON.parse(originHas(env, 'show-2026/variety--b.json')).fullText, 'other stub', 'untracked edit not pushed');
  assert.equal(JSON.parse(fs.readFileSync(other, 'utf8')).fullText, 'half-written by another local writer', 'and not discarded either');
});

test('a run that died between commit and pending entry: the next run still pushes the orphan commit', () => {
  const env = setup();
  fs.writeFileSync(env.file, review(RECOVERED));
  git(env.local, 'commit', '-q', '-am', 'feat: committed, then the process died');
  assert.deepEqual(readPending(env.pendingPath), []);
  const r = retryPendingPushes({ repoDir: env.local, pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1 });
  assert.equal(r.entries, 0);
  assert.equal(JSON.parse(originHas(env, REL)).fullText, RECOVERED, 'orphan commit reached origin');
});

// BRO-7171: the local writers routed through the checkpoint also delete
// (clean-orphan-pending, the talkinbroadway husk, batch-correct renames).
// A deletion lands when origin/main no longer has the file; before the fix
// it threw "did not land as written" after a successful push.
test('a tracked deletion and a rename land: no throw, origin matches', () => {
  const env = setup();
  const other = path.join(env.local, 'show-2026', 'variety--b.json');
  const renamed = path.join(env.local, 'show-2026', 'variety--jane-doe.json');
  fs.unlinkSync(env.file);
  fs.renameSync(other, renamed);
  const landedPaths = [];
  const res = checkpointReviewTexts({ repoDir: env.local, paths: [env.file, other, renamed], message: 'cleanup: test', onLanded: (l) => landedPaths.push(l.path), pendingPath: env.pendingPath, pushScript: env.pushScript });
  assert.equal(res.pushed, true);
  assert.equal(res.landed.length, 3);
  assert.equal(originHas(env, REL), null, 'deleted on origin');
  assert.equal(originHas(env, 'show-2026/variety--b.json'), null);
  assert.equal(JSON.parse(originHas(env, 'show-2026/variety--jane-doe.json')).fullText, 'other stub');
  assert.deepEqual(readPending(env.pendingPath), []);
});

// clean-orphan-pending shape (ship-check): it deletes every file in a show
// dir, then the dir itself. Before the fix relPath threw ENOENT on the gone
// parent, and a deleted never-committed file threw "vanished" after the push.
test('deleted on purpose: emptied-and-removed dir lands; an untracked deletion is a no-op', () => {
  const env = setup();
  const dirPath = path.join(env.local, 'show-2026');
  const other = path.join(dirPath, 'variety--b.json');
  const untracked = path.join(env.local, '_pending', 'show-2026', 'never-committed.json');
  fs.mkdirSync(path.dirname(untracked), { recursive: true });
  fs.writeFileSync(untracked, review('pending'));
  fs.unlinkSync(env.file);
  fs.unlinkSync(other);
  fs.rmdirSync(dirPath);
  fs.unlinkSync(untracked);
  fs.rmdirSync(path.dirname(untracked));
  const tracker = createWriteTracker();
  for (const p of [env.file, other, untracked]) { tracker.add(p); tracker.deleted.add(p); }
  const res = checkpointReviewTexts({ repoDir: env.local, paths: tracker, message: 'cleanup: test', pendingPath: env.pendingPath, pushScript: env.pushScript });
  assert.equal(res.pushed, true);
  assert.deepEqual(res.notLanded, []);
  assert.equal(originHas(env, REL), null);
  assert.equal(originHas(env, 'show-2026/variety--b.json'), null);
  // Without `deleted`, a never-committed gone path is still a lost write (unchanged contract).
  const lone = checkpointReviewTexts({ repoDir: env.local, paths: [path.join(env.local, 'x--gone.json')], message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript });
  assert.deepEqual(lone.notLanded.map((r) => r.why), ['file vanished before commit']);
});

test('nothing changed: no commit, no throw, landed confirmed by content', () => {
  const env = setup();
  const res = checkpointReviewTexts({ repoDir: env.local, paths: [env.file], message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript });
  assert.equal(res.committed, false);
  assert.equal(res.pushed, false);
  assert.equal(res.landed.length, 1);
});

test('push reports success but origin lacks our text: throws, keeps the path pending, no onLanded', () => {
  const env = setup();
  fs.writeFileSync(env.file, review(RECOVERED));
  const fakePush = path.join(env.dir, 'push-says-ok.sh');
  fs.writeFileSync(fakePush, '#!/bin/bash\nexit 0\n');
  const calls = [];
  assert.throws(
    () => checkpointReviewTexts({ repoDir: env.local, paths: [env.file], message: 'feat: test', pendingPath: env.pendingPath, pushScript: fakePush, onLanded: (l) => calls.push(l) }),
    (e) => e instanceof ReviewTextsLandingError && e.notLanded.length === 1,
  );
  assert.deepEqual(calls, []);
  const pending = readPending(env.pendingPath);
  assert.equal(pending.length, 1, 'the not-landed path stays in the ledger for the next run');
  assert.deepEqual(pending[0].paths.map((p) => p.rel), [REL]);
  // The next run (real push) lands it.
  const r = retryPendingPushes({ repoDir: env.local, pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1, onLanded: (l) => calls.push(l.path) });
  assert.equal(r.landed.length, 1);
  assert.deepEqual(calls, [REL]);
  assert.deepEqual(readPending(env.pendingPath), []);
});

test('another writer replaces our recovered record before the commit: reported lost, never landed', () => {
  const env = setup();
  const tracker = createWriteTracker();
  fs.writeFileSync(env.file, review(RECOVERED));
  tracker.add(env.file);
  tracker.expected.set(env.file, contentKey(fs.readFileSync(env.file, 'utf8')));
  fs.writeFileSync(env.file, review('collector overwrote it with an excerpt'));
  const calls = [];
  assert.throws(
    () => checkpointReviewTexts({ repoDir: env.local, paths: [...tracker], expected: tracker.expected, message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript, onLanded: (l) => calls.push(l) }),
    (e) => e instanceof ReviewTextsLandingError && /overwritten by another writer/.test(e.message),
  );
  assert.deepEqual(calls, [], 'the overwrite is not reported as our recovery');
});

test('a tracked path that vanished (never committed) does not break the checkpoint for the rest', () => {
  const env = setup();
  fs.writeFileSync(env.file, review(RECOVERED));
  const ghost = path.join(env.local, 'show-2026', 'ghost--x.json');
  let err;
  try {
    checkpointReviewTexts({ repoDir: env.local, paths: [env.file, ghost], message: 'feat: test', pendingPath: env.pendingPath, pushScript: env.pushScript });
  } catch (e) { err = e; }
  assert.ok(err instanceof ReviewTextsLandingError, String(err && err.message));
  assert.match(err.message, /vanished/);
  assert.deepEqual(err.landed.map((l) => l.rel), [REL]);
  assert.equal(JSON.parse(originHas(env, REL)).fullText, RECOVERED, 'the real file still landed');
});

test('two unpushed checkpoints of one file, both wiped by a reset: the NEWER text is restored', () => {
  const env = setup();
  const hook = path.join(env.origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/bash\nexit 1\n');
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(env.file, review('first recovery '.repeat(40)));
  assert.throws(() => checkpointReviewTexts({ repoDir: env.local, paths: [env.file], message: 'feat: one', pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1 }), ReviewTextsPushError);
  fs.writeFileSync(env.file, review(RECOVERED));
  assert.throws(() => checkpointReviewTexts({ repoDir: env.local, paths: [env.file], message: 'feat: two', pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1 }), ReviewTextsPushError);
  git(env.local, 'fetch', '-q', 'origin');
  git(env.local, 'reset', '-q', '--hard', 'origin/main');
  fs.unlinkSync(hook);
  const r = retryPendingPushes({ repoDir: env.local, pendingPath: env.pendingPath, pushScript: env.pushScript, retries: 1 });
  assert.equal(r.restored.length, 1, JSON.stringify(r));
  assert.equal(JSON.parse(originHas(env, REL)).fullText, RECOVERED, 'newest recovery restored, not the older one');
  assert.deepEqual(readPending(env.pendingPath), []);
});
