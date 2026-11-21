// BRO-7984 class guard: a bare `node --test` at the repo root runs every file
// matching node's default test globs. Any such file that is not *.test.* must
// be an allowlisted pure module/self-test or call the early-exit guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = 'refuse-under-bare-node-runner';

// node's default patterns (v22+): *.test.*, *-test.*, *_test.*, test-*.*, test.*, test/**
const EXT = '[cm]?js';
const DEFAULT_GLOBS = [
  new RegExp(`(^|/)[^/]*\\.test\\.${EXT}$`),
  new RegExp(`(^|/)[^/]*[-_]test\\.${EXT}$`),
  new RegExp(`(^|/)test-[^/]*\\.${EXT}$`),
  new RegExp(`(^|/)test\\.${EXT}$`),
  new RegExp(`(^|/)test/.*\\.${EXT}$`),
];
const REAL_TEST = new RegExp(`\\.test\\.${EXT}$`);

// Pure modules (no I/O at require time) that merely have test-ish names.
const ALLOWLIST = new Set([
  'scripts/lib/test-data-write-guard.js',
  'scripts/lib/test-identity.js',
  'scripts/lib/test-manifest.js',
  'scripts/lib/test-run-guard.js',
  'scripts/lib/test-send-marker.js',
  'scripts/lib/test-yml-manifest-paths.js',
  'scripts/lib/test-yml-push-paths.js',
]);

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\n').filter(Boolean)
  .filter((f) => !f.startsWith('node_modules/') && fs.existsSync(path.join(root, f)));
const matched = tracked.filter((f) => DEFAULT_GLOBS.some((re) => re.test(f)) && !REAL_TEST.test(f));

test('every non-*.test.* file in node default globs is allowlisted or guarded', () => {
  const bad = matched.filter((f) => !ALLOWLIST.has(f) && !fs.readFileSync(path.join(root, f), 'utf8').includes(GUARD));
  assert.deepEqual(bad, [], `unguarded files would run under bare \`node --test\`: add require('…/lib/${GUARD}.js') first`);
});

test('allowlist has no stale entries', () => {
  const stale = [...ALLOWLIST].filter((f) => !matched.includes(f));
  assert.deepEqual(stale, []);
});

test('guard exits 0 under node --test for a live script, without running it', () => {
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-bro7984-'));
  try {
    const f = path.join(tmp, 'live-test.js');
    fs.writeFileSync(f, `require(${JSON.stringify(path.join(root, 'scripts/lib', GUARD + '.js'))});\nrequire('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'RAN'))}, '1');\n`);
    const r = spawnSync(process.execPath, ['--test', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(path.join(tmp, 'RAN')), false, 'live script body ran under node --test');
    const d = spawnSync(process.execPath, [f], { encoding: 'utf8', env: { ...process.env, NODE_TEST_CONTEXT: '' } });
    assert.equal(d.status, 0);
    assert.equal(fs.existsSync(path.join(tmp, 'RAN')), true, 'direct run must still execute');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
