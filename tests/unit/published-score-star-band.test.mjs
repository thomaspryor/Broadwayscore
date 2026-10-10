// BRO-4839: a PUBLISHED score must not contradict the critic's own high-reliability rating, whatever produced it.
// Real functions only (CLAUDE.md section 15); no copies of the rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const sb = require('../../scripts/lib/published-score-star-band.js');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');

const twoStar = { originalScore: '2/5 stars', originalScoreSource: 'unicode-stars', llmScore: { score: 39 } };
const fiveStar = { originalScore: '5/5 stars', originalScoreSource: 'unicode-stars', llmScore: { score: 96 } };

test('publishedScoreViolation: a printed 2/5 shown as 91, a printed 5/5 shown as 25 (the BRO-4838 reader reports)', () => {
  const a = sb.publishedScoreViolation(twoStar, 91);
  assert.equal(a.kind, 'star-band');
  assert.equal(a.floor, 31);
  assert.equal(a.ceiling, 50);
  assert.match(a.detail, /2\/5/);
  const b = sb.publishedScoreViolation(fiveStar, 25);
  assert.equal(b.kind, 'star-band');
  assert.equal(b.floor, 91);
});

test('publishedScoreViolation: inside the band, on the edges and within the 2-point tolerance is fine; just past it is not', () => {
  for (const s of [31, 40, 50, 52, 29]) assert.equal(sb.publishedScoreViolation(twoStar, s), null, String(s));
  assert.ok(sb.publishedScoreViolation(twoStar, 53));
  assert.ok(sb.publishedScoreViolation(twoStar, 28));
  assert.equal(sb.publishedScoreViolation(twoStar, 53, { tol: 3 }), null, 'tolerance is a parameter');
});

test('publishedScoreViolation: only a HIGH-reliability rating binds (a junk generic-pattern star does not)', () => {
  const junk = { originalScore: '1/5', originalScoreSource: 'numeric-stars', llmScore: { score: 85, confidence: 'high' } };
  assert.equal(sb.publishedScoreViolation(junk, 85), null);
  assert.equal(sb.publishedScoreViolation({ llmScore: { score: 49 } }, 90), null, 'no rating at all');
  assert.equal(sb.publishedScoreViolation(null, 90), null);
  assert.equal(sb.publishedScoreViolation(twoStar, null), null);
  assert.equal(sb.publishedScoreViolation(twoStar, NaN), null);
});

test('publishedScoreViolation: every model agreeing on a bucket the published score is far from (The Heiress, Les Mis)', () => {
  const heiress = { ensembleData: { modelAgreement: 'All 3 models agree: Rave' } };
  const v = sb.publishedScoreViolation(heiress, 20);
  assert.equal(v.kind, 'models-unanimous');
  assert.equal(sb.publishedScoreViolation(heiress, 70), null, 'within 15 of the Rave range');
  assert.equal(sb.publishedScoreViolation(heiress, 95), null);
  assert.equal(sb.publishedScoreViolation({ ensembleData: { modelAgreement: 'Majority agree: Rave' } }, 20), null, 'only a unanimous verdict counts');
  assert.equal(sb.publishedScoreViolation(heiress, 20, { unanimousTol: Infinity }), null, 'the auto-accept guard ignores it');
  assert.equal(sb.unanimousBucket({ ensembleData: { modelAgreement: 'All 4 models agree: Pan' } }), 'Pan');
  assert.equal(sb.unanimousBucket({ ensembleData: { modelAgreement: 'All 3 models agree: Splendid' } }), null);
});

test('hasPrimaryRating: the outlet\'s own fields count, a relay-only record does not', () => {
  assert.equal(sb.hasPrimaryRating({ originalScore: '4/5' }), true);
  assert.equal(sb.hasPrimaryRating({ starRating: 4 }), true);
  // BRO-4838: a numeric originalScore is an outlet rating stored on 0-100
  // (Guardian/Stage/Time Out svg stars). It binds only when the published-
  // rating test accepts it, which detectBandFromReviewFile applies.
  assert.equal(sb.hasPrimaryRating({ originalScore: 82 }), true);
  assert.equal(sb.publishedScoreViolation({ originalScore: 60, outletId: 'thestage', scoreSource: 'stage-star-svg' }, 90).kind, 'star-band');
  assert.equal(sb.publishedScoreViolation({ originalScore: 82, outletId: 'nytimes' }, 30), null, 'a stray number at an outlet with no ratings never binds');
  assert.equal(sb.hasPrimaryRating({ aggregatorStars: '3/5 stars', wetStars: '3/5' }), false);
  assert.equal(sb.publishedScoreViolation({ aggregatorStars: '3/5 stars' }, 90), null);
});

