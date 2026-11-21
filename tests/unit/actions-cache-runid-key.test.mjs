// BRO-3887: rule (m) of audit-workflow-hygiene — an actions/cache key scoped to
// github.run_id mints a new entry on every job of every run.
//
// .github/actions/checkout-core-data did this with a full clone of the private
// core-data repo: 284 invocations across 191 workflow files, 3.4 GiB per entry,
// 28.06 GiB live against GitHub's 10 GiB per-repo limit. LRU eviction then wiped
// the whole cache namespace roughly hourly — including the 22 KB SERP cache, so
// gather-reviews.js re-paid for the same SERP queries on each of the 8 daily
// opening-night ticks and went from 360 to 9,178 scraper credits/day on flat
// dispatch volume.
//
// require()s the real matcher (CLAUDE.md §15) so a production change to the rule
// fails this test rather than a copy of the logic drifting beside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { findRunIdKeyedCaches } = require('../../scripts/audit-workflow-hygiene.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('flags an actions/cache key containing github.run_id', () => {
  const yaml = [
    '    - name: Cache stuff',
    '      uses: actions/cache@v5',
    '      with:',
    '        path: /tmp/thing',
    '        key: thing-${{ runner.os }}-${{ github.run_id }}',
  ].join('\n');
  const hits = findRunIdKeyedCaches(yaml);
  assert.equal(hits.length, 1);
  assert.match(hits[0].message, /run-id-scoped/);
});

test('flags actions/cache/save and actions/cache/restore, not just actions/cache', () => {
  for (const uses of ['actions/cache/save@v5', 'actions/cache/restore@v5']) {
    const yaml = `    - uses: ${uses}\n      with:\n        key: x-\${{ github.run_id }}\n`;
    assert.equal(findRunIdKeyedCaches(yaml).length, 1, uses);
  }
});

test('does NOT flag a restore-keys prefix that happens to sit near a run_id key', () => {
  // restore-keys are prefixes — a run_id there is meaningless, and flagging the
  // continuation lines would double-count every legitimate cache.
  const yaml = [
    '    - uses: actions/cache@v5',
    '      with:',
    '        key: safe-${{ hashFiles(\'package-lock.json\') }}',
    '        restore-keys: |',
    '          safe-${{ github.run_id }}',
  ].join('\n');
  assert.deepEqual(findRunIdKeyedCaches(yaml), []);
});

test('does NOT flag a key outside an actions/cache step', () => {
  const yaml = [
    '    - uses: some/other-action@v1',
    '      with:',
    '        key: other-${{ github.run_id }}',
  ].join('\n');
  assert.deepEqual(findRunIdKeyedCaches(yaml), []);
});

test('does NOT flag commented-out YAML', () => {
  const yaml = [
    '    # - uses: actions/cache@v5',
    '    #   with:',
    '    #     key: old-${{ github.run_id }}',
  ].join('\n');
  assert.deepEqual(findRunIdKeyedCaches(yaml), []);
});

test('the file-wide hygiene-cache-runid-ok exemption suppresses the rule', () => {
  const yaml = [
    '# hygiene-cache-runid-ok: deliberate, tiny payload',
    '    - uses: actions/cache@v5',
    '      with:',
    '        key: tiny-${{ github.run_id }}',
  ].join('\n');
  assert.deepEqual(findRunIdKeyedCaches(yaml), []);
});

test('checkout-core-data carries no actions/cache step at all (the BRO-3887 regression guard)', () => {
  const raw = fs.readFileSync(
    path.join(ROOT, '.github', 'actions', 'checkout-core-data', 'action.yml'),
    'utf8',
  );
  const live = raw
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  assert.ok(
    !/uses:\s*actions\/cache/.test(live),
    'checkout-core-data must not cache its clone — it saved 3.4 GiB per job and evicted the whole namespace (BRO-3887)',
  );
});

test('every real workflow and composite action is either clean or explicitly exempt', () => {
  const targets = [];
  const wfDir = path.join(ROOT, '.github', 'workflows');
  for (const f of fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
    targets.push([`workflows/${f}`, path.join(wfDir, f)]);
  }
  const actDir = path.join(ROOT, '.github', 'actions');
  for (const d of fs.readdirSync(actDir)) {
    for (const b of ['action.yml', 'action.yaml']) {
      const p = path.join(actDir, d, b);
      if (fs.existsSync(p)) targets.push([`actions/${d}/${b}`, p]);
    }
  }
  const offenders = [];
  for (const [label, p] of targets) {
    const hits = findRunIdKeyedCaches(fs.readFileSync(p, 'utf8'));
    if (hits.length) offenders.push(`${label}: ${hits.map((h) => h.message).join('; ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `run-id-keyed actions/cache without an exemption:\n${offenders.join('\n')}`,
  );
});
