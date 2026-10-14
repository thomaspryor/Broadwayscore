/**
 * BRO-4317: review-text folders whose name is not a shows.json id never reach
 * the site (rebuild-all-reviews.js skips them). Covers the scanner, the
 * publish-date matcher used to rehome their files, and the writer guard that
 * stops createOrMergeReviewFile from minting new orphan folders.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  findOrphanReviewFolders, candidateShows, isExactCandidate, idTwin, inWindow, toMs, normalizeUrl,
} = require('./orphan-review-folders');
const { createOrMergeReviewFile, unknownShowFolderRefused, WRITE_GUARD_REFUSED_REASONS } = require('./review-file-writer');
const { moveReviewFile } = require('./review-file-move');

function tmpCorpus(layout) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-folders-'));
  for (const [folder, files] of Object.entries(layout)) {
    fs.mkdirSync(path.join(dir, folder), { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, folder, f), '{}');
  }
  return dir;
}

const SHOWS = [
  { id: 'spamalot-2005', title: 'Spamalot', openingDate: '2005-03-17', closingDate: '2009-01-11' },
  { id: 'spamalot-2023', title: 'Spamalot', openingDate: '2023-11-16', closingDate: '2024-04-07' },
  { id: 'doubt-2005', title: 'Doubt', openingDate: '2005-03-31', closingDate: '2006-07-02' },
  { id: 'doubt-2024', title: 'Doubt', openingDate: '2024-03-07', closingDate: '2024-04-21' },
  { id: 'the-play-that-goes-wrong-off-broadway-2019', title: 'The Play That Goes Wrong', openingDate: '2019-02-11', closingDate: null },
  { id: 'hamlet-2009', title: 'Hamlet', openingDate: '2009-10-06', closingDate: '2009-12-06' },
];

describe('findOrphanReviewFolders', () => {
  test('lists only folders with no shows.json id, skipping plumbing folders and non-json files', () => {
    const dir = tmpCorpus({
      'spamalot-2023': ['nytimes--a.json'],
      'spamalot-off-broadway-2026': ['nytimes--a.json', 'failed-fetches.json', 'notes.txt'],
      '_archive': ['x.json'],
      '.git': ['HEAD.json'],
    });
    const got = findOrphanReviewFolders(dir, SHOWS.map((s) => s.id));
    assert.deepEqual(got, [{ folder: 'spamalot-off-broadway-2026', files: ['nytimes--a.json'] }]);
  });

  test('a folder left with only failed-fetches.json or non-json files is not an orphan (nothing to lose)', () => {
    const dir = tmpCorpus({ 'emptied-2026': ['failed-fetches.json', 'notes.txt'] });
    assert.deepEqual(findOrphanReviewFolders(dir, []), []);
  });

  test('missing corpus dir yields no orphans instead of throwing', () => {
    assert.deepEqual(findOrphanReviewFolders('/nonexistent/review-texts', []), []);
  });
});

describe('candidateShows + inWindow (publish date picks the production, never the URL)', () => {
  test('market/year suffixes and a leading "the-" are ignored when pairing folder to shows', () => {
    const ids = candidateShows('the-play-that-goes-wrong-2019', SHOWS).map((s) => s.id);
    assert.deepEqual(ids, ['the-play-that-goes-wrong-off-broadway-2019']);
  });

  test('a subtitled folder ("doubt-a-parable") pairs with the title "Doubt"', () => {
    const ids = candidateShows('doubt-a-parable', SHOWS).map((s) => s.id).sort();
    assert.deepEqual(ids, ['doubt-2005', 'doubt-2024']);
  });

  test('a longer subtitled title pairs by base, and the run window then rejects an off-date review', () => {
    assert.deepEqual(candidateShows('hamlet-the-furies-off-broadway-2026', [
      { id: 'hamlet-2009', title: 'Hamlet', openingDate: '2009-10-06' },
    ]).map((s) => s.id), ['hamlet-2009']); // pairs by base; window check below is what rejects it
    const d = toMs('2026-04-20');
    assert.equal(inWindow(d, SHOWS.find((s) => s.id === 'hamlet-2009')), false);
  });

  test('exactly one of two same-title productions holds a given publish date', () => {
    const cands = candidateShows('spamalot', SHOWS);
    const pd = toMs('2023-11-17');
    assert.deepEqual(cands.filter((s) => inWindow(pd, s)).map((s) => s.id), ['spamalot-2023']);
    const pd2 = toMs('2005-03-18');
    assert.deepEqual(cands.filter((s) => inWindow(pd2, s)).map((s) => s.id), ['spamalot-2005']);
  });

  test('show-score ordinal dates ("November 17th, 2023") parse and pick the right production', () => {
    assert.equal(toMs('November 17th, 2023'), toMs('November 17, 2023'));
    assert.notEqual(toMs('January 27th, 2026'), null);
    const pd = toMs('November 17th, 2023');
    assert.deepEqual(candidateShows('spamalot', SHOWS).filter((s) => inWindow(pd, s)).map((s) => s.id), ['spamalot-2023']);
    assert.equal(toMs('not a date'), null);
  });

  test('preview-period reviews (up to 45 days before opening) and an open-ended run both count', () => {
    const doubt = SHOWS.find((s) => s.id === 'doubt-2024');
    assert.equal(inWindow(toMs('2024-02-01'), doubt), true);
    assert.equal(inWindow(toMs('2023-12-01'), doubt), false);
    assert.equal(inWindow(toMs('2024-05-15'), doubt), true);
    assert.equal(inWindow(toMs('2024-06-15'), doubt), false);
    const open = SHOWS.find((s) => s.id === 'the-play-that-goes-wrong-off-broadway-2019');
    assert.equal(inWindow(toMs('2025-01-01'), open, toMs('2026-10-12')), true);
  });

  test('no publish date never matches', () => {
    assert.equal(inWindow(null, SHOWS[0]), false);
  });

  test('normalizeUrl treats protocol, www, query and trailing slash as the same url', () => {
    assert.equal(normalizeUrl('https://www.x.com/a/?utm=1'), normalizeUrl('http://x.com/a'));
  });
});

describe('createOrMergeReviewFile refuses to mint a folder for an unknown show id', () => {
  const input = {
    outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Jesse Green',
    url: 'https://www.nytimes.com/2026/01/01/theater/x-review.html', source: 'test',
  };

  test('unknown id with no existing folder is skipped with reason unknown-show-id', () => {
    const dir = tmpCorpus({});
    const res = createOrMergeReviewFile('spamalot-off-broadway-2026', input,
      { dryRun: true, reviewTextsDir: dir, knownShowIds: SHOWS.map((s) => s.id) });
    assert.equal(res.action, 'skipped');
    assert.equal(res.reason, 'unknown-show-id');
    assert.equal(res.guardRefused, true, 'callers report it as a refusal, not a quiet skip');
    assert.ok(WRITE_GUARD_REFUSED_REASONS.has('unknown-show-id'));
  });

  test('known id passes the guard', () => {
    const dir = tmpCorpus({});
    assert.equal(unknownShowFolderRefused('spamalot-2023', dir, { knownShowIds: SHOWS.map((s) => s.id) }), false);
  });

  test('an existing folder is never refused by this guard (its fix is a move)', () => {
    const dir = tmpCorpus({ 'legacy-folder': [] });
    assert.equal(unknownShowFolderRefused('legacy-folder', dir, { knownShowIds: [] }), false);
  });

  test('allowUnknownShow opts out; a non-default dir without knownShowIds is not enforced', () => {
    const dir = tmpCorpus({});
    assert.equal(unknownShowFolderRefused('nope', dir, { allowUnknownShow: true, knownShowIds: [] }), false);
    assert.equal(unknownShowFolderRefused('nope', dir, {}), false);
  });
});

describe('isExactCandidate separates id-base matches from loose title matches', () => {
  test('market/year variant of an id is exact; a subtitle prefix is loose', () => {
    assert.equal(isExactCandidate('the-play-that-goes-wrong-2019', SHOWS[4]), true);
    assert.equal(isExactCandidate('doubt-a-parable', SHOWS[2]), false);
  });
});

describe('moveReviewFile (approved-fix review-file-op move)', () => {
  test('refuses to overwrite an existing destination unless overwrite: true', () => {
    const dir = tmpCorpus({ 'old-folder': ['a--b.json'], 'show-2023': ['a--b.json'] });
    fs.writeFileSync(path.join(dir, 'show-2023', 'a--b.json'), '{"keep":1}');
    const r = moveReviewFile(dir, 'old-folder/a--b.json', 'show-2023/a--b.json');
    assert.equal(r.ok, false);
    assert.match(r.reason, /Destination exists/);
    assert.equal(fs.readFileSync(path.join(dir, 'show-2023', 'a--b.json'), 'utf8'), '{"keep":1}');
    assert.equal(moveReviewFile(dir, 'old-folder/a--b.json', 'show-2023/a--b.json', { overwrite: true }).ok, true);
    const moved = JSON.parse(fs.readFileSync(path.join(dir, 'show-2023', 'a--b.json'), 'utf8'));
    // BRO-5356: a rename stamps its source so the push restores read the right history.
    assert.equal(moved._renamedFrom.file, 'old-folder/a--b.json');
    delete moved._renamedFrom;
    assert.deepEqual(moved, { showId: 'show-2023' });
  });

  test('moves into a new folder and refuses paths that escape the corpus', () => {
    const dir = tmpCorpus({ 'old-folder': ['a--b.json'] });
    assert.equal(moveReviewFile(dir, 'old-folder/a--b.json', 'new-2026/a--b.json').ok, true);
    assert.ok(fs.existsSync(path.join(dir, 'new-2026', 'a--b.json')));
    assert.equal(moveReviewFile(dir, 'new-2026/a--b.json', '../x.json').ok, false);
    assert.equal(moveReviewFile(dir, '../etc.json', 'x/y.json').ok, false);
    assert.equal(moveReviewFile(dir, 'missing/a.json', 'x/y.json').ok, false);
  });
});

describe('moveReviewFile retags a cross-folder move (BRO-4317: 29 of 69 rehomed reviews stayed hidden)', () => {
  const ORPH = 'Orphaned generic directory "spamalot" is not in shows.json — year-suffixed siblings exist';
  const write = (dir, rel, obj) => fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj));
  const read = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

  test('showId follows the destination; location-only flags naming the source folder auto-clear', () => {
    const dir = tmpCorpus({ spamalot: [] });
    write(dir, 'spamalot/a--b.json', {
      showId: 'spamalot', url: 'https://x.com/r1',
      wrongShow: true, wrongShowReason: ORPH,
      wrongProduction: true, wrongProductionNote: 'File showId "spamalot" doesn\'t match directory "spamalot" — placed in wrong production directory',
    });
    const r = moveReviewFile(dir, 'spamalot/a--b.json', 'spamalot-2023/a--b.json');
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.cleared, ['wrongShow', 'wrongProduction']);
    const d = read(dir, 'spamalot-2023/a--b.json');
    assert.equal(d.showId, 'spamalot-2023');
    assert.equal(d.wrongShow, false);
    assert.equal(d.wrongProduction, false);
    assert.match(d.wrongShowAutoCleared, /review-file-move/);
    assert.equal(d.wrongShowReason, undefined);
    assert.ok(!fs.existsSync(path.join(dir, 'spamalot', 'a--b.json')));
  });

  test('content verdicts, held flags and reasons naming another folder stay set', () => {
    const dir = tmpCorpus({ spamalot: [] });
    write(dir, 'spamalot/c.json', { showId: 'spamalot', url: 'https://x.com/c', wrongShow: true, wrongShowReason: ORPH.replace('"spamalot"', '"other"') });
    write(dir, 'spamalot/d.json', { showId: 'spamalot', url: 'https://x.com/d', wrongProduction: true,
      wrongProductionNote: 'File showId "x" doesn\'t match directory "spamalot"', wrongProductionProvenance: 'content' });
    write(dir, 'spamalot/e.json', { showId: 'spamalot', url: 'https://x.com/e', wrongProduction: true,
      wrongProductionNote: 'File showId "x" doesn\'t match directory "spamalot"', wrongProductionReason: 'ambiguous-production' });
    for (const f of ['c.json', 'd.json', 'e.json']) {
      const r = moveReviewFile(dir, `spamalot/${f}`, `spamalot-2023/${f}`);
      assert.equal(r.ok, true, r.reason);
      assert.deepEqual(r.cleared, [], f);
    }
    assert.equal(read(dir, 'spamalot-2023/c.json').wrongShow, true);
    assert.equal(read(dir, 'spamalot-2023/d.json').wrongProduction, true);
    assert.equal(read(dir, 'spamalot-2023/e.json').wrongProduction, true);
    assert.equal(read(dir, 'spamalot-2023/e.json').showId, 'spamalot-2023');
  });

  test('a locked file is refused and an overwritten destination is restored when the move is refused', () => {
    const dir = tmpCorpus({ spamalot: [], 'spamalot-2023': [] });
    write(dir, 'spamalot/l.json', { showId: 'spamalot', url: 'https://x.com/l', _locked: true });
    write(dir, 'spamalot-2023/l.json', { showId: 'spamalot-2023', keep: 1 });
    const r = moveReviewFile(dir, 'spamalot/l.json', 'spamalot-2023/l.json', { overwrite: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /locked/);
    assert.equal(read(dir, 'spamalot-2023/l.json').keep, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'spamalot-2023', 'l.json.move-backup')));
  });
});

describe('review-field-edit showId repairs a stale id only to the file\'s own folder', () => {
  const { applyReviewFieldEdit, executeReviewFieldEditIn } = require('./review-field-edit');
  const act = (v) => ({ type: 'review-field-edit', file: 'punch-2025/a--b.json', field: 'showId', oldValue: 'punch', newValue: v });

  test('matching folder is accepted and written; another id or no folder context is refused', () => {
    const dir = tmpCorpus({ 'punch-2025': [] });
    fs.writeFileSync(path.join(dir, 'punch-2025', 'a--b.json'), JSON.stringify({ showId: 'punch', url: 'https://x.com/p' }));
    assert.equal(executeReviewFieldEditIn(dir, act('punch-2026'), 'test').ok, false);
    assert.equal(applyReviewFieldEdit({ showId: 'punch' }, act('punch-2025'), 'test').ok, false, 'no ctx.folder fails closed');
    const r = executeReviewFieldEditIn(dir, act('punch-2025'), 'test');
    assert.equal(r.ok, true, r.reason);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'punch-2025', 'a--b.json'), 'utf8')).showId, 'punch-2025');
  });

  test('moveReviewFile refuses to overwrite a _locked destination', () => {
    const dir = tmpCorpus({ old: [], 'show-2023': [] });
    fs.writeFileSync(path.join(dir, 'old', 'x.json'), JSON.stringify({ showId: 'old', url: 'https://x.com/1' }));
    fs.writeFileSync(path.join(dir, 'show-2023', 'x.json'), JSON.stringify({ showId: 'show-2023', _locked: true }));
    const r = moveReviewFile(dir, 'old/x.json', 'show-2023/x.json', { overwrite: true });
    assert.equal(r.ok, false);
    assert.match(r.reason, /_locked/);
    assert.ok(fs.existsSync(path.join(dir, 'old', 'x.json')));
  });
});

describe('idTwin: a folder that is a show id with the market dropped or swapped', () => {
  const shows = [
    { id: 'data-off-broadway-2026' }, { id: 'the-choir-of-man-off-west-end-2026' },
    { id: 'the-choir-of-man-west-end-2025' }, { id: 'jena-friedman-motherfucker-off-broadway-2026' },
    { id: 'x-off-broadway-2026' }, { id: 'x-west-end-2026' },
  ];
  test('show-score style id without the market resolves to the one market-suffixed id', () => {
    assert.equal(idTwin('data-2026', shows), 'data-off-broadway-2026');
    assert.equal(idTwin('the-choir-of-man-west-end-2026', shows), 'the-choir-of-man-off-west-end-2026');
  });
  test('two qualifying ids, a different year, or no year give null', () => {
    assert.equal(idTwin('x-2026', shows), null);
    assert.equal(idTwin('data-2025', shows), null);
    assert.equal(idTwin('data', shows), null);
  });
  test('a retired id whose reason names "duplicate of <id>" resolves to that id', () => {
    assert.equal(idTwin('motherfucker-off-broadway-2026', shows,
      'duplicate of jena-friedman-motherfucker-off-broadway-2026 (same venue/run)'), 'jena-friedman-motherfucker-off-broadway-2026');
  });
});