test('autoAcceptOutcome: accept in band; rescore when outside; block after the refusal cap so a daily drain cannot loop forever', () => {
  assert.equal(sb.autoAcceptOutcome(twoStar, 45).action, 'accept');
  const first = sb.autoAcceptOutcome(twoStar, 91);
  assert.deepEqual([first.action, first.refusals], ['rescore', 1]);
  assert.equal(sb.autoAcceptOutcome({ ...twoStar, autoAcceptRefusals: 1 }, 91).action, 'rescore');
  const capped = sb.autoAcceptOutcome({ ...twoStar, autoAcceptRefusals: 2 }, 91);
  assert.deepEqual([capped.action, capped.refusals], ['block', 3]);
  assert.equal(sb.autoAcceptOutcome({ ...twoStar, autoAcceptRefusals: 5 }, 45).action, 'accept', 'an in-band score is accepted whatever the history');
  assert.equal(sb.autoAcceptOutcome({ ...twoStar, autoAcceptRefusals: 2 }, 91, { maxRefusals: 5 }).action, 'rescore');
});

test('autoAcceptVerdict: an adjudication queue auto-accept never lands outside a high-reliability star band', () => {
  assert.equal(sb.autoAcceptVerdict(twoStar, 91).accept, false);
  assert.equal(sb.autoAcceptVerdict(twoStar, 91).violation.floor, 31);
  assert.equal(sb.autoAcceptVerdict(twoStar, 45).accept, true);
  assert.equal(sb.autoAcceptVerdict({ llmScore: { score: 91 } }, 91).accept, true, 'no rating: the LLM score may stand');
  const heiress = { ensembleData: { modelAgreement: 'All 3 models agree: Rave' } };
  assert.equal(sb.autoAcceptVerdict(heiress, 20).accept, true, 'unanimity does not gate an auto-accept, only the critic\'s rating does');
});

getBestScoreCases();

function getBestScoreCases() {
  // Devil Wears Prada WE 2024 WhatsOnStage: printed 2/5, "Auto-accepted ... LLM original score retained" at 91.
  const prada = () => ({
    outletId: 'whatsonstage', scoreSource: 'llm-v6', originalScore: '2/5 stars', originalScoreSource: 'unicode-stars',
    adjudicatedScore: 91, adjudicationNote: 'Auto-accepted after 3 uncertain adjudications - LLM original score retained',
    llmScore: { score: 91, confidence: 'high' }, ensembleData: {}, fullText: 'x'.repeat(300), dtliThumb: null, bwwThumb: null,
  });
  const run = (data) => { const stats = {}; const result = getBestScore(data, { stats, flagForHumanReview: () => {} }); return { result, stats }; };

  test('rebuild: an auto-accepted adjudication outside the critic\'s star band does not ship, even on an llm-v6 file', () => {
    const { result, stats } = run(prada());
    assert.deepEqual(result, { score: 40, source: 'originalScore-priority0' }, 'the critic\'s own 2/5 decides, not the auto-accepted 91');
    assert.equal(stats.adjudicationSkippedOutsideStarBand, 1);
  });

  test('rebuild: an adjudication INSIDE the star band still ships', () => {
    const d = prada(); d.adjudicatedScore = 45;
    const { result, stats } = run(d);
    assert.deepEqual(result, { score: 45, source: 'adjudicated' });
    assert.equal(stats.adjudicationSkippedOutsideStarBand, undefined);
  });

  test('rebuild: an adjudication that read the text and sided with the LLM against the star still stands (Electra)', () => {
    const d = prada();
    d.adjudicationNote = 'Auto-adjudicated (high confidence, sided with llm): the 5/5 is a mis-extraction on a negative review';
    d.adjudicatedScore = 91;
    const { result } = run(d);
    assert.equal(result && result.source, 'adjudicated');
  });

  test('rebuild: "sided with LLM" in any case is a reasoned dispute and stands (fiddler nytg: 72 notes use capitals)', () => {
    const d = prada();
    d.adjudicationNote = 'Auto-adjudicated (high confidence, sided with LLM): The review is clearly positive';
    assert.equal(run(d).result.source, 'adjudicated');
  });

  test('rebuild: only self-contradicting adjudications are skipped; a text dispute of a rating (thumbs / neither) stands', () => {
    for (const note of ['Auto-adjudicated (medium confidence, sided with thumbs): the printed grade is not in the text', 'Auto-adjudicated (high confidence, sided with neither): a pan whatever the grade says']) {
      const d = prada(); d.adjudicationNote = note;
      assert.equal(run(d).result.source, 'adjudicated', note);
    }
    const stars = prada(); stars.adjudicationNote = 'Auto-adjudicated (high confidence, sided with originalScore): the star is right';
    assert.notEqual(run(stars).result.source, 'adjudicated', 'a verdict that says it sided with the star but landed outside it contradicts itself');
  });

  test('rebuild: a rating that exists only as an aggregator relay does not bind (Oliver! on the Guardian two-show page)', () => {
    const d = prada(); delete d.originalScore; delete d.originalScoreSource;
    d.aggregatorStars = '3/5 stars'; d.adjudicatedScore = 81; d.adjudicationNote = 'Auto-accepted after 3 uncertain adjudications - LLM original score retained';
    assert.equal(run(d).result.source, 'adjudicated');
  });

  test('rebuild: no star at all, an adjudication is untouched', () => {
    const d = prada(); delete d.originalScore; delete d.originalScoreSource;
    const { result } = run(d);
    assert.deepEqual(result, { score: 91, source: 'adjudicated' });
  });
}

