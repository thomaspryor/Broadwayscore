import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { executeReviewFieldEditIn } = require('./review-field-edit');
const { runOutletMismatchCleanup } = require('./outlet-mismatch-heal');
const { safeRenameReview } = require('./review-write-guard');
const stamp = { fixId: 'bro-8409', at: '2026-11-27T00:00:00.000Z' };
const show = 'rename-fixture-2026';
const source = `${show}/timeout--adam-feldman.json`;
const target = `${show}/timeout-sydney--adam-feldman.json`;
const url = 'https://www.timeout.com/sydney/theatre/rename-fixture-review';
const action = { file: source, field: 'criticName', oldValue: 'Adam Feldman', newValue: 'Ben Neutze' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-edit-rename-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, show));
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), JSON.stringify(data));
  };
  const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  return { root, write, read };
}

test('BRO-8409: field edits follow the real outlet heal rename, retaining compare-and-set', (t) => {
  const { root, write, read } = fixture(t);
  write(source, { showId: show, outletId: 'timeout', outlet: 'Time Out', criticName: 'Adam Feldman', url });
  const healed = runOutletMismatchCleanup({ reviewTextsDir: root, showDirs: [show], log() {} });
  assert.equal(healed.renamedCount, 1);
  assert.equal(fs.existsSync(path.join(root, source)), false);
  const result = executeReviewFieldEditIn(root, action, stamp);
  assert.equal(result.ok, true, result.reason);
  assert.equal(read(target)._renamedFrom.url, url, 'the real rename writer binds the source URL');
  assert.match(result.msg, /timeout-sydney--adam-feldman/);
  assert.equal(read(target).criticName, 'Ben Neutze');
  assert.equal(read(target).url, url);
  assert.equal(read(target).approvedFixes.at(-1).fixId, stamp.fixId);
  assert.equal(fs.existsSync(path.join(root, source)), false, 'does not recreate the old path');
  const again = executeReviewFieldEditIn(root, action, stamp);
  assert.equal(again.ok, false);
  assert.match(again.reason, /changed since plan/);
});

test('BRO-8409: legacy edition heals require exact source-path and URL evidence', (t) => {
  const { root, write, read } = fixture(t);
  write(target, {
    showId: show, outletId: 'timeout-sydney', criticName: 'Adam Feldman', url,
    _renamedFrom: { file: source, at: stamp.at },
    outletIdCorrectedFrom: 'timeout',
    outletIdCorrectedReason: `url-edition: ${url} resolves to timeout-sydney (2026-11-27)`,
  });
  const result = executeReviewFieldEditIn(root, action, stamp);
  assert.equal(result.ok, true, result.reason);
  assert.equal(read(target).criticName, 'Ben Neutze');
});

test('BRO-8409: missing-path fallback refuses unproven, changed or ambiguous identities', (t) => {
  const { root, write, read } = fixture(t);
  const base = { showId: show, outletId: 'timeout-sydney', criticName: 'Adam Feldman', url,
    _renamedFrom: { file: source, at: stamp.at, url } };
  const variants = [
    { ...base, _renamedFrom: undefined },
    { ...base, _renamedFrom: { file: source, at: stamp.at } },
    { ...base, _renamedFrom: { ...base._renamedFrom, file: `other-show/timeout--adam-feldman.json` } },
    { ...base, url: `${url}-different` },
    { ...base, url: null },
    { ...base, _renamedFrom: { file: source, at: stamp.at }, outletIdCorrectedFrom: 'timeout',
      outletIdCorrectedReason: `url-edition: ${url}-different resolves to timeout-sydney (2026-11-27)` },
  ];
  for (const record of variants) {
    write(target, record);
    assert.equal(executeReviewFieldEditIn(root, action, stamp).ok, false);
    assert.deepEqual(read(target), JSON.parse(JSON.stringify(record)), 'refusal changes nothing');
  }
  write(target, base);
  write(`${show}/timeout-london--adam-feldman.json`, { ...base, outletId: 'timeout-london' });
  assert.equal(executeReviewFieldEditIn(root, action, stamp).ok, false, 'two proven candidates are ambiguous');
  assert.equal(read(target).criticName, 'Adam Feldman');
});

test('BRO-8409: a rename changing the critic slug or show never redirects a field edit', (t) => {
  const { root, write } = fixture(t);
  for (const destination of [`${show}/timeout-sydney--other-critic.json`, 'other-show/timeout-sydney--adam-feldman.json']) {
    write(source, { showId: show, outletId: 'timeout', criticName: 'Adam Feldman', url });
    assert.equal(safeRenameReview(path.join(root, source), path.join(root, destination)).wrote, true);
    assert.equal(executeReviewFieldEditIn(root, action, stamp).ok, false);
  }
});

test('BRO-8409: the rename writer binds the source URL when newData replaces it', (t) => {
  const { root, write, read } = fixture(t);
  const record = { showId: show, outletId: 'timeout', criticName: 'Adam Feldman', url };
  write(source, record);
  assert.equal(safeRenameReview(path.join(root, source), path.join(root, target), {
    newData: { ...record, outletId: 'timeout-sydney', url: `${url}-replacement` },
  }).wrote, true);
  assert.equal(read(target)._renamedFrom.url, url);
  assert.equal(executeReviewFieldEditIn(root, action, stamp).ok, false);
  assert.equal(read(target).criticName, 'Adam Feldman');
});

test('BRO-8409: an existing exact target takes precedence over a rename breadcrumb', (t) => {
  const { root, write, read } = fixture(t);
  write(source, { showId: show, outletId: 'timeout', criticName: 'Adam Feldman', url: `${url}-original` });
  write(target, { showId: show, outletId: 'timeout-sydney', criticName: 'Adam Feldman', url,
    _renamedFrom: { file: source, at: stamp.at, url } });
  assert.equal(executeReviewFieldEditIn(root, action, stamp).ok, true);
  assert.equal(read(source).criticName, 'Ben Neutze');
  assert.equal(read(target).criticName, 'Adam Feldman');
});
