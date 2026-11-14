// BRO-6510: push-aggregator-archive must survive several shards pushing at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { MAX_ATTEMPTS, contentionDelaySeconds, maxContentionDelaySeconds } = require('./push-aggregator-archive.js');
const ACTION = path.resolve(import.meta.dirname, '../../.github/actions/push-aggregator-archive/action.yml');

test('budget is larger than the old 5 attempts', () => {
  assert.ok(MAX_ATTEMPTS >= 8);
});

test('jitter: bounded, varies, and widens with the attempt number', () => {
  assert.equal(contentionDelaySeconds(1, () => 0), 5);
  assert.ok(contentionDelaySeconds(1, () => 0.999) <= 20);
  assert.ok(maxContentionDelaySeconds(9) > maxContentionDelaySeconds(1));
  const seen = new Set(Array.from({ length: 50 }, () => contentionDelaySeconds(3)));
  assert.ok(seen.size > 3, 'delays must be randomised, not flat');
  assert.equal(contentionDelaySeconds('garbage', () => 0), 5);
});

test('worst-case total sleep fits well inside the gather job timeout', () => {
  let total = 0;
  for (let a = 1; a < MAX_ATTEMPTS; a++) total += maxContentionDelaySeconds(a);
  assert.ok(total < 15 * 60, `worst case ${total}s`);
});

test('the action loop uses the shared budget and jitter, not a hardcoded 5', () => {
  const y = fs.readFileSync(ACTION, 'utf8');
  assert.doesNotMatch(y, /for i in 1 2 3 4 5/);
  assert.match(y, /push-aggregator-archive\.js" max|push-aggregator-archive\.js max/);
  assert.match(y, /push-aggregator-archive\.js" delay|push-aggregator-archive\.js delay/);
});

// Real git contention: N clones push to one bare repo at once, using the same
// loop shape as the action (push, on reject pull --rebase -X theirs, jittered
// sleep from the lib). Sleeps are scaled 1/40 so the test takes seconds.
function sh(cmd, cwd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `${cmd}\n${r.stderr}`);
  return r.stdout;
}

function pusher(dir, id, attempts) {
  const script = `
    set -u
    git config user.name t; git config user.email t@t
    echo "payload-${id}" > "aggregator-archive/file-${id}.html"
    git add aggregator-archive && git commit -qm "shard ${id}"
    for i in $(seq 1 ${attempts}); do
      if git push -q origin main 2>/dev/null; then echo "OK:$i"; exit 0; fi
      git pull -q --rebase -X theirs origin main >/dev/null 2>&1 || git rebase --abort 2>/dev/null
      d=$(node "${path.resolve(import.meta.dirname, 'push-aggregator-archive.js')}" delay "$i")
      sleep "$(awk -v d="$d" 'BEGIN{printf "%.3f", d/40}')"
    done
    echo FAIL; exit 1`;
  return new Promise(resolve => {
    let out = '';
    const p = spawn('bash', ['-c', script], { cwd: dir });
    p.stdout.on('data', d => (out += d));
    p.on('close', code => resolve({ id, code, out: out.trim() }));
  });
}

test('6 concurrent shards all land within the budget (5 attempts would not be enough)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agg-push-'));
  try {
    const bare = path.join(root, 'remote.git');
    sh(`git init -q --bare -b main "${bare}"`, root);
    const seed = path.join(root, 'seed');
    sh(`git clone -q "${bare}" seed && cd seed && git checkout -qb main && mkdir aggregator-archive && echo x > aggregator-archive/seed.html && git add . && git -c user.name=t -c user.email=t@t commit -qm seed && git push -q origin main`, root);
    const N = 6;
    for (let i = 0; i < N; i++) sh(`git clone -q "${bare}" c${i} && cd c${i} && git checkout -q main`, root);
    const results = await Promise.all(Array.from({ length: N }, (_, i) => pusher(path.join(root, `c${i}`), i, MAX_ATTEMPTS)));
    const failed = results.filter(r => r.code !== 0);
    assert.deepEqual(failed, [], JSON.stringify(failed));
    const files = sh(`git --git-dir="${bare}" ls-tree -r --name-only main | wc -l`, root).trim();
    assert.equal(Number(files), N + 1, 'every shard file plus the seed is in the remote');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
