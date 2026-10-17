// BRO-4383 — scored reviews whose text is a different article.
// Drives the REAL screen + safeWriteReview (rule 15), no copied logic.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { screenWrongArticle } = require('./wrong-article-screen.js');
const guard = require('./review-write-guard.js');

const SHOW = {
  id: 'zz-bro4383-little-bear-2025',
  title: 'Little Bear Ridge Road',
  venue: 'Booth Theatre',
  cast: [{ name: 'Laurie Metcalf' }, { name: 'Micah Stock' }],
  creativeTeam: [{ name: 'Will Frears' }],
};
const filler = (n) => 'The staging is dense and the writing circles a wounded family. '.repeat(n);
const WRONG = `This solo play co-written by Jen Tullock follows an author. ${filler(40)}`;
const RIGHT_NAMED = `Little Bear Ridge Road opens with a phone call. ${filler(20)} By the end Little Bear Ridge Road has earned its title. ${filler(20)}`;
const RIGHT_CAST = `Laurie Metcalf plays an aunt with a raw wit. ${filler(40)}`;
const ONE_MENTION = `Every pied piper leads somewhere. Little Bear Ridge Road, once. ${filler(40)}`;

test('screen: text that never names the show and has no cast/venue evidence is suspect', () => {
  const r = screenWrongArticle(WRONG, SHOW);
  assert.deepStrictEqual([r.applicable, r.suspect, r.titleMentions], [true, true, 0]);
});

test('screen: title mention or cast evidence clears the text', () => {
  assert.strictEqual(screenWrongArticle(RIGHT_NAMED, SHOW).suspect, false);
  assert.strictEqual(screenWrongArticle(RIGHT_CAST, SHOW).suspect, false);
});

test('screen: a single title mention with no identity evidence is suspect (common-noun titles)', () => {
  const r = screenWrongArticle(ONE_MENTION, SHOW);
  assert.deepStrictEqual([r.suspect, r.titleMentions], [true, 1]);
});

test('screen: short text is not applicable', () => {
  assert.strictEqual(screenWrongArticle('short', SHOW).applicable, false);
});

function writeInto(text, existing) {
  guard._setShowsCacheForTest(new Map([[SHOW.id, SHOW]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4383-'));
  const dir = path.join(root, SHOW.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'nyt-theater--unknown.json');
  if (existing) fs.writeFileSync(file, JSON.stringify(existing));
  const base = { showId: SHOW.id, outletId: 'nyt-theater', criticName: 'Unknown', url: 'https://example.com/a', fullText: text };
  guard.safeWriteReview(file, existing ? { ...existing, fullText: text } : base, { force: false });
  const out = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.rmSync(root, { recursive: true, force: true });
  return out;
}

test('write guard: arriving text that never names the show is stamped wrongShow', () => {
  const out = writeInto(WRONG);
  assert.strictEqual(out.wrongShow, true);
  assert.match(out.wrongShowReason, /BRO-4383/);
});

test('write guard: legitimate text is not stamped', () => {
  assert.notStrictEqual(writeInto(RIGHT_NAMED).wrongShow, true);
  assert.notStrictEqual(writeInto(RIGHT_CAST).wrongShow, true);
});

test('write guard: a single title mention is left to the audit, not stamped', () => {
  assert.notStrictEqual(writeInto(ONE_MENTION).wrongShow, true);
});

test('write guard: a human wrongShow clear is respected', () => {
  const out = writeInto(WRONG, {
    showId: SHOW.id, outletId: 'nyt-theater', criticName: 'Unknown', url: 'https://example.com/a',
    fullText: 'old text', wrongShowManualClear: true, wrongShowOverride: true,
  });
  assert.notStrictEqual(out.wrongShow, true);
});

test('screen: sparse metadata (no cast/creative/venue) is flagged sparseIdentity; write guard fails open', () => {
  const sparse = { id: 'zz-bro4383-sparse-2025', title: 'Six' };
  const r = screenWrongArticle(WRONG, sparse);
  assert.strictEqual(r.sparseIdentity, true);
  guard._setShowsCacheForTest(new Map([[sparse.id, sparse]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4383s-'));
  const dir = path.join(root, sparse.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'nyt-theater--unknown.json');
  guard.safeWriteReview(file, { showId: sparse.id, outletId: 'nyt-theater', criticName: 'Unknown', url: 'https://example.com/s', fullText: WRONG }, { force: false });
  assert.notStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).wrongShow, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('screen: 3-char titles are counted as mentions', () => {
  const six = { id: 'x', title: 'Six', cast: [{ name: 'Someone Else' }] };
  const txt = `Six is a pop-concert history lesson. ${filler(20)} Six ends with a bang. ${filler(20)}`;
  assert.ok(screenWrongArticle(txt, six).titleMentions >= 2);
});
