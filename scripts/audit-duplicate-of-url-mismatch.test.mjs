// BRO-5329: exercise the real shared decisions and the existing audit CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isDuplicateOfUrlMismatch, clearDuplicateMismatch } = require('./lib/duplicate-of-url-mismatch');
const { safeWriteReview } = require('./lib/review-write-guard');
const fixture = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/duplicate-of-url-mismatch/manual-unknown-repost.json', import.meta.url)));
const script = new URL('./audit-duplicate-of-url-mismatch.js', import.meta.url).pathname;

function setup(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-5329-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const showDir = path.join(root, 'repost-2026');
  fs.mkdirSync(showDir);
  const file = path.join(showDir, 'showriz--unknown.json');
  const data = { ...fixture.repost, ...extra };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(path.join(showDir, data.duplicateOf), JSON.stringify(fixture.primary));
  const run = (...args) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, REVIEW_TEXTS_DIR: root }, encoding: 'utf8',
  });
  return { file, data, run, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('manual unknown-byline cross-domain repost is absent from the dry-run report and untouched by --fix', (t) => {
  const { file, run } = setup(t);
  const before = fs.readFileSync(file, 'utf8');
  const report = run('--json');
  assert.equal(report.status, 0, report.stderr);
  assert.deepEqual(JSON.parse(report.stdout), { count: 0, mismatches: [] });
  const fixed = run('--fix');
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /OK: no duplicateOf URL mismatches found/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('fix rechecks the current manual marker even when handed an old URL-mismatch finding', (t) => {
  const { file, data } = setup(t);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(clearDuplicateMismatch(file, data, {
    reason: 'url-mismatch', duplicateOf: data.duplicateOf, siblingUrl: fixture.primary.url,
  }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(data.duplicateOf, fixture.repost.duplicateOf);
  assert.equal(data.duplicateClearReason, undefined);
});

test('unrelated writes preserve the manual duplicate even if the caller omits protectedFields', (t) => {
  const { file, data, read } = setup(t);
  const incoming = { ...data, textStatus: 'updated' };
  delete incoming.protectedFields;
  assert.equal(safeWriteReview(file, incoming).wrote, true);
  assert.equal(read().duplicateOf, fixture.repost.duplicateOf);
  assert.equal(read().duplicateReason, fixture.repost.duplicateReason);
  assert.deepEqual(read().protectedFields, fixture.repost.protectedFields);
  assert.equal(read().textStatus, 'updated');
  assert.equal(read().duplicateClearReason, undefined);
});

for (const protectedFields of [undefined, [], ['assignedScore'], 'duplicateOf']) {
  test(`an unprotected stale pointer still reports and clears (${JSON.stringify(protectedFields)})`, (t) => {
    const { data, run, read } = setup(t, { protectedFields });
    assert.equal(isDuplicateOfUrlMismatch(data, fixture.primary), true);
    const report = run('--json');
    assert.equal(report.status, 1, report.stderr);
    assert.equal(JSON.parse(report.stdout).mismatches[0].reason, 'url-mismatch');
    const fixed = run('--fix');
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /Cleared 1 stale duplicateOf flag/);
    assert.equal(read().duplicateOf, null);
    assert.equal(read().duplicateReason, null);
  });
}

test('manual URL protection keeps structural corruption visible and repairable', (t) => {
  const { file, data, run, read } = setup(t);
  data.duplicateOf = 'showriz--unknown.json';
  fs.writeFileSync(file, JSON.stringify(data));
  const report = run('--json');
  assert.equal(report.status, 1, report.stderr);
  assert.equal(JSON.parse(report.stdout).mismatches[0].reason, 'self-reference');
  const fixed = run('--fix');
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.equal(read().duplicateOf, null);
});

test('the shared comparator preserves known syndication and trivial URL variants', () => {
  assert.equal(isDuplicateOfUrlMismatch(fixture.repost, fixture.primary), false);
  assert.equal(isDuplicateOfUrlMismatch({ url: 'https://original.example/review/?ref=share' }, fixture.primary), false);
  assert.equal(isDuplicateOfUrlMismatch({ ...fixture.repost, protectedFields: [], criticName: 'Jane Doe' }, fixture.primary), false);
  assert.equal(isDuplicateOfUrlMismatch({ ...fixture.repost, protectedFields: [], criticName: 'Someone Else' }, fixture.primary), true);
});
