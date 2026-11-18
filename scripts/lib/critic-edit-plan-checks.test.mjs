import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { criticEditPlanProblems } = require('./critic-edit-plan-checks.js');

const fake = (files) => ({
  readJson: (rel) => files[rel] || null,
  listFolder: (folder) => Object.keys(files).filter((k) => k.startsWith(`${folder}/`)).map((k) => k.split('/')[1]),
});

// bro-7745-cousins shape 1 (jitney-2017): the show already had the critic's own file for the same article.
const jitney = {
  'jitney-2017/theatermania--david-gordon.json': { outletId: 'theatermania', criticName: 'David Gordon', url: 'https://www.theatermania.com/news/jitney_79744/' },
  'jitney-2017/theatermania--zachary-stewart.json': { outletId: 'theatermania', criticName: 'Zachary Stewart', url: 'https://www.theatermania.com/broadway/reviews/jitney_79744.html' },
  'jitney-2017/nytimes--ben-brantley.json': { outletId: 'nytimes', criticName: 'Ben Brantley' },
};
const recredit = { type: 'review-field-edit', file: 'jitney-2017/theatermania--david-gordon.json', field: 'criticName', oldValue: 'David Gordon', newValue: 'Zachary Stewart' };

test('flags a re-credit that makes a same-outlet, same-critic twin', () => {
  const p = criticEditPlanProblems(recredit, [recredit], fake(jitney));
  assert.equal(p.length, 1);
  assert.match(p[0], /twin of jitney-2017\/theatermania--zachary-stewart\.json/);
});

test('no twin once the plan deletes one of the pair, or the other file is a marked duplicate', () => {
  const del = { type: 'review-file-op', operation: 'delete', sourcePath: 'jitney-2017/theatermania--zachary-stewart.json' };
  assert.deepEqual(criticEditPlanProblems(recredit, [recredit, del], fake(jitney)), []);
  const marked = { ...jitney, 'jitney-2017/theatermania--zachary-stewart.json': { ...jitney['jitney-2017/theatermania--zachary-stewart.json'], duplicateOf: 'theatermania--david-gordon.json' } };
  assert.deepEqual(criticEditPlanProblems(recredit, [recredit], fake(marked)), []);
});

test('a different critic, or a different outlet with the same critic, is not a twin', () => {
  assert.deepEqual(criticEditPlanProblems({ ...recredit, newValue: 'Kenji Fujishima' }, [], fake(jitney)), []);
  const otherOutlet = { ...jitney, 'jitney-2017/nytimes--ben-brantley.json': { outletId: 'nytimes', criticName: 'Zachary Stewart' } };
  assert.equal(criticEditPlanProblems(recredit, [recredit], fake(otherOutlet)).length, 1);
});

test('no twin when the plan flags, moves or renames the other file, or the edit is a no-op', () => {
  const other = 'jitney-2017/theatermania--zachary-stewart.json';
  for (const [field, newValue] of [['duplicateOf', 'theatermania--david-gordon.json'], ['wrongProduction', true], ['wrongShow', true]]) {
    const flag = { type: 'review-field-edit', file: other, field, oldValue: null, newValue };
    assert.deepEqual(criticEditPlanProblems(recredit, [recredit, flag], fake(jitney)), [], field);
  }
  for (const operation of ['move', 'rename']) {
    const mv = { type: 'review-file-op', operation, sourcePath: other, destPath: 'jitney-revival/theatermania--zachary-stewart.json' };
    assert.deepEqual(criticEditPlanProblems(recredit, [recredit, mv], fake(jitney)), [], operation);
  }
  const noop = { ...recredit, file: other, oldValue: 'Zachary Stewart', newValue: 'Zachary Stewart' };
  const pre = { ...jitney, 'jitney-2017/theatermania--david-gordon.json': { ...jitney['jitney-2017/theatermania--david-gordon.json'], criticName: 'Zachary Stewart' } };
  assert.deepEqual(criticEditPlanProblems(noop, [noop], fake(pre)), []);
});

test('no flag when the edited file itself is being excluded', () => {
  const self = { type: 'review-field-edit', file: recredit.file, field: 'wrongProduction', oldValue: null, newValue: true };
  assert.deepEqual(criticEditPlanProblems(recredit, [recredit, self], fake(jitney)), []);
});

// bro-7745-cousins shape 2 (rent-west-end-2026): the stored text prints a different credit than the new name.
const rentFile = 'rent-west-end-2026/theatreandtonic--penny-walshe.json';
const rent = (credit) => ({ [rentFile]: { outletId: 'theatreandtonic', criticName: 'Penny Walshe', url: 'https://theatreandtonic.co.uk/blog/rent-at-tom-stoppard-theatre-review', fullText: `Written by Penny Walshe It has been a long time. Written by ${credit} for Theatre and Tonic, October 2026.` } });
const toRoby = { type: 'review-field-edit', file: rentFile, field: 'criticName', oldValue: 'Penny Walshe', newValue: 'Roby' };

test('flags a credit the rebuild will undo from the stored text', () => {
  const p = criticEditPlanProblems(toRoby, [toRoby], fake(rent('Penny')));
  assert.equal(p.length, 1);
  assert.match(p[0], /undone by the rebuild.*"Penny"/);
});

test('no flag when the stored text prints the new name', () => {
  assert.deepEqual(criticEditPlanProblems(toRoby, [toRoby], fake(rent('Roby'))), []);
});

test('no printed-credit flag when the plan refreshes the stored text (url edit or run-script)', () => {
  const url = { type: 'review-field-edit', file: rentFile, field: 'url', oldValue: 'x', newValue: 'https://theatreandtonic.co.uk/blog/rent-review-2' };
  assert.deepEqual(criticEditPlanProblems(toRoby, [toRoby, url], fake(rent('Penny'))), []);
  assert.deepEqual(criticEditPlanProblems(toRoby, [toRoby, { type: 'run-script', script: 'scripts/x.js' }], fake(rent('Penny'))), []);
});

test('preflight() fails the bro-7745-cousins jitney shape against a real tree', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { preflight } = require('./preflight-review-fix-plan.js');
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'cepc-tree-'));
  fs.mkdirSync(path.join(tree, 'jitney-2017'));
  for (const [rel, data] of Object.entries(jitney)) fs.writeFileSync(path.join(tree, rel), JSON.stringify(data));
  const planPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cepc-plan-')), 'p.json');
  fs.writeFileSync(planPath, JSON.stringify({ issueNumber: 'p', status: 'pending', plan: { actions: [recredit] } }));
  const lines = [];
  const { failed } = preflight([planPath], { reviewTextsDir: tree, coreDataDir: tree, log: (l) => lines.push(l) });
  assert.ok(failed >= 1, lines.join('\n'));
  assert.ok(lines.some((l) => /FAIL p: .*twin of jitney-2017\/theatermania--zachary-stewart\.json/.test(l)), lines.join('\n'));
});
