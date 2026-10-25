// Retired show-id registry (2026 data audit, S0-T2).
//
// Requires the real module (CLAUDE.md §15) and points it at temp files via
// the per-call path options / the RETIRED_IDS_PATH + RETIRED_ARCHIVE_PATH
// env vars — never at data/ (core data, §11).
//
// Run: node --test tests/unit/retired-show-ids.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mod = require('../../scripts/lib/retired-show-ids.js');
const {
  RETIRED_IDS_PATH, ARCHIVE_PATH,
  loadRetiredIds, isRetiredId, retireId, matchesRetired, _resetCache,
} = mod;

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'retired-ids-'));
  const paths = {
    listPath: join(dir, 'retired-show-ids.json'),
    archivePath: join(dir, 'deleted-shows.json'),
  };
  _resetCache();
  try { return fn(paths, dir); }
  finally { _resetCache(); rmSync(dir, { recursive: true, force: true }); }
}

const ROW = {
  id: 'tabdates-off-west-end-2026',
  title: '?tab=dates',
  venue: 'Southwark Playhouse',
  category: 'off-west-end',
  status: 'announced',
};

test('exported contract is exactly the eight documented names', () => {
  // unretireId (BRO-4398): the retire-show plan action's save-failure rollback.
  assert.deepEqual(Object.keys(mod).sort(), [
    'ARCHIVE_PATH', 'RETIRED_IDS_PATH', '_resetCache',
    'isRetiredId', 'loadRetiredIds', 'matchesRetired', 'retireId', 'unretireId',
  ]);
  assert.match(RETIRED_IDS_PATH, /[\\/]data[\\/]retired-show-ids\.json$/);
  assert.match(ARCHIVE_PATH, /[\\/]data[\\/]deleted-shows\.json$/);
});

test('loadRetiredIds: missing file is an empty registry, not an error', () => {
  withTmp((paths) => {
    assert.deepEqual(loadRetiredIds(paths), []);
    assert.equal(isRetiredId('anything', paths), false);
    assert.equal(matchesRetired({ id: 'anything' }, []), null);
  });
});

test('retireId: creates both files, records the contract entry and the full archived row', () => {
  withTmp((paths) => {
    const now = new Date('2026-09-28T12:00:00.000Z');
    // The phantom row is junk that must never return under any id, so it is
    // the blockTitleVenue case — the one form that records title/venue.
    const { entry } = retireId(ROW.id, { reason: 'phantom row from a ?tab=dates URL (audit D1)', archivedRow: ROW, now, blockTitleVenue: true, ...paths });

    assert.deepEqual(entry, {
      id: ROW.id,
      reason: 'phantom row from a ?tab=dates URL (audit D1)',
      retiredAt: '2026-09-28T12:00:00.000Z',
      title: '?tab=dates',
      venue: 'Southwark Playhouse',
    });

    assert.ok(existsSync(paths.listPath), 'registry file created');
    assert.ok(existsSync(paths.archivePath), 'archive file created');
    assert.deepEqual(JSON.parse(readFileSync(paths.listPath, 'utf8')), [entry]);
    assert.deepEqual(JSON.parse(readFileSync(paths.archivePath, 'utf8')), [ROW], 'archive holds the full row');
    // Core-data file convention: 2-space JSON + trailing newline.
    assert.ok(readFileSync(paths.listPath, 'utf8').endsWith('\n'));

    assert.deepEqual(loadRetiredIds(paths), [entry]);
  });
});

test('retireId: appends (does not overwrite) and isRetiredId sees the new id', () => {
  withTmp((paths) => {
    retireId('first-off-broadway-2025', { reason: 'r1', archivedRow: { id: 'first-off-broadway-2025', title: 'First' }, ...paths });
    // Prime the cache with one entry, then retire a second — the write must
    // refresh the cache, not leave a stale one-entry list behind.
    assert.equal(isRetiredId('first-off-broadway-2025', paths), true);
    assert.equal(isRetiredId('second-west-end-2026', paths), false);

    retireId('second-west-end-2026', { reason: 'r2', archivedRow: { id: 'second-west-end-2026', title: 'Second' }, ...paths });
    assert.equal(isRetiredId('second-west-end-2026', paths), true);

    const ids = loadRetiredIds(paths).map((e) => e.id);
    assert.deepEqual(ids, ['first-off-broadway-2025', 'second-west-end-2026']);
    assert.equal(JSON.parse(readFileSync(paths.archivePath, 'utf8')).length, 2);
  });
});

