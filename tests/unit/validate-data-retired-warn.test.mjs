/**
 * validate-data.js warns on retired ids present in shows.json (Sprint 0 / S0-T5).
 *
 * The decision logic is scripts/lib/validate-retired-ids.js and is require()d
 * here — never copied (CLAUDE.md §15). The registry is injected as an in-memory
 * list, and the lazy require of scripts/lib/retired-show-ids.js (another
 * track's module) is exercised through an injected requireFn, so this suite
 * passes whether or not that module has landed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  RETIRED_IDS_MODULE,
  loadRetiredIdsSafe,
  findRetiredIdsInShows,
  formatRetiredIdWarning,
  checkRetiredIds,
  normalizeRetiredList,
} = require('../../scripts/lib/validate-retired-ids.js');

const ROOT = path.join(import.meta.dirname, '..', '..');

const SHOWS = [
  { id: 'hamilton-2015', title: 'Hamilton', status: 'open' },
  { id: 'tabdates-off-west-end-2026', title: '?tab=dates', status: 'upcoming' },
  { id: 'phantom-2026', title: 'Phantom', status: 'previews' },
  { id: 'ghost-show-2024', title: 'Ghost Show', status: 'closed' },
];

const RETIRED = [
  { id: 'tabdates-off-west-end-2026', reason: 'phantom row scraped from a ?tab=dates URL', retiredAt: '2026-09-28' },
  { id: 'ghost-show-2024', reason: 'duplicate of ghost-show-2023', retiredAt: '2026-09-28' },
  { id: 'never-existed-2020', reason: 'not in shows.json at all', retiredAt: '2026-09-28' },
];

function sinks() {
  const calls = { warn: [], ok: [] };
  return { calls, warn: (m) => calls.warn.push(m), ok: (m) => calls.ok.push(m) };
}

describe('findRetiredIdsInShows', () => {
  test('returns one hit per show whose id is retired, in shows.json order', () => {
    const hits = findRetiredIdsInShows(SHOWS, RETIRED);
    assert.deepEqual(hits.map((h) => h.id), ['tabdates-off-west-end-2026', 'ghost-show-2024']);
    assert.equal(hits[0].reason, 'phantom row scraped from a ?tab=dates URL');
    assert.equal(hits[0].retiredAt, '2026-09-28');
    assert.equal(hits[0].title, '?tab=dates');
  });

  test('empty registry or empty corpus → no hits', () => {
    assert.deepEqual(findRetiredIdsInShows(SHOWS, []), []);
    assert.deepEqual(findRetiredIdsInShows([], RETIRED), []);
    assert.deepEqual(findRetiredIdsInShows(SHOWS, undefined), []);
    assert.deepEqual(findRetiredIdsInShows(undefined, RETIRED), []);
  });

  test('_devOnly rows are skipped (they clone real ids on purpose)', () => {
    const shows = [...SHOWS, { id: 'ghost-show-2024', title: 'Ghost Show (e2e)', _devOnly: true }];
    assert.equal(findRetiredIdsInShows(shows, RETIRED).length, 2);
  });

  test('tolerates bare-string entries and drops malformed ones', () => {
    const registry = ['ghost-show-2024', null, 42, { reason: 'no id' }, { id: '' }, { id: 'phantom-2026' }];
    const hits = findRetiredIdsInShows(SHOWS, registry);
    assert.deepEqual(hits.map((h) => h.id), ['phantom-2026', 'ghost-show-2024']);
    assert.equal(hits[1].reason, null);
    assert.equal(normalizeRetiredList(registry).length, 2);
    assert.deepEqual(normalizeRetiredList('nope'), []);
  });
});

describe('checkRetiredIds — the WARN contract', () => {
  test('one WARN line per retired id present, exact format, never an error, no ok line', () => {
    const s = sinks();
    const hits = checkRetiredIds(SHOWS, RETIRED, s);
    assert.equal(hits.length, 2);
    assert.deepEqual(s.calls.warn, [
      'Retired id present: tabdates-off-west-end-2026 (phantom row scraped from a ?tab=dates URL)',
      'Retired id present: ghost-show-2024 (duplicate of ghost-show-2023)',
    ]);
    assert.deepEqual(s.calls.ok, []);
  });

  test('no retired ids present → a single ok line, no warnings', () => {
    const s = sinks();
    const hits = checkRetiredIds(SHOWS, [{ id: 'never-existed-2020', reason: 'x' }], s);
    assert.equal(hits.length, 0);
    assert.deepEqual(s.calls.warn, []);
    assert.equal(s.calls.ok.length, 1);
    assert.match(s.calls.ok[0], /^No retired ids present in shows\.json \(registry: 1 retired id\(s\)\)$/);
  });

  test('a retired entry without a reason still warns, with a placeholder', () => {
    const s = sinks();
    checkRetiredIds(SHOWS, [{ id: 'phantom-2026' }], s);
    assert.deepEqual(s.calls.warn, ['Retired id present: phantom-2026 (no reason recorded)']);
    assert.equal(formatRetiredIdWarning({ id: 'x', reason: '' }), 'Retired id present: x (no reason recorded)');
  });

  test('works without sinks (returns the hits)', () => {
    assert.equal(checkRetiredIds(SHOWS, RETIRED).length, 2);
  });
});

describe('loadRetiredIdsSafe — lazy require of the registry module', () => {
  function moduleNotFound(spec) {
    const err = new Error(`Cannot find module '${spec}'\nRequire stack:\n- /repo/scripts/lib/retired-show-ids.js\n- /repo/scripts/lib/validate-retired-ids.js`);
    err.code = 'MODULE_NOT_FOUND';
    return err;
  }

  test('registry module absent → empty list, no error (the other track need not have landed)', () => {
    const r = loadRetiredIdsSafe({ requireFn: (spec) => { throw moduleNotFound(spec); } });
    assert.deepEqual(r, { retired: [], error: null, source: 'module-absent' });
  });

  test('registry module present but ITS dependency missing → empty list WITH an error (not silently absent)', () => {
    const r = loadRetiredIdsSafe({ requireFn: () => { throw moduleNotFound('./some-missing-dep'); } });
    assert.deepEqual(r.retired, []);
    assert.equal(r.source, 'module-error');
    assert.match(r.error, /some-missing-dep/);
  });

  test('registry module present → its list, normalised', () => {
    let asked;
    const r = loadRetiredIdsSafe({
      requireFn: (spec) => { asked = spec; return { loadRetiredIds: () => RETIRED }; },
    });
    assert.equal(asked, RETIRED_IDS_MODULE);
    assert.equal(RETIRED_IDS_MODULE, './retired-show-ids');
    assert.equal(r.error, null);
    assert.equal(r.source, 'registry');
    assert.deepEqual(r.retired.map((e) => e.id), RETIRED.map((e) => e.id));
  });

  test('loader throws (corrupt registry file) → empty list with the error surfaced', () => {
    const r = loadRetiredIdsSafe({
      requireFn: () => ({ loadRetiredIds: () => { throw new Error('Unexpected token } in JSON'); } }),
    });
    assert.deepEqual(r.retired, []);
    assert.equal(r.source, 'registry-error');
    assert.match(r.error, /Unexpected token/);
  });

  test('loader returns a non-array, or the module has no loader → empty list with an error', () => {
    const notArray = loadRetiredIdsSafe({ requireFn: () => ({ loadRetiredIds: () => ({ ids: [] }) }) });
    assert.deepEqual(notArray.retired, []);
    assert.match(notArray.error, /not an array/);
    const noLoader = loadRetiredIdsSafe({ requireFn: () => ({}) });
    assert.deepEqual(noLoader.retired, []);
    assert.match(noLoader.error, /no loadRetiredIds/);
  });

  test('the real require path never throws, whatever state scripts/lib/retired-show-ids.js is in', () => {
    const r = loadRetiredIdsSafe();
    assert.ok(Array.isArray(r.retired));
    assert.ok(['registry', 'module-absent', 'module-error', 'registry-error'].includes(r.source));
    const modulePresent = fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'retired-show-ids.js'));
    if (!modulePresent) assert.equal(r.source, 'module-absent');
  });
});

describe('validate-data.js wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'validate-data.js'), 'utf8');

  test('requires the extracted check and runs it right after the duplicate check', () => {
    assert.match(src, /require\('\.\/lib\/validate-retired-ids'\)/);
    assert.match(src, /function validateRetiredIds\(shows\)/);
    assert.match(src, /checkRetiredIds\(shows, retired, \{ warn, ok \}\)/, 'must report through warn (not error) and ok');
    assert.match(src, /validateNoDuplicates\(shows\);\n\s*validateRetiredIds\(shows\);/, 'runner must call the check next to the duplicate check');
  });
});