test('audit-star-band-drift reports published out-of-band scores joined from reviews.json, in any market, and --strict fails on them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4839-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
    const repo = path.join(import.meta.dirname, '..', '..');
    // A tiny repo copy: only the audit script, its lib dependencies by symlink, and fixture data.
    fs.cpSync(path.join(repo, 'scripts'), path.join(root, 'scripts'), { recursive: true, dereference: true, filter: (src) => !/node_modules|\.test\.|\/tests?\//.test(src) });
    fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'));
    fs.mkdirSync(path.join(root, 'data', 'review-texts', 'show-a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify({ shows: [{ id: 'show-a', category: 'west-end' }] }));
    const url = 'https://www.whatsonstage.com/reviews/devil-wears-prada/';
    fs.writeFileSync(path.join(root, 'data', 'review-texts', 'show-a', 'wos--critic.json'), JSON.stringify({ showId: 'show-a', outletId: 'whatsonstage', url, originalScore: '2/5 stars', originalScoreSource: 'unicode-stars', llmScore: { score: 39 } }));
    fs.writeFileSync(path.join(root, 'data', 'reviews.json'), JSON.stringify({ reviews: [{ showId: 'show-a', url: `${url}?utm_source=x`, assignedScore: 91, scoreSource: 'adjudicated' }] }));
    const json = path.join(root, 'out.json');
    const run = (args) => { try { return { code: 0, out: execFileSync('node', [path.join(root, 'scripts', 'audit-star-band-drift.js'), ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };
    const plain = run([`--json=${json}`]);
    if (plain.code !== 0) console.error(plain.out);
    assert.equal(plain.code, 0);
    assert.match(plain.out, /published: joined=1 outOfBand=1 bySource=\{"adjudicated":1\}/);
    const rows = JSON.parse(fs.readFileSync(json, 'utf8')).publishedOutOfBand;
    assert.equal(rows[0].kind, 'star-band');
    assert.equal(rows[0].score, 91);
    assert.equal(run(['--strict']).code, 1);
    fs.writeFileSync(path.join(root, 'data', 'reviews.json'), JSON.stringify({ reviews: [] }));
    assert.equal(run(['--strict']).code, 1, '--strict fails when nothing could be joined (a missing reviews.json must not read as clean)');
    fs.writeFileSync(path.join(root, 'data', 'reviews.json'), JSON.stringify({ reviews: [{ showId: 'show-a', url, assignedScore: 45, scoreSource: 'llm-v6' }] }));
    const clean = run(['--strict']);
    assert.equal(clean.code, 0);
    assert.match(clean.out, /published: joined=1 outOfBand=0/);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