test('retireId: refuses to retire an id twice and leaves both files untouched', () => {
  withTmp((paths) => {
    retireId(ROW.id, { reason: 'first', archivedRow: ROW, ...paths });
    const listBefore = readFileSync(paths.listPath, 'utf8');
    const archiveBefore = readFileSync(paths.archivePath, 'utf8');

    assert.throws(
      () => retireId(ROW.id, { reason: 'again', archivedRow: ROW, ...paths }),
      /already retired/
    );
    assert.equal(readFileSync(paths.listPath, 'utf8'), listBefore);
    assert.equal(readFileSync(paths.archivePath, 'utf8'), archiveBefore);
  });
});

test('retireId: a reason and an archived row are mandatory breadcrumbs', () => {
  withTmp((paths) => {
    assert.throws(() => retireId(ROW.id, { archivedRow: ROW, ...paths }), /reason/);
    assert.throws(() => retireId(ROW.id, { reason: '   ', archivedRow: ROW, ...paths }), /reason/);
    assert.throws(() => retireId(ROW.id, { reason: 'x', ...paths }), /archivedRow/);
    assert.throws(() => retireId(ROW.id, { reason: 'x', archivedRow: [ROW], ...paths }), /archivedRow/);
    assert.throws(() => retireId('', { reason: 'x', archivedRow: ROW, ...paths }), /id must be/);
    assert.equal(existsSync(paths.listPath), false, 'nothing written on refusal');
    assert.equal(existsSync(paths.archivePath), false, 'nothing written on refusal');
  });
});

test('retireId: default is id-only — title/venue null even though the row has both, so a same-title+venue candidate under another id is NOT blocked', () => {
  withTmp((paths) => {
    // A duplicate merged into a kept row: the kept row shares this
    // title+venue, and so would a legitimate revival at the same house years
    // later. Only the retired id itself must stay gone.
    const dup = { id: 'hamlet-off-broadway-2025', title: 'Hamlet', venue: 'The Public Theater', category: 'off-broadway' };
    const { entry } = retireId(dup.id, { reason: 'duplicate of hamlet-off-broadway-2024 (merged)', archivedRow: dup, ...paths });
    assert.equal(entry.title, null);
    assert.equal(entry.venue, null);
    assert.deepEqual(JSON.parse(readFileSync(paths.listPath, 'utf8'))[0], entry, 'nulls are what lands on disk');
    assert.deepEqual(JSON.parse(readFileSync(paths.archivePath, 'utf8')), [dup], 'the archive still holds the full row, title and venue included');

    const entries = loadRetiredIds(paths);
    assert.deepEqual(matchesRetired({ id: 'hamlet-off-broadway-2025', title: 'Hamlet', venue: 'The Public Theater' }, entries), { id: dup.id, matchedBy: 'id' });
    assert.equal(matchesRetired({ id: 'hamlet-off-broadway-2024', title: 'Hamlet', venue: 'The Public Theater' }, entries), null, 'the kept row is not blocked');
    assert.equal(matchesRetired({ id: 'hamlet-off-broadway-2031', title: 'Hamlet', venue: 'The Public Theater' }, entries), null, 'a later same-title revival at the same house is not blocked');
  });
});

