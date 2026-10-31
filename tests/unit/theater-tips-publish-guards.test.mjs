/**
 * BRO-3511: guards that stop an empty/partial LLM draft or a structurally
 * damaged merge from overwriting good theater-metadata.json data. Requires the
 * real functions (CLAUDE.md §15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  buildMergedStructuredTips,
  draftHasContent,
  validateMergedMetadata,
} from '../../scripts/lib/theater-tips-merge.js';

const verified = { accessibility: { verified: true, wheelchair: true, elevator: true } };

describe('draftHasContent', () => {
  test('empty / missing drafts have no content', () => {
    assert.equal(draftHasContent(undefined), false);
    assert.equal(draftHasContent({}), false);
    assert.equal(draftHasContent({ lastUpdated: 'x', seating: {}, parking: {}, dining: {}, logistics: {} }), false);
    assert.equal(draftHasContent({ dining: { preShow: [], postShow: [] } }), false);
  });
  test('any single populated draft section counts', () => {
    assert.equal(draftHasContent({ seating: { bestSeats: 'x' } }), true);
    assert.equal(draftHasContent({ parking: { tip: 'x' } }), true);
    assert.equal(draftHasContent({ dining: { quickBite: [{ name: 'A' }] } }), true);
    assert.equal(draftHasContent({ logistics: { nearestSubway: '42 St' } }), true);
  });
  test('the merged output of an empty draft still looks populated (why the draft check is needed)', () => {
    const { structuredTips } = buildMergedStructuredTips({ lastUpdated: 'x' }, verified);
    assert.ok(structuredTips.seating.accessibility, 'accessibility injection alone fills seating');
    assert.equal(draftHasContent({ lastUpdated: 'x' }), false);
  });
});

describe('validateMergedMetadata', () => {
  const before = {
    _meta: {},
    A: { structuredTips: { seating: { sections: [{ name: 's' }] }, parking: { tip: 'p' } } },
    B: {},
  };
  test('identical / additive merge is clean', () => {
    const after = JSON.parse(JSON.stringify(before));
    after.B.structuredTips = { parking: { tip: 'n' } };
    assert.deepEqual(validateMergedMetadata(before, after), []);
  });
  test('flags dropped theater, lost structuredTips, lost sections, lost _meta', () => {
    const noTheater = { _meta: {}, A: before.A };
    assert.match(validateMergedMetadata(before, noTheater)[0], /theater dropped: B/);
    const noTips = { _meta: {}, A: {}, B: {} };
    assert.match(validateMergedMetadata(before, noTips)[0], /structuredTips lost: A/);
    const noSections = { _meta: {}, A: { structuredTips: { seating: {} } }, B: {} };
    assert.match(validateMergedMetadata(before, noSections)[0], /sections lost: A/);
    assert.equal(validateMergedMetadata(before, { A: before.A, B: {} }).length, 1);
  });
  test('real metadata merged with its own existing tips validates clean', () => {
    const file = new URL('../../data/theater-metadata.json', import.meta.url);
    if (!fs.existsSync(file)) return;
    const real = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(validateMergedMetadata(real, JSON.parse(JSON.stringify(real))), []);
  });
});

describe('generate-theater-tips.yml wiring', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/generate-theater-tips.yml', import.meta.url), 'utf8');
  test('has a non-cancelling concurrency group', () => {
    assert.match(y, /concurrency:\s*\n\s+group: generate-theater-tips\s*\n\s+cancel-in-progress: false/);
  });
  test('metadata is only staged behind merge+validate outcomes', () => {
    assert.match(y, /id: merge/);
    assert.match(y, /id: validate/);
    assert.doesNotMatch(y, /git add [^\n]*theater-metadata\.json[^\n]*theater-tips/);
    assert.match(y, /MERGE_OUTCOME: \$\{\{ steps\.merge\.outcome \}\}/);
  });
});
