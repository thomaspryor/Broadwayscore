/**
 * BRO-5259: the web-search byline sweep (scripts/sweep-websearch-bylines.js,
 * scripts/lib/byline-sweep.js, check-byline-evidence.js checkOne).
 * Run: node --test scripts/check-byline-evidence.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSweepCandidate, criticPattern, classifyEvidence, planEdits } = require('./lib/byline-sweep.js');
const { matchContexts } = require('./lib/byline-evidence.js');
const { checkOne } = require('./check-byline-evidence.js');
const { readResults } = require('./sweep-websearch-bylines.js');
const { actionsFromArgs } = require('./new-fix-plan.js');
const { applyReviewFieldEdit } = require('./lib/review-field-edit.js');

const base = () => ({
  showId: 'side-show-2014', outletId: 'theatermania', outlet: 'TheaterMania', criticName: 'David Gordon',
  url: 'https://www.theatermania.com/broadway/reviews/side-show_70742.html', source: 'web-search',
  assignedScore: 72, fullText: 'A short generic summary of the show.', contentTier: 'truncated',
});

test('candidates: scored, summary-length, legacy web-search only, unflagged', () => {
  assert.equal(isSweepCandidate(base()), true);
  assert.equal(isSweepCandidate({ ...base(), sources: ['web-search', 'bww-roundup'] }), false, 'an aggregator vouched for it');
  assert.equal(isSweepCandidate({ ...base(), assignedScore: null }), false);
  assert.equal(isSweepCandidate({ ...base(), fullText: 'x'.repeat(500) }), false);
  assert.equal(isSweepCandidate({ ...base(), fabricatedEntry: true }), false);
  assert.equal(isSweepCandidate({ ...base(), fabricatedEntry: false }), false, 'a human clear stays');
  assert.equal(isSweepCandidate({ ...base(), wrongAttribution: true }), false);
  assert.equal(isSweepCandidate({ ...base(), isNonReview: true }), false);
  assert.equal(isSweepCandidate({ ...base(), crossOutletVerified: true }), false, 'already confirmed');
  assert.equal(isSweepCandidate({ ...base(), source: 'dtli' }), false);
});

test('critic pattern needs first and last name: a surname in a cast list is not a byline', () => {
  const re = new RegExp(criticPattern('Jesse Green'), 'i');
  const castList = '<p>along with Alexa Green, Bryna O\'Neill and Libby Servais</p>';
  assert.deepEqual(matchContexts(castList, re), []);
  assert.equal(matchContexts('<p>By Jesse Green | April 4, 2017</p>', re).length, 1);
  assert.ok(new RegExp(criticPattern('Charles McNulty'), 'i').test('Review by Charles McNulty'));
  assert.ok(new RegExp(criticPattern('Elysa Gardner'), 'i').test('Elysa D. Gardner'));
  assert.ok(new RegExp(criticPattern('José Solís'), 'i').test('By Jose Solis'));
  assert.equal(criticPattern('Staff'), null);
  assert.equal(criticPattern(''), null);
});

test('verdicts', () => {
  const row = { ...base(), criticName: 'Jesse Green' };
  const url = row.url;
  assert.equal(classifyEvidence(row, { url, via: 'none', statusLive: 404, authors: [], matches: [] }).verdict, 'url-dead');
  assert.equal(classifyEvidence(row, { url, via: 'none', statusLive: 410, authors: [], matches: [] }).verdict, 'url-dead');
  assert.equal(classifyEvidence(row, { url, via: 'none', statusLive: 403, authors: [], matches: [] }).verdict, 'unread', 'a paywall/block proves nothing');
  assert.equal(classifyEvidence(row, { url, via: 'none', statusLive: 0, authors: [], matches: [] }).verdict, 'unread');
  assert.equal(classifyEvidence(row, { url, via: 'live', authors: ['meta: Jesse Green'], matches: [] }).verdict, 'confirmed');
  assert.equal(classifyEvidence(row, { url, via: 'live', authors: [], matches: ['By Jesse Green'] }).verdict, 'confirmed');
  const other = classifyEvidence(row, { url, via: 'wayback', snapshot: 'https://web.archive.org/web/2017/x', authors: ['meta: Zachary Stewart'], matches: [] });
  assert.equal(other.verdict, 'byline-other');
  assert.equal(other.evidenceUrl, 'https://web.archive.org/web/2017/x', 'the snapshot is the evidence');
  assert.match(other.note, /Zachary Stewart/);
  // The TheaterMania hand-check: the url redirected to an unrelated page whose
  // cast list held "Alexa Green". Surname-only text is not a confirmation.
  assert.equal(classifyEvidence(row, { url, via: 'live', authors: ['meta: Alexa Green'], matches: [] }).verdict, 'byline-other');
  assert.equal(classifyEvidence(row, { url, via: 'live', authors: ['byline: By Alexa Green'], matches: [] }).verdict, 'no-signal', 'a page-text By guess is not proof');
  assert.equal(classifyEvidence(row, { url, via: 'live', authors: [], matches: [] }).verdict, 'no-signal');
});

function applyEdits(row, edits) {
  let rec = { ...row };
  const actions = actionsFromArgs(edits.map((e) => `--review-edit=${e}`));
  for (const a of actions) {
    const r = applyReviewFieldEdit(rec, { ...a, oldValue: rec[a.field] === undefined ? null : rec[a.field] }, 'BRO-5259 test');
    assert.ok(r.ok, `${a.field}: ${r.reason}`);
    rec = r.record || { ...rec, [a.field]: a.newValue };
  }
  return { actions, rec };
}

test('plan edits: confirmed records the evidence url; byline-other sets wrongAttribution; both pass the executor', () => {
  const key = 'side-show-2014/theatermania--david-gordon.json';
  const row = base();
  const conf = planEdits(key, row, { verdict: 'confirmed', evidenceUrl: row.url, note: 'live page names David Gordon' });
  const c = applyEdits(row, conf);
  assert.deepEqual(c.actions.map((a) => [a.file, a.field, a.newValue === true]), [
    [key, 'crossOutletVerifiedNote', false], [key, 'crossOutletVerified', true]]);
  assert.ok(c.actions[0].newValue.includes(row.url));

  const wrong = planEdits(key, row, { verdict: 'byline-other', evidenceUrl: row.url, note: 'live page credits Zachary Stewart, never David Gordon' });
  const w = applyEdits(row, wrong);
  assert.deepEqual(w.actions.map((a) => a.field), ['wrongAttribution', 'wrongAttributionReason']);
  assert.equal(w.actions[0].newValue, true);
  assert.ok(w.actions[1].newValue.includes(row.url));

  for (const verdict of ['url-dead', 'unread', 'no-signal']) {
    assert.deepEqual(planEdits(key, row, { verdict, evidenceUrl: row.url, note: 'x' }), [], verdict);
  }
  assert.deepEqual(planEdits(key, row, { verdict: 'confirmed', evidenceUrl: null, note: 'x' }), [], 'no evidence url, no edit');
});

test('checkpoint: results read back from JSONL and from saved cloud-run stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5259-'));
  const f = path.join(dir, 'out.txt');
  fs.writeFileSync(f, [
    '{"key":"a/x.json","verdict":"unread"}',
    'noise line',
    '2026-11-16T00:00:00Z SWEEP {"key":"b/y.json","verdict":"confirmed"}',
    'SWEEP {"key":"c/z.json","verd',
  ].join('\n'));
  const m = readResults(f);
  assert.deepEqual([...m.keys()], ['a/x.json', 'b/y.json']);
  assert.equal(readResults(path.join(dir, 'missing')).size, 0);
  assert.equal(typeof checkOne, 'function');
});

// BRO-7569/5259 ship-check regressions: a verdict against the row needs a real pattern and a strong author signal
{
  const { classifyEvidence, criticPattern } = createRequire(import.meta.url)('./lib/byline-sweep.js');
  const page = (authors, matches = []) => ({ via: 'live', url: 'https://x.test/a', authors, matches });
  test('initials name never gets byline-other', () => {
    assert.notEqual(classifyEvidence({ criticName: 'A. O. Scott' }, page(['meta: A. O. Scott'])).verdict, 'byline-other');
    assert.equal(criticPattern('A.O. Scott'), null);
  });
  test('suffix and accents still match', () => {
    assert.equal(classifyEvidence({ criticName: 'Frank Scheck Jr.' }, page(['meta: Frank Scheck'])).verdict, 'confirmed');
    assert.equal(classifyEvidence({ criticName: 'Jose Solis' }, page(['meta: José Solís'])).verdict, 'confirmed');
  });
  test('house credits and text "By" guesses are not another author', () => {
    assert.notEqual(classifyEvidence({ criticName: 'Jesse Green' }, page(['meta: Variety Staff', 'byline: By Act Two'])).verdict, 'byline-other');
  });
  test('a real different meta author is byline-other', () => {
    assert.equal(classifyEvidence({ criticName: 'Jesse Green' }, page(['meta: Alexa Smith'])).verdict, 'byline-other');
  });
  test('sidebar mention beside another credited author is not confirmed', () => {
    assert.notEqual(classifyEvidence({ criticName: 'Jesse Green' }, page(['meta: Alexa Smith'], ['Jesse Green'])).verdict, 'confirmed');
  });
}
