// BRO-6056: scripts/lib/default-critic-diversity.js decides when an outlet's
// defaultCritic is one of several critics and must not fill blank bylines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const {
  normName, isNamedByline, isSameCritic, yearOf,
  summarizeOutletBylines, classifyOutlet, findUnflaggedMultiAuthorOutlets,
} = require('./default-critic-diversity.js');
const { shouldFillDefaultCritic } = require('./critic-fill-rules.js');

const rec = (outletId, criticName, publishDate = '2025-01-01', extra = {}) => ({ outletId, criticName, publishDate, ...extra });

test('normName keeps initials and cuts byline suffixes', () => {
  assert.equal(normName('Matt Windman. Special to AmNewYork'), 'matt windman');
  assert.equal(normName('J. Kelly Nestruck'), 'j kelly nestruck');
  assert.equal(normName('Lisa R. Gauthier Mitchison'), 'lisa r gauthier mitchison');
  assert.equal(normName("Karen D'Souza"), "karen d'souza");
});

test('isNamedByline rejects Unknown, staff credits, outlet names and venues', () => {
  for (const n of ['Unknown', '', null, 'Star Tribune staff', 'The Globe and Mail', 'Schoenfeld Theatre']) {
    assert.equal(isNamedByline(n, 'The Globe and Mail'), false, String(n));
  }
  assert.equal(isNamedByline('Aisling Murphy', 'The Globe and Mail'), true);
});

test('isSameCritic matches spellings of the default, not other people', () => {
  assert.equal(isSameCritic('Kelly Nestruck', 'J. Kelly Nestruck'), true);
  assert.equal(isSameCritic('Tony Zinman', 'Toby Zinman'), true);
  assert.equal(isSameCritic('Jonathan', 'Jonathan Mandell'), true);
  assert.equal(isSameCritic('Matt Windman. Special to AmNewYork', 'Matt Windman'), true);
  assert.equal(isSameCritic('Howard Shapiro', 'Toby Zinman'), false);
  assert.equal(isSameCritic('David', 'Jonathan Mandell'), false);
});

test('yearOf reads ISO and prose dates', () => {
  assert.equal(yearOf('2009-12-09'), 2009);
  assert.equal(yearOf('April 12, 2019'), 2019);
  assert.equal(yearOf(null), null);
});

test('several other critics and a minority default: multi-author', () => {
  const outlets = { inq: { defaultCritic: 'Toby Zinman', displayName: 'Philadelphia Inquirer' } };
  const records = [
    ...Array.from({ length: 5 }, () => rec('inq', 'Howard Shapiro', '2008-01-01')),
    rec('inq', 'Toby Zinman', '2014-01-01'), rec('inq', 'Tony Zinman', '2011-01-01'),
    rec('inq', 'Gauri Mangala'), rec('inq', 'Unknown'),
  ];
  const s = summarizeOutletBylines(records, outlets).get('inq');
  assert.equal(s.defaultCount, 2);
  assert.equal(s.unnamedCount, 1);
  assert.deepEqual(s.defaultYears, [2011, 2014]);
  assert.deepEqual(s.others.map((o) => [o.name, o.count]), [['Howard Shapiro', 5], ['Gauri Mangala', 1]]);
  assert.equal(classifyOutlet(s).verdict, 'multi-author');
});

test('a dominant default with one-off guests stays single-author', () => {
  const outlets = { amny: { defaultCritic: 'Matt Windman' } };
  const records = [
    ...Array.from({ length: 40 }, () => rec('amny', 'Matt Windman')),
    rec('amny', 'Scott Brown'), rec('amny', 'Bob Krasner'), rec('amny', 'Alexa Lutter'),
  ];
  assert.equal(classifyOutlet(summarizeOutletBylines(records, outlets).get('amny')).verdict, 'single-author');
});

test('one other critic is not enough; flagged files do not count', () => {
  const outlets = { x: { defaultCritic: 'Ann Lee' } };
  const one = [rec('x', 'Bo Park'), rec('x', 'Bo Park'), rec('x', 'Ann Lee')];
  assert.equal(classifyOutlet(summarizeOutletBylines(one, outlets).get('x')).verdict, 'single-author');
  const flagged = [...one, rec('x', 'Cy Diaz', '2025-01-01', { wrongAttribution: true })];
  assert.equal(classifyOutlet(summarizeOutletBylines(flagged, outlets).get('x')).verdict, 'single-author');
  assert.equal(classifyOutlet(summarizeOutletBylines([...one, rec('x', 'Cy Diaz')], outlets).get('x')).verdict, 'multi-author');
});

test('findUnflaggedMultiAuthorOutlets skips multiAuthor true and reviewed false', () => {
  const records = ['a', 'b', 'c'].flatMap((id) => [rec(id, 'Ann Lee'), rec(id, 'Bo Park'), rec(id, 'Cy Diaz')]);
  const outlets = {
    a: { defaultCritic: 'Ann Lee' },
    b: { defaultCritic: 'Ann Lee', multiAuthor: true },
    c: { defaultCritic: 'Ann Lee', multiAuthor: false },
  };
  assert.deepEqual(findUnflaggedMultiAuthorOutlets(records, outlets).map((r) => r.outletId), ['a']);
});

test('the BRO-6056 candidate outlets no longer fill blank bylines from defaultCritic', () => {
  const reg = JSON.parse(readFileSync(new URL('../../data/outlet-registry.json', import.meta.url), 'utf8')).outlets;
  const marked = ['sfgate', 'philadelphia-inquirer', 'dc-theater-arts', 'theater-news-online', 'boston-globe',
    'cbsnews', 'the-sun', 'bbc-news', 'minneapolis-star-tribune', 'san-jose-mercury-news',
    'the-globe-and-mail', 'third-coast-review'];
  for (const id of marked) assert.equal(shouldFillDefaultCritic(reg[id]), false, id);
  // Reviewed and kept: one critic writes nearly every file.
  for (const id of ['amny', 'nyt-theater']) {
    assert.equal(reg[id].multiAuthor, false, id);
    assert.equal(shouldFillDefaultCritic(reg[id]), true, id);
  }
});
