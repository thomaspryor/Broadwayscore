// Class guard (BRO-7398): validate-data.js defaults to --dry-run when
// CLAUDE_CODE_REMOTE=true (cloud sessions), so it skips the quarantine writes and the
// refusal sentinel. A test that spawns the real validator in a sandbox must neutralize
// that variable, or it passes in CI and fails in every cloud session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const DIR = import.meta.dirname;
// Validators that pass --write / --dry-run explicitly are independent of the default.
const EXPLICIT_FLAG = /['"]--(write|dry-run)['"]/;
export function findUnisolatedSpawners(dir = DIR) {
  return fs.readdirSync(dir).filter(f => /\.test\.(mjs|js)$/.test(f) && f !== path.basename(import.meta.filename))
    .filter(f => {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      const spawnsValidator = /spawnSync|execFileSync/.test(src) && /scripts\/validate-data\.js|VALIDATE\s*=|'validate-data\.js'/.test(src) && /RUNNER_TEMP/.test(src);
      return spawnsValidator && !EXPLICIT_FLAG.test(src) && !/CLAUDE_CODE_REMOTE/.test(src);
    });
}
test('tests that spawn validate-data.js neutralize CLAUDE_CODE_REMOTE', () => {
  assert.deepEqual(findUnisolatedSpawners(), []);
});
test('the guard flags a spawner that leaves CLAUDE_CODE_REMOTE alone', () => {
  const tmp = fs.mkdtempSync(path.join(DIR, '.guard-'));
  try {
    fs.writeFileSync(path.join(tmp, 'x.test.mjs'),
      "spawnSync('node', ['scripts/validate-data.js'], { env: { RUNNER_TEMP: d } });");
    assert.deepEqual(findUnisolatedSpawners(tmp), ['x.test.mjs']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
