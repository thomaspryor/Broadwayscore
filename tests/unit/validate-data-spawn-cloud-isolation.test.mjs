// Class guard (BRO-7398): validate-data.js defaults to --dry-run when
// CLAUDE_CODE_REMOTE=true (cloud sessions), so it skips the quarantine writes and the
// refusal sentinel. A test that spawns the real validator in a sandbox must neutralize
// that variable, or it passes in CI and fails in every cloud session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const DIR = import.meta.dirname;
// Validators that pass --write / --dry-run explicitly are independent of the default.
const EXPLICIT_FLAG = /['"]--(write|dry-run)['"]/;
// Must be the env assignment itself (a comment naming the variable does not count) and not 'true'.
const NEUTRALIZED = /CLAUDE_CODE_REMOTE\s*:\s*(['"`])(?!true\1)[^'"`]*\1|CLAUDE_CODE_REMOTE\s*:\s*undefined|delete\s+\w+(\.env)?\.CLAUDE_CODE_REMOTE/;
// Only protects cloud and local runs: CI (GITHUB_ACTIONS=true) never takes the dry-run default.
// Preferred opt-out is passing '--write' (see tests/helpers/validate-data-sentinel.mjs).
export function findUnisolatedSpawners(dir = DIR) {
  return fs.readdirSync(dir).filter(f => /\.test\.(mjs|js)$/.test(f) && f !== path.basename(import.meta.filename))
    .filter(f => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const spawnsValidator = /\b(spawnSync|execFileSync|execSync|spawn|fork|exec)\([^;]{0,200}?(validate-data|\bVALIDATE\b)/s.test(src)
        || /require\([^)]*scripts\/validate-data\.js/.test(src) || /require\(\$\{JSON\.stringify\([^)]*validate-data\.js/.test(src);
      return spawnsValidator && !EXPLICIT_FLAG.test(src) && !NEUTRALIZED.test(src);
    });
}
test('tests that spawn validate-data.js neutralize CLAUDE_CODE_REMOTE', () => {
  assert.deepEqual(findUnisolatedSpawners(), []);
});
test('the guard flags a spawner that leaves CLAUDE_CODE_REMOTE alone', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    fs.writeFileSync(path.join(tmp, 'x.test.mjs'),
      "spawnSync('node', ['scripts/validate-data.js'], { env: { RUNNER_TEMP: d } });");
    assert.deepEqual(findUnisolatedSpawners(tmp), ['x.test.mjs']);
    // A comment naming the variable is not isolation.
    fs.writeFileSync(path.join(tmp, 'y.test.mjs'),
      "// CLAUDE_CODE_REMOTE\nspawnSync('node', ['scripts/validate-data.js'], { env: { RUNNER_TEMP: d } });");
    assert.deepEqual(findUnisolatedSpawners(tmp).sort(), ['x.test.mjs', 'y.test.mjs']);
    fs.writeFileSync(path.join(tmp, 'z.test.mjs'),
      "spawnSync('node', ['scripts/validate-data.js'], { env: { CLAUDE_CODE_REMOTE: '' } });");
    assert.ok(!findUnisolatedSpawners(tmp).includes('z.test.mjs'));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
