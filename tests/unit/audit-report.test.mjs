// BRO-4973: an opening-night SERP record must not inherit another outlet's excerpt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { excerptFieldsToStrip } = require('../../scripts/lib/cloned-excerpt-guard');
const { safeWriteReview } = require('../../scripts/lib/review-write-guard');
const { EXCERPT_FIELDS } = require('../../scripts/lib/excerpt-fields');
const { SUSPECT_SOURCES } = require('../../scripts/lib/unvetted-serp-sources');

const excerpt = 'The cast brings warmth and precision to a complicated story, although the final scene leaves its central question unanswered.';
const owner = {
  file: 'nytg--joe-dziemianowicz.json',
  data: {
    outletId: 'nytg', criticName: 'Joe Dziemianowicz', source: 'bww-roundup',
    bwwExcerpt: excerpt,
    fullText: `A thoughtful production with a strong ensemble. ${excerpt} ${'The staging rewards close attention. '.repeat(30)}`,
  },
};
const incoming = {
  outletId: 'culturesauce', criticName: 'Unknown', source: 'serp-discovery',
  fullText: null, bwwExcerpt: excerpt,
};
const fields = (data, siblings = [owner]) => excerptFieldsToStrip('culturesauce--unknown.json', data, siblings).fields;

test('opening-night audit rejects a sibling outlet excerpt on an Unknown SERP record', () => {
  assert.deepEqual(fields(incoming), ['bwwExcerpt']);
});

test('shortened and punctuation-normalized copies cannot evade the guard', () => {
  assert.deepEqual(fields({ ...incoming, bwwExcerpt: excerpt.slice(0, 90) + '...' }), ['bwwExcerpt']);
  assert.deepEqual(fields({ ...incoming, bwwExcerpt: excerpt.toUpperCase() }), ['bwwExcerpt']);
  assert.deepEqual(fields(incoming, [{ ...owner, data: { ...owner.data, bwwExcerpt: excerpt.slice(0, 90) + '...' } }]), ['bwwExcerpt']);
});

test('a repaired byline and independently fetched article still lose a foreign excerpt', () => {
  assert.deepEqual(fields({ ...incoming, criticName: 'Thom Geier', fullText: 'An entirely different review with its own verdict. '.repeat(40) }), ['bwwExcerpt']);
});

test('all aggregator excerpt fields use the real shared guard', () => {
  for (const field of EXCERPT_FIELDS) {
    assert.deepEqual(fields({ ...incoming, bwwExcerpt: null, [field]: excerpt }), [field]);
  }
});

test('all unvetted SERP callers are covered; curated aggregator and manual records keep their excerpts', () => {
  for (const source of SUSPECT_SOURCES) {
    assert.deepEqual(fields({ ...incoming, source }), ['bwwExcerpt']);
  }
  for (const source of ['bww-roundup', 'playbill-verdict', 'manual-entry', 'submit-review-form']) {
    assert.deepEqual(fields({ ...incoming, source }), []);
  }
});

test('independent evidence, unrelated excerpts and short boilerplate remain untouched', () => {
  assert.deepEqual(fields({ ...incoming, fullText: owner.data.fullText }), []);
  assert.deepEqual(fields({ ...incoming, bwwExcerpt: 'A different critic reaches a different conclusion about the ensemble and its memorable final scene.' }), []);
  assert.deepEqual(fields({ ...incoming, bwwExcerpt: 'A warm evening.' }), []);
});

test('an unsupported, excluded or self sibling cannot establish ownership', () => {
  assert.deepEqual(fields(incoming, [{ ...owner, data: { ...owner.data, fullText: null } }]), []);
  assert.deepEqual(fields(incoming, [{ ...owner, data: { ...owner.data, wrongProduction: true } }]), []);
  assert.deepEqual(fields(incoming, [{ ...owner, file: 'culturesauce--unknown.json' }]), []);
});

test('the receiving outlet keeps unrelated excerpts when one field is foreign', () => {
  const ownExcerpt = 'This critic praises the music and offers an entirely separate assessment of the direction.';
  assert.deepEqual(fields({ ...incoming, dtliExcerpt: ownExcerpt }), ['bwwExcerpt']);
});

test('the existing review writer strips the foreign excerpt before persisting a SERP record', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4973-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, owner.file), JSON.stringify(owner.data));
  const file = path.join(dir, 'culturesauce--unknown.json');
  const result = safeWriteReview(file, { showId: 'audit-fixture-2026', ...incoming });
  assert.equal(result.wrote, true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.bwwExcerpt, null);
  assert.equal(saved.criticName, 'Unknown');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, owner.file), 'utf8')).bwwExcerpt, excerpt);
});
