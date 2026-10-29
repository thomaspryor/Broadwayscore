import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { movePlanWarnings } = require('./move-plan-checks.js');
const { preflight } = require('./preflight-review-fix-plan.js');

const URL = 'https://www.whatsonstage.com/news/arcadia-review_1726588/';
const move = { type: 'review-file-op', operation: 'move', sourcePath: 'arcadia-west-end-2026/wos--alex-wood.json', destPath: 'arcadia-dy-west-end-2026/wos--alex-wood.json' };
const fake = (files) => ({
  readJson: (rel) => files[rel] || null,
  listFolder: (folder) => Object.keys(files).filter((k) => k.startsWith(`${folder}/`)).map((k) => k.split('/')[1]),
});

// BRO-6488 shape 1: a content-check verdict naming the destination production stays set after the move.
test('warns when a moved file keeps a content-check wrongProduction the plan does not clear', () => {
  const files = { [move.sourcePath]: { url: URL, wrongProduction: true, wrongProductionReason: 'CV-promoted: reviews the transfer venue' } };
  const w = movePlanWarnings(move, [move], fake(files));
  assert.equal(w.length, 1);
  assert.match(w[0], /keeps wrongProduction=true.*wrongProductionManualClear/);
  // the same plan clearing it on the destination silences the warning
  const clear = { type: 'review-field-edit', file: move.destPath, field: 'wrongProductionManualClear', oldValue: null, newValue: true };
  assert.deepEqual(movePlanWarnings(move, [move, clear], fake(files)), []);
  // a clear on the SOURCE path does not count (the executor edits the moved file at destPath)
  assert.equal(movePlanWarnings(move, [move, { ...clear, file: move.sourcePath }], fake(files)).length, 1);
});

test('no flag warning when review-file-move will auto-clear it, or there is no flag', () => {
  const folderOnly = { url: URL, wrongProduction: true, wrongProductionNote: 'File showId "x" doesn\'t match directory "arcadia-west-end-2026" — placed in wrong production directory' };
  assert.deepEqual(movePlanWarnings(move, [move], fake({ [move.sourcePath]: folderOnly })), []);
  assert.deepEqual(movePlanWarnings(move, [move], fake({ [move.sourcePath]: { url: URL } })), []);
  // a wrongShow verdict is reported on its own marker
  const ws = movePlanWarnings(move, [move], fake({ [move.sourcePath]: { url: URL, wrongShow: true, wrongShowReason: 'CV-promoted: other production' } }));
  assert.match(ws[0], /wrongShowManualClear/);
});

// BRO-6488 shape 2: a second copy of the same url (an "unknown" byline) stays on the source folder.
test('warns about a same-url twin left in the source folder unless the plan handles it', () => {
  const files = {
    [move.sourcePath]: { url: URL },
    'arcadia-west-end-2026/wos--unknown.json': { url: 'http://whatsonstage.com/news/arcadia-review_1726588' },
    'arcadia-west-end-2026/wos--sarah-crompton.json': { url: 'https://www.whatsonstage.com/news/other_1/' },
  };
  const w = movePlanWarnings(move, [move], fake(files));
  assert.equal(w.length, 1);
  assert.match(w[0], /wos--unknown\.json holds the same url/);
  const del = { type: 'review-file-op', operation: 'delete', sourcePath: 'arcadia-west-end-2026/wos--unknown.json' };
  assert.deepEqual(movePlanWarnings(move, [move, del], fake(files)), []);
});

test('ignores non-move actions and a missing source', () => {
  assert.deepEqual(movePlanWarnings({ type: 'review-file-op', operation: 'delete', sourcePath: 'a/b.json' }, [], fake({})), []);
  assert.deepEqual(movePlanWarnings(move, [move], fake({})), []);
});

test('preflight() prints the warnings against a real tree and still passes the plan', () => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-tree-'));
  fs.mkdirSync(path.join(tree, 'arcadia-west-end-2026'));
  fs.writeFileSync(path.join(tree, move.sourcePath), JSON.stringify({ url: URL, wrongProduction: true, wrongProductionReason: 'CV-promoted' }));
  fs.writeFileSync(path.join(tree, 'arcadia-west-end-2026/wos--unknown.json'), JSON.stringify({ url: URL }));
  const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-plan-')), 'p.json');
  fs.writeFileSync(planPath, JSON.stringify({ issueNumber: 'p', status: 'pending', plan: { actions: [move] } }));
  const lines = [];
  const { failed } = preflight([planPath], { reviewTextsDir: tree, coreDataDir: tree, log: (l) => lines.push(l) });
  assert.equal(failed, 0);
  assert.equal(lines.filter((l) => l.includes('WARN p:')).length, 2);
});
