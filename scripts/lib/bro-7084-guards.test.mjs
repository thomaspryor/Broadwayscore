import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { evaluateEmptyBodySerpWrite } = require('./empty-body-serp-guard.js');
const { evaluateUndatedStageStub } = require('./undated-stage-stub-guard.js');
const { curtainupSuffixYear, isUrlYearOutsideWindow } = require('./content-filters.js');

// --- Empty-body SERP writes (BRO-4529) ---
test('empty-body SERP hit with an unrelated headline is refused', () => {
  const r = evaluateEmptyBodySerpWrite({ source: 'serp-discovery', serpTitle: 'Fire in My Mouth review: Wolfe and Alsop at the Barbican', showTitle: 'Fire Fire' });
  assert.equal(r.reject, true);
});
test('empty-body SERP hit naming the show passes', () => {
  const r = evaluateEmptyBodySerpWrite({ source: 'serp-discovery', serpTitle: 'Hadestown review: a sublime return', showTitle: 'Hadestown' });
  assert.equal(r.reject, false);
});
test('a hit with a body, a vetted source, or an unknown headline is not judged', () => {
  const base = { serpTitle: 'Totally unrelated', showTitle: 'Hadestown' };
  assert.equal(evaluateEmptyBodySerpWrite({ ...base, source: 'serp-discovery', fullText: 'x'.repeat(300) }).reject, false);
  assert.equal(evaluateEmptyBodySerpWrite({ ...base, source: 'show-score-playwright' }).reject, false);
  assert.equal(evaluateEmptyBodySerpWrite({ source: 'serp-discovery', showTitle: 'Hadestown' }).reject, false);
  assert.equal(evaluateEmptyBodySerpWrite({ source: 'serp-discovery', serpTitle: '', showTitle: 'Hadestown' }).reject, false);
});

// --- Undated The Stage stubs (BRO-6320, BRO-5759) ---
const STAGE = 'https://www.thestage.co.uk/reviews/now-you-see-me-live-review-london-coliseum-tim-lawson-simon-painter';
test('body-less, dateless, yearless Stage stub is parked', () => {
  assert.equal(evaluateUndatedStageStub({ outletId: 'thestage', url: STAGE }).park, true);
});
test('Stage stub with a date, a URL year, or a body is not parked; other outlets untouched', () => {
  assert.equal(evaluateUndatedStageStub({ outletId: 'thestage', url: STAGE, publishDate: '2026-10-02' }).park, false);
  assert.equal(evaluateUndatedStageStub({ outletId: 'thestage', url: 'https://www.thestage.co.uk/reviews/2026/foo' }).park, false);
  assert.equal(evaluateUndatedStageStub({ outletId: 'thestage', url: STAGE, fullText: 'A real body.' }).park, false);
  assert.equal(evaluateUndatedStageStub({ outletId: 'guardian', url: 'https://www.theguardian.com/stage/x' }).park, false);
});

// --- CurtainUp suffix year (existing rows listed on BRO-7084) ---
test('curtainupSuffixYear reads the two-digit slug suffix', () => {
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/bronxtalebway16.html'), 2016);
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/frozenbway18'), 2018);
  assert.equal(curtainupSuffixYear('https://www.curtainup.com/veryhungrycaterpillarshow.html'), null);
  assert.equal(curtainupSuffixYear('https://example.com/effect16.html'), null);
});
test('the four listed CurtainUp rows are outside their production windows; in-window passes', () => {
  assert.equal(isUrlYearOutsideWindow('https://www.curtainup.com/bronxtalebway16.html', 2007, 2008), true);
  assert.equal(isUrlYearOutsideWindow('https://www.curtainup.com/frozenbway18', 2004, 2004), true);
  assert.equal(isUrlYearOutsideWindow('https://www.curtainup.com/effect16.html', 2024, 2024), true);
  assert.equal(isUrlYearOutsideWindow('https://www.curtainup.com/fabulation18.html', 2024, 2024), true);
  assert.equal(isUrlYearOutsideWindow('https://www.curtainup.com/hadestown19.html', 2019, null), false);
});

// Plan file stays in step with the helper: every action's file is a CurtainUp row.
test('pending-fix plan covers exactly the four rows, with no review text', () => {
  const plan = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../data/pending-fixes/bro-7084.json'), 'utf8'));
  const files = [...new Set(plan.plan.actions.map(a => a.file))];
  assert.equal(files.length, 4);
  assert.ok(files.every(f => /curtainup--/.test(f)));
  assert.ok(plan.plan.actions.every(a => a.type === 'review-field-edit' && !('fullText' in a)));
});

// ship-check findings: abbreviated/aliased headlines must not be refused
test('empty-body guard accepts subtitle-stripped, aka and URL-slug matches', () => {
  const g = (serpTitle, showTitle, extra = {}) => evaluateEmptyBodySerpWrite({ source: 'serp-discovery', serpTitle, showTitle, ...extra }).reject;
  assert.equal(g('Sweeney Todd review: a gory triumph', 'Sweeney Todd: The Demon Barber of Fleet Street'), false);
  assert.equal(g('Les Mis review: still thrilling', 'Les Misérables', { akaTitles: ['Les Mis'] }), false);
  assert.equal(g('Review: a night out', 'The Pass', { url: 'https://x.com/2026/theater/the-pass-review.html' }), false);
});
test('curtainup suffix year is also what url-discovery reads for prior-run readmission', () => {
  const ud = require('./url-discovery.js');
  assert.equal(ud.urlYearOf('https://www.curtainup.com/effect16.html'), 2016);
});
