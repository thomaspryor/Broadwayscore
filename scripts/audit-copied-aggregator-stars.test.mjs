import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findCopiedStars, sameFamily } = require('./audit-copied-aggregator-stars.js');

const f = (file, data) => ({ file, data });
const dm = { outletId: 'daily-mail', criticName: 'Quentin Letts', url: 'https://www.dailymail.co.uk/a', aggregatorStars: '4/5' };
const mos = { outletId: 'mail-on-sunday', criticName: 'Georgina Brown', url: 'https://www.dailymail.co.uk/b', aggregatorStars: '4/5', assignedScore: 72 };

test('Mail on Sunday stars equal to the Daily Mail row are flagged as copied', () => {
  const rows = findCopiedStars([f('dm.json', dm), f('mos.json', mos)]);
  assert.deepEqual(rows.map((r) => r.file).sort(), ['dm.json', 'mos.json']);
});
test('stars with a source are never flagged; different stars are not copies', () => {
  assert.deepEqual(findCopiedStars([f('dm.json', dm), f('mos.json', { ...mos, aggregatorStarsSource: 'json-ld' })]).map((r) => r.file), ['dm.json']);
  assert.deepEqual(findCopiedStars([f('dm.json', dm), f('mos.json', { ...mos, aggregatorStars: '3/5' })]), []);
});
test('a different outlet family with equal stars is not flagged', () => {
  const g = { outletId: 'guardian', criticName: 'Arifa Akbar', url: 'https://www.theguardian.com/x', aggregatorStars: '4/5' };
  assert.deepEqual(findCopiedStars([f('dm.json', dm), f('g.json', g)]), []);
  assert.equal(sameFamily(dm, g), false);
});
test('findings never carry prose', () => {
  const rows = findCopiedStars([f('dm.json', { ...dm, fullText: 'SECRET PROSE' }), f('mos.json', mos)]);
  assert.doesNotMatch(JSON.stringify(rows), /SECRET PROSE/);
});
