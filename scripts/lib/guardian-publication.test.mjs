import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { GUARDIAN_API_FIELDS, guardianReviewOutletId, applyGuardianPublication } = require('./guardian-publication');
const { guardianContentToResult } = require('./guardian-api-result');
const { applyReviewFieldEdit, executeReviewFieldEditIn } = require('./review-field-edit');
const { createOrMergeReviewFile } = require('./review-file-writer');
const { validateUrlDomain } = require('./url-discovery');
const { hostMatchesOutletDomain } = require('./outlet-domain-validation');

const guardian = { outletId: 'guardian', outlet: 'The Guardian', url: 'https://www.theguardian.com/stage/2026/jun/01/grace-pervades-review', criticName: 'Susannah Clapp' };
const stamp = { fixId: 'bro-6848', at: '2026-11-07T00:00:00.000Z' };
const action = { type: 'review-field-edit', field: 'outletId', oldValue: 'guardian', newValue: 'observer' };

test('the shared API field list requests publication and the result carries it to the writer', () => {
  assert.ok(GUARDIAN_API_FIELDS.split(',').includes('publication'));
  const { result } = guardianContentToResult({ fields: { bodyText: 'Review body. '.repeat(40), publication: 'The Observer' } });
  assert.equal(result.apiMeta.publication, 'The Observer');
  const data = { ...guardian, criticName: 'A new critic' };
  applyGuardianPublication(data, result.apiMeta.publication);
  assert.equal(data.outletId, 'observer');
  assert.equal(data.outlet, 'Observer');
  assert.equal(data.guardianApi.publication, 'The Observer');
});

test('both writer and scoring domain guards accept the shared host in one direction only', () => {
  const registry = require('../../data/outlet-registry.json');
  for (const url of [guardian.url, 'https://www.guardian.co.uk/stage/review']) {
    assert.equal(validateUrlDomain(url, 'observer').valid, true);
    assert.equal(hostMatchesOutletDomain(url, 'observer', registry), true);
  }
  assert.equal(validateUrlDomain('https://observer.com/review', 'guardian').valid, false);
  assert.equal(hostMatchesOutletDomain('https://observer.com/review', 'guardian', registry), false);
  assert.equal(validateUrlDomain('https://theguardian.com.evil.example/review', 'observer').valid, false);
});

test('explicit publication takes precedence over the known byline', () => {
  for (const publication of ['The Guardian', 'theguardian.com', 'guardian.co.uk']) {
    assert.equal(guardianReviewOutletId(guardian, publication), 'guardian');
  }
  assert.equal(guardianReviewOutletId(guardian, 'Other publication'), 'guardian');
  assert.equal(guardianReviewOutletId({ ...guardian, outletId: 'observer' }, 'The Guardian'), 'guardian');
});

test('missing publication falls back only for the three identified Observer critics on Guardian hosts', () => {
  for (const criticName of ['Susannah Clapp', 'Kate Kellaway', 'Clare Brennan', '  SUSANNAH  CLAPP ']) {
    assert.equal(guardianReviewOutletId({ ...guardian, criticName }), 'observer');
  }
  for (const criticName of ['Arifa Akbar', 'Michael Billington', 'Unknown', '', 'Susannah Clapp and Arifa Akbar']) {
    assert.equal(guardianReviewOutletId({ ...guardian, criticName }), 'guardian');
  }
  for (const url of ['https://observer.com/review', 'https://theguardian.com.evil.example/review', null]) {
    assert.equal(guardianReviewOutletId({ ...guardian, url }), 'guardian');
  }
  assert.equal(guardianReviewOutletId({ ...guardian, outletId: 'sunday-times' }), 'sunday-times');
  assert.equal(guardianReviewOutletId({ ...guardian, url: 'https://www.guardian.co.uk/stage/review' }), 'observer');
});

test('API publication persists without altering an existing rating or verdict', () => {
  const data = { ...guardian, originalScore: '3/5', assignedScore: 62, wrongProduction: true, guardianApi: { byline: 'Susannah Clapp' } };
  applyGuardianPublication(data, 'The Observer');
  assert.deepEqual(data, { ...guardian, outletId: 'observer', outlet: 'Observer', originalScore: '3/5', assignedScore: 62, wrongProduction: true, guardianApi: { byline: 'Susannah Clapp', publication: 'The Observer' } });
});

test('approved field edits permit only the evidenced Observer downgrade and retain other guards', () => {
  const res = applyReviewFieldEdit(guardian, action, stamp);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.record.outletId, 'observer');
  assert.equal(res.record.outlet, 'Observer');
  assert.match(res.record.outletIdCorrectedReason, /Guardian-hosted Observer/);
  assert.equal(applyReviewFieldEdit({ ...guardian, criticName: 'Arifa Akbar' }, action, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ ...guardian, guardianApi: { publication: 'The Guardian' } }, action, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ ...guardian, _locked: true }, action, stamp).ok, false);
  assert.equal(applyReviewFieldEdit(guardian, { ...action, oldValue: 'observer' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({ ...guardian, outletId: 'observer', outlet: 'Observer' }, { ...action, oldValue: 'observer', newValue: 'guardian' }, stamp).ok, false);
});

test('the real approved-fix writer persists the relabel without changing score or flags', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-6848-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'show'));
  const file = 'show/guardian--susannah-clapp.json';
  const before = { ...guardian, showId: 'show', assignedScore: 82, wrongProduction: true };
  fs.writeFileSync(path.join(root, file), JSON.stringify(before));
  const result = executeReviewFieldEditIn(root, { ...action, file }, stamp);
  assert.equal(result.ok, true, result.reason);
  const after = JSON.parse(fs.readFileSync(path.join(root, file)));
  assert.equal(after.outletId, 'observer');
  assert.equal(after.assignedScore, 82);
  assert.equal(after.wrongProduction, true);
});

test('SERP and roundup writes name Observer files, while Guardian critics stay Guardian', t => {
  const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-6848-writer-'));
  t.after(() => fs.rmSync(reviewTextsDir, { recursive: true, force: true }));
  for (const source of ['serp-discovery', 'thestage-roundup', 'westendtheatre']) {
    for (const criticName of ['Susannah Clapp', 'Kate Kellaway', 'Clare Brennan', 'Arifa Akbar']) {
      const r = createOrMergeReviewFile('grace-pervades-west-end-2026', {
        ...guardian, criticName, source, fields: { showScoreExcerpt: 'A review excerpt.' },
      }, { dryRun: true, reviewTextsDir });
      assert.equal(r.action, 'new', `${source}/${criticName}: ${r.reason}`);
      assert.equal(path.basename(r.filepath).split('--')[0], criticName === 'Arifa Akbar' ? 'guardian' : 'observer');
    }
  }
  const explicitGuardian = createOrMergeReviewFile('grace-pervades-west-end-2026', {
    ...guardian, source: 'serp-discovery', fields: { showScoreExcerpt: 'A review excerpt.', guardianApi: { publication: 'The Guardian' } },
  }, { dryRun: true, reviewTextsDir });
  assert.equal(explicitGuardian.action, 'new');
  assert.match(explicitGuardian.filepath, /guardian--susannah-clapp\.json$/);

  const explicitObserver = createOrMergeReviewFile('grace-pervades-west-end-2026', {
    ...guardian, outletId: 'observer', outlet: 'Observer', criticName: 'A New Critic',
    source: 'thestage-roundup', fields: { showScoreExcerpt: 'A review excerpt.' },
  }, { dryRun: true, reviewTextsDir });
  assert.equal(explicitObserver.action, 'new');
  assert.match(explicitObserver.filepath, /observer--a-new-critic\.json$/);
});
