// BRO-2827: the push-latency-probe must measure the failing shape (deepened
// shallow clone + REAL push), not depth-1 + --dry-run. Workflow YAML has no
// logic to extract (rule 15), so these are structural assertions on the file.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const wf = readFileSync(join(root, '.github/workflows/check-push-ledger.yml'), 'utf8');
const probe = wf.slice(wf.indexOf('push-latency-probe:\n'));
const code = probe.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');

describe('push-latency-probe shape (BRO-2827)', () => {
  it('has a probe job', () => assert.ok(probe.length > 100));
  it('does not use --dry-run', () => assert.doesNotMatch(code, /--dry-run/));
  it('does a real push to a scratch ref and deletes it', () => {
    assert.match(code, /git push --progress origin "HEAD:\$\{_ref\}"/);
    assert.match(code, /refs\/heads\/probe\/push-latency-/);
    assert.match(code, /git push origin --delete/);
  });
  it('sweeps scratch refs in an if: always() step', () => assert.match(code, /if: always\(\)[\s\S]*--delete/));
  it('deepens via shallow-fetch-args.js with a fail-closed fallback', () => {
    assert.match(code, /shallow-fetch-args\.js/);
    assert.match(code, /--deepen=200/);
  });
  it('runs both A/B arms in ABBA order, COLD first', () => {
    const order = [...code.matchAll(/^\s*probe_push (\d) (\w+)$/gm)].map(m => m[2]);
    assert.deepEqual(order, ['nofetch', 'fetched', 'fetched', 'nofetch']);
    assert.ok(code.indexOf('sample=COLD') < code.indexOf('probe_push 1'));
  });
  it('keeps classify(), set +e and the self-expiry', () => {
    assert.match(code, /classify\(\)/);
    assert.match(code, /set \+e/);
    assert.match(code, /20261101/);
  });
  it('freezes the deepen args once (no per-fetch recompute) and never reports a failed sweep as clean', () => {
    assert.match(code, /DEEPEN="\$\(deepen_args\)"/);
    assert.equal((code.match(/\$\(deepen_args\)/g) || []).length, 1);
    assert.match(code, /SWEEP-UNVERIFIED/);
  });
  it('uses its own concurrency group and a timeout that fits the worst case', () => {
    assert.match(code, /group: push-latency-probe/);
    assert.match(code, /timeout-minutes: 25/);
  });
  it('still uses the shallow helper that exists', () => {
    const lib = readFileSync(join(root, 'scripts/lib/shallow-fetch-args.js'), 'utf8');
    assert.match(lib, /module\.exports = \{[^}]*repoDepthArgs/);
  });
});
