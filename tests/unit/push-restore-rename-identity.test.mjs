// BRO-5356: the push-time restores compared a staged file with the committed
// file at the SAME PATH. A plan that deleted X and renamed Y onto X's path got
// X's llmScore and duplicateOf back on Y (all-my-sons-2019, grand-horizons-2020,
// plan bro-5243-h). This drives push-review-texts' real inline "Protected" block
// (extracted from action.yml) and restore-protected-fields.js in a scratch repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { committedHistoryFor, renamedSinceCommit } = require('../../scripts/lib/rename-identity.js');

function protectBlock() {
  const yml = fs.readFileSync(path.join(ROOT, '.github/actions/push-review-texts/action.yml'), 'utf8');
  const i = yml.indexOf('# Protect scored/collected review data');
  const j = yml.indexOf('node -e "\n', i) + 'node -e "\n'.length;
  const k = yml.indexOf('\n        " || true', j);
  assert.ok(i > 0 && k > j, 'found the Protected block in action.yml');
  return yml.slice(j, k);
}

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const write = (cwd, rel, o) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), JSON.stringify(o, null, 2) + '\n'); };
const read = (cwd, rel) => JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8'));

const URL = 'https://www.wsj.com/articles/all-my-sons-review-11556220135';
const OLD_T = { showId: 's', url: URL, criticName: 'Terry Teachout', fullText: 'x'.repeat(2373), llmScore: { score: 93 }, assignedScore: 93,
  llmMetadata: { scoredAt: '2026-10-01T00:00:00Z' }, duplicateOf: 'wsj--charles-isherwood.json', duplicateReason: 'same-url-byline-dedup' };
const OLD_I = { showId: 's', url: URL, criticName: 'Terry Teachout', fullText: 'y'.repeat(2366), llmScore: { score: 94 }, assignedScore: 94,
  llmMetadata: { scoredAt: '2026-09-01T00:00:00Z' } };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-identity-'));
  git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
  write(dir, 's/wsj--terry-teachout.json', OLD_T);
  write(dir, 's/wsj--charles-isherwood.json', OLD_I);
  write(dir, 's/other--critic.json', { showId: 's', url: 'https://x/y', fullText: 'z'.repeat(900), assignedScore: 70, llmScore: { score: 70 } });
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
  return dir;
}

function renameIOntoT(dir) {
  fs.unlinkSync(path.join(dir, 's/wsj--terry-teachout.json'));
  const { safeRenameReview } = require('../../scripts/lib/review-write-guard.js');
  const r = safeRenameReview(path.join(dir, 's/wsj--charles-isherwood.json'), path.join(dir, 's/wsj--terry-teachout.json'));
  assert.equal(r.renamed, true, JSON.stringify(r));
}

test('the push Protected block keeps a renamed file\'s own fields (no score or duplicateOf from the deleted occupant)', () => {
  const dir = repo();
  try {
    renameIOntoT(dir);
    // a normal edit at an unchanged path still has its protected score restored
    const other = read(dir, 's/other--critic.json'); delete other.assignedScore; write(dir, 's/other--critic.json', other);
    git(dir, 'add', '-A');
    execFileSync('node', ['-e', protectBlock()], { cwd: dir, env: { ...process.env, GITHUB_WORKSPACE: ROOT }, encoding: 'utf8' });
    const t = read(dir, 's/wsj--terry-teachout.json');
    assert.equal(t.llmScore.score, 94);
    assert.equal(t.assignedScore, 94);
    assert.equal(t.duplicateOf, undefined);
    assert.equal(t._renamedFrom.file, 's/wsj--charles-isherwood.json');
    assert.equal(read(dir, 's/other--critic.json').assignedScore, 70, 'control: path-matched restore still works');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('restore-protected-fields.js after a rebase compares a renamed file with its source path', () => {
  const dir = repo();
  try {
    git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    renameIOntoT(dir);
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'rename');
    execFileSync('node', [path.join(ROOT, 'scripts/lib/restore-protected-fields.js'), 'origin/main'], { cwd: dir, encoding: 'utf8' });
    const t = read(dir, 's/wsj--terry-teachout.json');
    assert.equal(t.llmScore.score, 94);
    assert.equal(t.duplicateOf, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('rename-identity: only a stamp not already on the committed version redirects the history', () => {
  const stamp = { file: 's/a.json', at: '2026-10-14T00:00:00Z' };
  assert.equal(renamedSinceCommit({}, {}), false);
  assert.equal(renamedSinceCommit({ _renamedFrom: stamp }, null), true);
  assert.equal(renamedSinceCommit({ _renamedFrom: stamp }, { _renamedFrom: { ...stamp } }), false, 'renamed in an earlier push');
  const read = (p) => { if (p === 's/b.json') return { who: 'old occupant' }; if (p === 's/a.json') return { who: 'source' }; throw new Error('absent'); };
  assert.equal(committedHistoryFor('s/b.json', { _renamedFrom: stamp }, read).who, 'source');
  assert.equal(committedHistoryFor('s/b.json', {}, read).who, 'old occupant');
  assert.equal(committedHistoryFor('s/c.json', {}, read), null);
  assert.equal(committedHistoryFor('s/b.json', { _renamedFrom: { file: 's/gone.json', at: 'x' } }, read), null);
});
