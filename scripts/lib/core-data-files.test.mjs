// BRO-3521 / BRO-3523 / BRO-3331: core-data copy allowlist + local copy drift.
// require()s the real functions (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LIB = fileURLToPath(new URL('./core-data-files.js', import.meta.url));
const { getLocalCopyFiles, planCoreDataCopy, findStaleCopies } = require(LIB);

test('getLocalCopyFiles parses setup-local-data.sh (includes the 47MB mezzanine file)', () => {
  const files = getLocalCopyFiles();
  assert.ok(files.includes('critic-registry.json'));
  assert.ok(files.includes('mezzanine-productions-raw.json'));
  assert.ok(!files.includes('shows.json'), 'shows.json is a symlink file, not a copy');
});

test('planCoreDataCopy defaults to the live push-core-data CORE_FILES', () => {
  const { copy, skipped } = planCoreDataCopy(['shows.json', 'awards.json', 'stray.json'], { isPublicTracked: () => true });
  assert.deepEqual(copy, ['shows.json', 'awards.json']);
  assert.deepEqual(skipped, ['stray.json']);
});

test('planCoreDataCopy: a stray private copy of a public-tracked file is NOT copied', () => {
  const tracked = new Set(['show-score-urls.json', 'outlet-registry.json', 'awards.json']);
  const { copy, skipped } = planCoreDataCopy(
    ['shows.json', 'show-score-urls.json', 'outlet-registry.json', 'awards.json', 'mezzanine-productions-raw.json'],
    { isPublicTracked: (n) => tracked.has(n) },
  );
  assert.deepEqual(skipped, ['show-score-urls.json', 'outlet-registry.json']);
  // awards.json: public-tracked but deliberately core data (dual-track) -> copied.
  // mezzanine-productions-raw.json: untracked extra -> copied (current behavior kept).
  assert.deepEqual(copy, ['shows.json', 'awards.json', 'mezzanine-productions-raw.json']);
});

test('plan CLI end to end: a mocked private checkout never shadows a tracked public file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-data-plan-'));
  const repo = path.join(tmp, 'repo');
  const priv = path.join(tmp, 'private');
  fs.mkdirSync(path.join(repo, 'data'), { recursive: true });
  fs.mkdirSync(priv);
  execFileSync('git', ['init', '-q', repo]);
  fs.writeFileSync(path.join(repo, 'data/show-score-urls.json'), '{"public":true}');
  fs.writeFileSync(path.join(repo, 'data/awards.json'), '{}');
  // A nested tracked file with a private-repo name must not block that name.
  fs.mkdirSync(path.join(repo, 'data/sub'));
  fs.writeFileSync(path.join(repo, 'data/sub/extra.json'), '{}');
  execFileSync('git', ['-C', repo, 'add', 'data']);
  for (const f of ['shows.json', 'reviews.json', 'show-score-urls.json', 'awards.json', 'extra.json']) {
    fs.writeFileSync(path.join(priv, f), '{}');
  }
  const out = execFileSync('node', [LIB, 'plan', priv, repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(out.trim().split('\n'), ['awards.json', 'extra.json', 'reviews.json', 'shows.json']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('findStaleCopies flags a drifted copy, ignores identical, missing and symlinked files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-data-stale-'));
  const data = path.join(tmp, 'data');
  const core = path.join(tmp, 'core');
  fs.mkdirSync(data);
  fs.mkdirSync(core);
  fs.writeFileSync(path.join(core, 'critic-registry.json'), '{"v":2}');
  fs.writeFileSync(path.join(data, 'critic-registry.json'), '{"v":1}');
  fs.writeFileSync(path.join(core, 'grosses.json'), '{"same":1}');
  fs.writeFileSync(path.join(data, 'grosses.json'), '{"same":1}');
  fs.writeFileSync(path.join(core, 'awards.json'), '{}'); // no local copy
  fs.writeFileSync(path.join(core, 'shows.json'), '{"v":2}');
  fs.symlinkSync(path.join(core, 'shows.json'), path.join(data, 'shows.json'));
  const stale = findStaleCopies({ dataDir: data, coreDataDir: core, files: ['critic-registry.json', 'grosses.json', 'awards.json', 'shows.json'] });
  assert.deepEqual(stale, ['critic-registry.json']);
  assert.deepEqual(findStaleCopies({ dataDir: data, coreDataDir: path.join(tmp, 'nope') }), []);
  fs.rmSync(tmp, { recursive: true, force: true });
});
