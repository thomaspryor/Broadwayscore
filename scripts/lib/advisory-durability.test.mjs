// BRO-7190: WAKEPROMISE / OPENCLAIM advisory hits must survive the cloud container.
// The hook's _stall_advisory_post is extracted from the real verify-edits.sh (never copied)
// and run under python3 against a stub scripts/linear-brain.js that records its argv.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..', '..');
const HOOK = fs.readFileSync(path.join(REPO_ROOT, '.claude/hooks/verify-edits.sh'), 'utf8');
const FN = HOOK.match(/^def _stall_advisory_post\(kind, detail\):\n(?:[ \t]+.*\n|\n)+?(?=\S)/m)?.[0];

function run(kind, detail, env, root, tmp) {
  const py = `import os\n${FN}\n_stall_advisory_post(${JSON.stringify(kind)}, ${JSON.stringify(detail)})\n`;
  const r = spawnSync('python3', ['-I', '-c', py], {
    env: { PATH: process.env.PATH, TMPDIR: tmp, CLAUDE_PROJECT_DIR: root, ...env }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
}
const DIRS = [];
process.on('exit', () => DIRS.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-root-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-tmp-'));
  DIRS.push(root, tmp);
  fs.mkdirSync(path.join(root, 'scripts'));
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(path.join(root, 'scripts/linear-brain.js'),
    `require('fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  const read = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  // Poll until n posts arrive (deadline 8s) instead of a fixed sleep; then a short grace so extras would show.
  const calls = async (n = 0) => {
    const end = Date.now() + 8000;
    while (read().length < n && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    if (n) await new Promise((r) => setTimeout(r, 400));
    return read();
  };
  const markers = () => fs.readdirSync(tmp).filter((x) => x.startsWith('stall-advisory-'));
  return { root, tmp, calls, markers };
}
const CLOUD = { CLAUDE_CODE_REMOTE: 'true', LINEAR_API_KEY: 'k', CLAUDE_CODE_SESSION_ID: 'sess-1' };

test('hook function was extracted and both advisory sites call it', () => {
  assert.ok(FN, 'could not extract _stall_advisory_post from verify-edits.sh');
  assert.match(HOOK, /_stall_advisory_post\('WAKEPROMISE'/);
  assert.match(HOOK, /_stall_advisory_post\('OPENCLAIM'/);
});

test('cloud hit becomes a durable card comment on BRO-7190, queryable by kind', async () => {
  const f = fixture();
  run('WAKEPROMISE', 'I will check back', CLOUD, f.root, f.tmp);
  const c = await f.calls(1);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].slice(0, 3), ['update', 'BRO-7190', '--comment']);
  assert.match(c[0][3], /^WAKEPROMISE-ADVISORY: session sess-1 I will check back/);
});

test('once per session and kind; a different kind still posts', async () => {
  const f = fixture();
  run('OPENCLAIM', '[BRO-1]', CLOUD, f.root, f.tmp);
  run('OPENCLAIM', '[BRO-2]', CLOUD, f.root, f.tmp);
  run('WAKEPROMISE', 'later', CLOUD, f.root, f.tmp);
  const kinds = (await f.calls(2)).map((x) => x[3].split('-ADVISORY')[0]).sort();
  assert.deepEqual(kinds, ['OPENCLAIM', 'WAKEPROMISE']);
  assert.equal(f.markers().length, 2); // synchronous marker: a broken once-per-session check cannot hide behind timing
});

test('not cloud, or no Linear key: nothing posted and no crash', async () => {
  const f = fixture();
  run('OPENCLAIM', 'x', { ...CLOUD, CLAUDE_CODE_REMOTE: '' }, f.root, f.tmp);
  run('OPENCLAIM', 'x', { ...CLOUD, LINEAR_API_KEY: '' }, f.root, f.tmp);
  assert.deepEqual(f.markers(), []);
  assert.deepEqual(await f.calls(), []);
});

test('a broken project dir never raises', () => {
  const f = fixture();
  run('OPENCLAIM', 'x', CLOUD, '/nonexistent-root', f.tmp);
});
