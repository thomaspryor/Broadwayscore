// BRO-7901: a never-fetched stub for a print-only/defunct outlet is the collector's by-design end state, not a strand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { assessShow, findAgedStubs } = require('./uncollected-strand.js');
const { loadUncollectableOutlets } = require('./uncollectable-outlets.js');

const nowMs = Date.parse('2026-11-22T00:00:00Z');
const show = { id: 's', status: 'open', openingDate: '2026-09-01' };
const stub = (outletId) => ({ outletId, url: `https://example.com/${outletId}`, fullText: '', incompleteReason: 'not_attempted', firstSeenAt: '2026-11-01T00:00:00Z' });

test('starburst-magazine (registry accessModel defunct) is uncollectable and not a strand', () => {
  assert.ok(loadUncollectableOutlets().has('starburst-magazine'));
  assert.equal(assessShow(show, [{ file: 'starburst-magazine--ed-fortune.json', review: stub('starburst-magazine') }], { nowMs }).stranded.length, 0);
  assert.equal(findAgedStubs([{ file: 'a.json', review: stub('starburst-magazine') }], { nowMs }).length, 0);
});

test('a collectable outlet stub is still a strand (the guard did not blanket-silence the audit)', () => {
  assert.equal(assessShow(show, [{ file: 'thestage--x.json', review: stub('thestage') }], { nowMs }).stranded.length, 1);
  assert.equal(findAgedStubs([{ file: 'a.json', review: stub('thestage') }], { nowMs }).length, 1);
});

test('class guard: the collector and the audit share one uncollectable-outlet definition', () => {
  const collector = fs.readFileSync(new URL('../collect-review-texts.js', import.meta.url), 'utf8');
  assert.match(collector, /require\('\.\/lib\/uncollectable-outlets'\)/);
  assert.doesNotMatch(collector, /accessModel === 'print-only'/);
  const audit = fs.readFileSync(new URL('./uncollected-strand.js', import.meta.url), 'utf8');
  assert.match(audit, /isUncollectableOutlet/);
});
