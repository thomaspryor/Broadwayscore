/**
 * BRO-4485: a merge that brings a real byline onto a file stored as Unknown
 * must keep the name. ingest-urls read "Helen Shaw" off the NYT Degenerates
 * page, findExistingReviewFile matched the existing nytimes--unknown.json by
 * URL, and the merge dropped the name (the review stayed Unknown until a later
 * collector pass). Guards: hand-set names, junk names and a sibling that
 * already holds the URL or the named filename all leave the file alone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');

const SHOW = 'degenerates-off-broadway-2026';
const URL = 'https://www.nytimes.com/2026/09/30/theater/degenerates-review-the-longing-beneath-the-hate-and-self-hate.html';

function setup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4485-'));
  const showDir = path.join(dir, SHOW);
  fs.mkdirSync(showDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(showDir, name), JSON.stringify({
      showId: SHOW, outletId: 'nytimes', outlet: 'The New York Times', url: URL, source: 'rss-discovery', ...data,
    }, null, 2));
  }
  return { dir, read: (name) => JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf8')), list: () => fs.readdirSync(showDir).sort() };
}

function ingest(dir, criticName) {
  return createOrMergeReviewFile(SHOW, {
    outletId: 'nytimes', outlet: 'The New York Times', criticName, url: URL, source: 'ingest-urls', fields: {},
  }, { reviewTextsDir: dir });
}

describe('merge upgrades an Unknown byline (BRO-4485)', () => {
  test('NYT Degenerates: Helen Shaw lands on the existing --unknown file', () => {
    const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
    const r = ingest(t.dir, 'Helen Shaw');
    assert.equal(r.action, 'updated');
    const d = t.read('nytimes--unknown.json');
    assert.equal(d.criticName, 'Helen Shaw');
    assert.equal(d.criticEnrichedFrom, 'writer:ingest-urls');
    assert.deepEqual(t.list(), ['nytimes--unknown.json']);
  });

  test('an unresolved incoming critic changes nothing', () => {
    const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
    ingest(t.dir, 'Unknown');
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });

  test('a hand-set name is never overwritten', () => {
    const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown', criticNameManual: true } });
    ingest(t.dir, 'Helen Shaw');
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });

  test('a junk byline is not accepted', () => {
    const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
    ingest(t.dir, 'Share full article');
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });

  test('no upgrade when a sibling already holds the named filename', () => {
    const t = setup({
      'nytimes--unknown.json': { criticName: 'Unknown' },
      'nytimes--helen-shaw.json': { criticName: 'Helen Shaw', url: 'https://www.nytimes.com/2026/09/30/theater/other.html' },
    });
    ingest(t.dir, 'Helen Shaw');
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });
});
