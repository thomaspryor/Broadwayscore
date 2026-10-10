/**
 * BRO-4485: a byline read off a review's own page must land on the existing
 * Unknown file for that URL. ingest-urls read "Helen Shaw" off the NYT
 * Degenerates page, findExistingReviewFile matched the existing
 * nytimes--unknown.json by URL, and the merge dropped the name.
 *
 * The upgrade is deliberately narrow (adversarial review of the first cut):
 * only an opt-in page-read byline at the same URL, only a plausible person
 * name, never a credited creative, never when a same-outlet sibling holds the
 * URL or the critic, and the file is renamed at once so no "named --unknown"
 * file is left for the rebuild's rename/merge.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer');

const SHOW = 'bro-4485-test-show';
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
  return {
    dir,
    read: (name) => JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf8')),
    list: () => fs.readdirSync(showDir).sort(),
  };
}

function write(dir, criticName, extra = {}) {
  return createOrMergeReviewFile(SHOW, {
    outletId: 'nytimes', outlet: 'The New York Times', criticName, url: URL,
    source: 'ingest-urls', bylineFromOwnPage: true, fields: {}, ...extra,
  }, { reviewTextsDir: dir });
}

describe('page-read byline upgrades an Unknown file (BRO-4485)', () => {
  test('NYT Degenerates: Helen Shaw lands and the file is renamed', () => {
    const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
    const r = write(t.dir, 'Helen Shaw');
    assert.equal(r.action, 'updated');
    assert.deepEqual(t.list(), ['nytimes--helen-shaw.json']);
    const d = t.read('nytimes--helen-shaw.json');
    assert.equal(d.criticName, 'Helen Shaw');
    assert.equal(d.criticEnrichedFrom, 'writer:ingest-urls');
    // Callers that stage paths need the old one to stage its deletion.
    assert.ok(r.filepath.endsWith('nytimes--helen-shaw.json'));
    assert.ok(r.renamedFrom.endsWith('nytimes--unknown.json'));
  });

  test('only an --unknown file qualifies, not a named slug with a blank criticName', () => {
    const t = setup({ 'nytimes--jesse-green.json': { criticName: '' } });
    write(t.dir, 'Helen Shaw');
    assert.deepEqual(t.list(), ['nytimes--jesse-green.json']);
    assert.equal(t.read('nytimes--jesse-green.json').criticName, '');
  });

  test("an outlet's own name is not a byline", () => {
    for (const outletName of ['Broadway World', 'The Arts Desk', 'Arts Desk', 'All That Dazzles']) {
      const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
      write(t.dir, outletName);
      assert.deepEqual(t.list(), ['nytimes--unknown.json'], outletName);
    }
  });

  test('without the page-read opt-in (aggregator rows) nothing changes', () => {
    const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
    write(t.dir, 'Helen Shaw', { bylineFromOwnPage: undefined, source: 'dtli' });
    assert.deepEqual(t.list(), ['nytimes--unknown.json']);
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });

  test('a URL-less write never names the file', () => {
    const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
    write(t.dir, 'Jesse Green', { url: undefined });
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });

  test('an unresolved incoming critic changes nothing', () => {
    const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
    write(t.dir, 'Unknown');
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });

  test('a hand-set or locked file is never overwritten', () => {
    for (const flag of [{ criticNameManual: true }, { _locked: true }]) {
      const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown', ...flag } });
      write(t.dir, 'Helen Shaw');
      assert.deepEqual(t.list(), ['nytimes--unknown.json']);
      assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
    }
  });

  test('page chrome is not a name', () => {
    for (const junk of ['Share full article', 'Updated October', 'Reviewed By', 'Theater Review', 'Critics Pick',
      'Read More', 'Sign Up', 'Opinion Section', 'National Theatre', 'York Magazine']) {
      const t = setup({ 'nytimes--unknown.json': { criticName: 'Unknown' } });
      write(t.dir, junk);
      assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown', junk);
    }
  });

  test('no upgrade when a sibling already names this critic, even under a drifted slug', () => {
    const t = setup({
      'nytimes--unknown.json': { criticName: 'Unknown' },
      'nytimes--helen-shaw-2026.json': { criticName: 'Helen Shaw', url: 'https://www.nytimes.com/2026/09/30/theater/other.html' },
    });
    write(t.dir, 'Helen Shaw');
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });

  test('no upgrade when another same-outlet file holds the same URL', () => {
    const t = setup({
      'nytimes--unknown.json': { criticName: 'Unknown' },
      'nytimes--jesse-green.json': { criticName: 'Jesse Green', wrongProduction: true },
    });
    write(t.dir, 'Helen Shaw');
    assert.equal(t.read('nytimes--unknown.json').criticName, 'Unknown');
  });

  test('a credited creative of the show is not the critic', () => {
    const show = 'the-lost-boys-2026'; // creativeTeam: Michael Arden, Director
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4485-creative-'));
    fs.mkdirSync(path.join(dir, show), { recursive: true });
    const u = 'https://www.nytimes.com/2026/04/01/theater/the-lost-boys-review.html';
    fs.writeFileSync(path.join(dir, show, 'nytimes--unknown.json'), JSON.stringify({
      showId: show, outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Unknown', url: u,
    }));
    createOrMergeReviewFile(show, {
      outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Michael Arden', url: u,
      source: 'ingest-urls', bylineFromOwnPage: true, fields: {},
    }, { reviewTextsDir: dir });
    assert.deepEqual(fs.readdirSync(path.join(dir, show)), ['nytimes--unknown.json']);
  });
});
