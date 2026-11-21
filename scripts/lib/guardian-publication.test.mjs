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

// BRO-7593: Two Girls (2026) scored a Guardian feature as a 76 review.
const { guardianToneNonReviewReason, applyGuardianTone, GUARDIAN_API_TAGS } = require('./guardian-publication');

test('BRO-7593: a Guardian feature (tone/features, no star) is a non-review', () => {
  const content = { tags: [{ id: 'tone/features' }], starRating: null };
  assert.match(guardianToneNonReviewReason(content), /tone\/features/);
  const rec = { outletId: 'guardian', url: 'https://www.theguardian.com/stage/2026/oct/22/2-girls-1-cup-play-new-york-city' };
  assert.ok(applyGuardianTone(rec, content));
  assert.equal(rec.isNonReview, true);
  assert.deepEqual(rec.guardianApi.tones, ['tone/features']);
});

test('BRO-7593: real reviews, starred pieces and tagless items are left alone', () => {
  assert.equal(guardianToneNonReviewReason({ tags: [{ id: 'tone/reviews' }, { id: 'tone/features' }] }), null);
  assert.equal(guardianToneNonReviewReason({ tags: [{ id: 'tone/features' }], starRating: '4' }), null);
  // A music live review of a cabaret show is a review even with no star and no tone/reviews.
  assert.equal(guardianToneNonReviewReason({ tags: [{ id: 'tone/livereview' }] }), null);
  assert.equal(guardianToneNonReviewReason({ tags: [{ id: 'tone/albumreview' }] }), null);
  // An unfamiliar tone is not evidence.
  assert.equal(guardianToneNonReviewReason({ tags: [{ id: 'tone/sometone' }] }), null);
  assert.equal(guardianToneNonReviewReason({ tags: [{ id: 'tone/news' }], starRating: 3 }), null);
  assert.equal(guardianToneNonReviewReason({ tags: [] }), null);
  assert.equal(guardianToneNonReviewReason({}), null);
  assert.equal(guardianToneNonReviewReason(undefined), null);
});

test('BRO-7593: a manual clear keeps the row scored; the opening-night lane does not', () => {
  const content = { tags: [{ id: 'tone/comment' }] };
  const cleared = { nonReviewManualClear: true };
  assert.equal(applyGuardianTone(cleared, content), null);
  assert.equal(cleared.isNonReview, undefined);
  // Lane-stamped aggregator row (how Two Girls came in): the publisher's label still applies.
  const lane = { productionVerified: 'aggregator', bwwRoundupUrl: 'https://www.broadwayworld.com/x' };
  assert.ok(applyGuardianTone(lane, content));
  assert.equal(lane.isNonReview, true);
});

test('BRO-7593: the single-verdict hold and the reclassifier respect the publisher label', () => {
  const { evaluateSoloVerdictHold } = require('./single-verdict-guard');
  const { isPublisherTaggedNonReview } = require('./guardian-publication');
  const rec = {};
  applyGuardianTone(rec, { tags: [{ id: 'tone/features' }] });
  assert.equal(isPublisherTaggedNonReview(rec), true);
  assert.equal(evaluateSoloVerdictHold(rec, 'nonReview', {}).reason, 'hard-or-human-signal');
  const fs = require('fs');
  for (const f of ['scripts/classify-non-reviews.js', 'scripts/fix-non-review-misclassifications.js']) {
    assert.match(fs.readFileSync(f, 'utf8'), /isPublisherTaggedNonReview/, `${f} must not clear a publisher-tagged non-review`);
  }
});

test('BRO-7593: both API callers request the tone tags', () => {
  assert.equal(GUARDIAN_API_TAGS, 'tone');
  const fs = require('fs');
  for (const f of ['scripts/fetch-guardian-reviews.js', 'scripts/collect-review-texts.js']) {
    assert.match(fs.readFileSync(f, 'utf8'), /show-tags/, `${f} must request show-tags`);
  }
  const { result } = guardianContentToResult({ webTitle: 'x', tags: [{ id: 'tone/features' }], fields: { bodyText: 'y'.repeat(400) } });
  assert.deepEqual(result.apiMeta.toneContent.tags, [{ id: 'tone/features' }]);
});

test('BRO-7593: a fresh CV "review" verdict does not demote a Guardian tone flag', () => {
  const { isNonReviewDemotedByFreshCV } = require('./review-guards');
  const cv = { articleType: 'review', articleTypeConfidence: 'high', confidence: 'high', isValid: true, verifiedAt: '2099-01-01T00:00:00Z' };
  const flagged = { isNonReview: true, isNonReviewReason: 'guardian-tone: filed as tone/features, not tone/reviews (BRO-7593)', contentVerification: cv, bwwExcerpt: 'x', assignedScore: 76 };
  assert.equal(isNonReviewDemotedByFreshCV(flagged), false);
});

test('BRO-7593: rebuild does not let the opening-night lane skip a publisher-tagged non-review', () => {
  const { laneBypasses } = require('./opening-night-lane/trust-model');
  const rec = { isNonReview: true, isNonReviewReason: 'guardian-tone: filed as tone/features, not tone/reviews (BRO-7593)' };
  assert.equal(laneBypasses(rec, 'nonReview'), false);
});

test('BRO-7593: a classifier flag is upgraded to the publisher label; a human flag is kept', () => {
  const gem = { isNonReview: true, isNonReviewReason: 'gemini: interview' };
  assert.ok(applyGuardianTone(gem, { tags: [{ id: 'tone/interviews' }] }));
  assert.match(gem.isNonReviewReason, /^guardian-tone:/);
  const human = { isNonReview: true, isNonReviewReason: 'manual (not a review): owner call' };
  assert.equal(applyGuardianTone(human, { tags: [{ id: 'tone/features' }] }), null);
  assert.match(human.isNonReviewReason, /^manual/);
  const none = {};
  assert.equal(applyGuardianTone(none, { tags: [] }), null);
  assert.deepEqual(none.guardianApi.tones, []);
});
