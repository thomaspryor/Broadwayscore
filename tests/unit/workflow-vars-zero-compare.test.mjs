// BRO-5670: GitHub expressions compare loosely and an unset repository
// variable reads as empty, which coerces to the number 0. So
// `vars.X != '0'` is FALSE when X is unset, and `vars.X == '0'` is TRUE: a
// kill switch written that way is "off" by default. land.yml's deploy request
// shipped as `vars.LAND_DEPLOY_DISPATCH != '0'` and was skipped on its first
// real landing (run 39217175444). Write switches the repo's way instead:
// `vars.<NAME>_DISABLED != 'true'`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WF_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../.github/workflows');
const ZERO_COMPARE_RE = /\bvars\.[A-Za-z0-9_]+\s*[!=]=\s*['"]0['"]|['"]0['"]\s*[!=]=\s*vars\.[A-Za-z0-9_]+/;

function zeroCompares() {
  const hits = [];
  for (const f of fs.readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    fs.readFileSync(path.join(WF_DIR, f), 'utf8').split('\n').forEach((line, i) => {
      if (!/^\s*#/.test(line) && ZERO_COMPARE_RE.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

test("no workflow compares a repository variable to '0' (an unset variable equals '0')", () => {
  assert.deepEqual(zeroCompares(), []);
});

test('the pattern catches both comparison directions and leaves the _DISABLED convention alone', () => {
  assert.ok(ZERO_COMPARE_RE.test("if: vars.LAND_DEPLOY_DISPATCH != '0'"));
  assert.ok(ZERO_COMPARE_RE.test("if: \"0\" == vars.X"));
  assert.ok(!ZERO_COMPARE_RE.test("if: vars.LAND_DEPLOY_DISPATCH_DISABLED != 'true'"));
  assert.ok(!ZERO_COMPARE_RE.test("if: vars.LAND_GAUNTLET_SHARDS != '1'"));
});