test('retireId: blockTitleVenue:true records title/venue, so the same listing under a different id IS blocked', () => {
  withTmp((paths) => {
    const { entry } = retireId(ROW.id, { reason: 'phantom', archivedRow: ROW, blockTitleVenue: true, ...paths });
    assert.equal(entry.title, '?tab=dates');
    assert.equal(entry.venue, 'Southwark Playhouse');
    const entries = loadRetiredIds(paths);
    assert.deepEqual(matchesRetired({ id: 'tabdates-off-west-end-2027', title: '?TAB=DATES', venue: 'southwark playhouse' }, entries), { id: ROW.id, matchedBy: 'title+venue' });
    assert.equal(matchesRetired({ id: 'other-2027', title: '?tab=dates', venue: 'Elsewhere' }, entries), null, 'a different venue is a different listing');
  });
});

test('retireId: blockTitleVenue must be a boolean and needs both title and venue on the row; the same rows retire fine id-only', () => {
  withTmp((paths) => {
    assert.throws(() => retireId(ROW.id, { reason: 'x', archivedRow: ROW, blockTitleVenue: 'yes', ...paths }), /blockTitleVenue must be a boolean/);
    assert.throws(() => retireId('bare-id-2026', { reason: 'x', archivedRow: { id: 'bare-id-2026', title: 'Bare' }, blockTitleVenue: true, ...paths }), /needs both title and venue/);
    assert.throws(() => retireId('bare-id-2026', { reason: 'x', archivedRow: { id: 'bare-id-2026', title: 'Bare', venue: '  ' }, blockTitleVenue: true, ...paths }), /needs both title and venue/);
    assert.equal(existsSync(paths.listPath), false, 'nothing written on refusal');
    assert.equal(existsSync(paths.archivePath), false, 'nothing written on refusal');

    const { entry } = retireId('bare-id-2026', { reason: 'r', archivedRow: { id: 'bare-id-2026' }, ...paths });
    assert.equal(entry.title, null);
    assert.equal(entry.venue, null);
    assert.equal(matchesRetired({ id: 'bare-id-2026' }, [entry])?.matchedBy, 'id');
    assert.equal(matchesRetired({ id: 'other', title: '', venue: '' }, [entry]), null, 'empty never matches empty');
  });
});

test('retireId: writes THROUGH a data/<file> symlink into the core-data clone and keeps the link (setup-local-data.sh SYMLINK_FILES)', () => {
  withTmp((paths, dir) => {
    const clone = join(dir, 'core-data-clone');
    mkdirSync(clone);
    const cloneList = join(clone, 'retired-show-ids.json');
    const cloneArchive = join(clone, 'deleted-shows.json');
    writeFileSync(cloneList, '[]\n'); // seeded, like the real clone
    // The archive is deliberately NOT seeded: a dangling link must still
    // write its target, not get replaced by a regular file.
    symlinkSync(cloneList, paths.listPath);
    symlinkSync(cloneArchive, paths.archivePath);

    retireId(ROW.id, { reason: 'via symlink', archivedRow: ROW, ...paths });

    assert.ok(lstatSync(paths.listPath).isSymbolicLink(), 'registry link survives the write');
    assert.ok(lstatSync(paths.archivePath).isSymbolicLink(), 'archive link survives the write');
    assert.equal(JSON.parse(readFileSync(cloneList, 'utf8'))[0].id, ROW.id, 'the clone file received the entry');
    assert.deepEqual(JSON.parse(readFileSync(cloneArchive, 'utf8')), [ROW], 'the clone archive was created through the dangling link');
    assert.equal(isRetiredId(ROW.id, paths), true);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp-')), [], 'no tmp file left beside the links');
    assert.deepEqual(readdirSync(clone).filter((f) => f.includes('.tmp-')), [], 'no tmp file left in the clone');
  });
});

test('loadRetiredIds: a malformed registry is loud, never silently empty', () => {
  withTmp((paths) => {
    writeFileSync(paths.listPath, '{"retired": []}');
    assert.throws(() => loadRetiredIds(paths), /must be a JSON array/);
    writeFileSync(paths.listPath, '{ not json');
    assert.throws(() => loadRetiredIds(paths), /not valid JSON/);
    // An empty file (fresh `touch`) is the one tolerated non-array: [].
    writeFileSync(paths.listPath, '');
    assert.deepEqual(loadRetiredIds(paths), []);
  });
});

