// Sparse re-checkout of a FILE over a populated tree (gitleaks.yml notify step,
// broken on every failure 2026-10-31..11-08: "'scripts/lib/discord-notify.js'
// is not a directory", run 42532429636). Requires the REAL rule (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { findSparseFileRecheckouts } = require('../../scripts/lib/audit-workflow-hygiene-rules.js');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

const job = (steps) => `on: push\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`;
const FULL = `      - uses: actions/checkout@abc # v5\n        with:\n          fetch-depth: 1\n`;
const RE = (extra = '', entries = '            .github/actions/notify-failure\n            scripts/lib/discord-notify.js\n') =>
  `      - name: Checkout for notify action\n${extra}        uses: actions/checkout@abc # v5\n        with:\n          sparse-checkout: |\n${entries}`;

test('flags a cone-mode file entry re-checked-out over the populated root (the gitleaks.yml bug)', () => {
  const hits = findSparseFileRecheckouts(job(FULL + RE('        if: failure()\n')));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry, 'scripts/lib/discord-notify.js');
  assert.equal(hits[0].job, 'scan');
});

test('passes: first checkout, missing-tree guard, no-cone, directory-only, other path, marker', () => {
  for (const wf of [
    job(RE()), // fresh checkout: cone + file works (supabase-backup.yml shape)
    job(FULL + RE("        if: failure() && hashFiles('.github/actions/notify-failure/action.yml') == ''\n")),
    job(FULL + RE().replace('          sparse-checkout: |', '          sparse-checkout-cone-mode: false\n          sparse-checkout: |')),
    job(FULL + RE('', '            .github/actions/notify-failure\n            scripts/lib/\n')),
    job(FULL + RE().replace('        with:\n          sparse', '        with:\n          path: notify\n          sparse')),
    job(FULL + '      # hygiene-sparse-file-ok: test\n' + RE()),
  ]) {
    assert.deepEqual([...findSparseFileRecheckouts(wf)], [], wf);
  }
});

test('reads every way of writing the list and the path (review findings)', () => {
  const hdr = (h) => job(FULL + RE().replace('          sparse-checkout: |', `          sparse-checkout: ${h}`));
  for (const h of ['|-', '|+', '>-', '|2']) assert.equal(findSparseFileRecheckouts(hdr(h)).length, 1, h);
  const inline = (v) => job(FULL + `      - uses: actions/checkout@abc\n        with:\n          sparse-checkout: ${v}\n`);
  assert.equal(findSparseFileRecheckouts(inline('"scripts/lib/discord-notify.js"')).length, 1, 'double-quoted inline');
  assert.equal(findSparseFileRecheckouts(inline("'scripts/lib/discord-notify.js' # why")).length, 1, 'single-quoted inline + comment');
  const withPath = (p1, p2) => job(
    `      - uses: actions/checkout@abc\n        with:\n          path: ${p1}\n` +
    RE().replace('        with:\n          sparse', `        with:\n          path: ${p2}\n          sparse`));
  assert.equal(findSparseFileRecheckouts(withPath('./sub', 'sub/')).length, 1, './sub and sub/ are one path');
  assert.equal(findSparseFileRecheckouts(withPath('${{ github.workspace }}/x', '${{ github.workspace }}/y')).length, 0, 'different ${{ }} paths');
  assert.equal(findSparseFileRecheckouts(withPath('"${{ github.workspace }}/x"', '${{ github.workspace }}/x')).length, 1, 'same ${{ }} path, quoted or not');
});

test('separate jobs do not share a populated tree', () => {
  const wf = `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n${FULL}  b:\n    runs-on: x\n    steps:\n${RE()}`;
  assert.deepEqual([...findSparseFileRecheckouts(wf)], []);
});

test('every workflow is clean, and the parser actually sees checkout steps', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const offenders = [];
  let seen = 0;
  for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const hits = findSparseFileRecheckouts(readFileSync(path.join(dir, f), 'utf8'));
    seen += hits.checkoutSteps;
    for (const h of hits) offenders.push(`${f}:${h.lineNum} (${h.step}): ${h.entry}`);
  }
  assert.ok(seen > 100, `parser found only ${seen} checkout steps; indent drift would hide offenders`);
  assert.deepEqual(offenders, [], `sparse file re-checkout over a populated tree:\n${offenders.join('\n')}`);
});