test('isRetiredId: cached load — _resetCache() picks up an out-of-band edit', () => {
  withTmp((paths) => {
    writeFileSync(paths.listPath, JSON.stringify([{ id: 'a-2026', reason: 'r', retiredAt: 'now' }]));
    assert.equal(isRetiredId('a-2026', paths), true);
    assert.equal(isRetiredId('b-2026', paths), false);

    writeFileSync(paths.listPath, JSON.stringify([{ id: 'b-2026', reason: 'r', retiredAt: 'now' }]));
    assert.equal(isRetiredId('b-2026', paths), false, 'still the cached list');
    _resetCache();
    assert.equal(isRetiredId('b-2026', paths), true, 'fresh load after reset');
    assert.equal(isRetiredId(undefined, paths), false);
  });
});

test('env vars RETIRED_IDS_PATH / RETIRED_ARCHIVE_PATH redirect every function', () => {
  withTmp((paths) => {
    const prevList = process.env.RETIRED_IDS_PATH;
    const prevArchive = process.env.RETIRED_ARCHIVE_PATH;
    process.env.RETIRED_IDS_PATH = paths.listPath;
    process.env.RETIRED_ARCHIVE_PATH = paths.archivePath;
    try {
      retireId(ROW.id, { reason: 'env', archivedRow: ROW });
      assert.ok(existsSync(paths.listPath));
      assert.ok(existsSync(paths.archivePath));
      assert.equal(isRetiredId(ROW.id), true);
      assert.equal(matchesRetired({ id: ROW.id })?.matchedBy, 'id');
      assert.equal(loadRetiredIds().length, 1);
      // The constants stay canonical regardless of the override.
      assert.match(RETIRED_IDS_PATH, /[\\/]data[\\/]retired-show-ids\.json$/);
    } finally {
      if (prevList === undefined) delete process.env.RETIRED_IDS_PATH; else process.env.RETIRED_IDS_PATH = prevList;
      if (prevArchive === undefined) delete process.env.RETIRED_ARCHIVE_PATH; else process.env.RETIRED_ARCHIVE_PATH = prevArchive;
    }
  });
});

test('matchesRetired: id match, normalized title+venue match, and non-matches', () => {
  const entries = [
    { id: 'tabdates-off-west-end-2026', reason: 'r', retiredAt: 'now', title: '?tab=dates', venue: 'Southwark Playhouse' },
    { id: 'la-boheme-west-end-2025', reason: 'r', retiredAt: 'now', title: 'La Bohème: A New Staging', venue: 'The Coliseum & Annex' },
  ];

  assert.deepEqual(matchesRetired({ id: 'tabdates-off-west-end-2026', title: 'Something Else', venue: 'Elsewhere' }, entries),
    { id: 'tabdates-off-west-end-2026', matchedBy: 'id' });

  // Different id-year, same listing: title+venue catches it (case, diacritics,
  // punctuation and "&" all fold).
  assert.deepEqual(matchesRetired({ id: 'la-boheme-west-end-2026', title: 'LA BOHEME - a new staging', venue: 'the coliseum and annex' }, entries),
    { id: 'la-boheme-west-end-2025', matchedBy: 'title+venue' });

  // Same title at a different venue is a different production — not retired.
  assert.equal(matchesRetired({ id: 'la-boheme-west-end-2026', title: 'La Bohème: A New Staging', venue: 'Royal Opera House' }, entries), null);
  // Title alone (no venue on the candidate) never matches.
  assert.equal(matchesRetired({ id: 'la-boheme-west-end-2026', title: 'La Bohème: A New Staging' }, entries), null);
  // Unrelated candidate.
  assert.equal(matchesRetired({ id: 'hamilton-broadway-2015', title: 'Hamilton', venue: 'Richard Rodgers' }, entries), null);
  assert.equal(matchesRetired(null, entries), null);
});
