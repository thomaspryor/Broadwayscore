// TESTS-VS-DERIVED-DATA-EXEMPT: structural only — reads shows.json solely to
// enumerate the SET of distinct `type` values and assert each has a label
// handler. It pins no fact about any show (no title, score, date or count) and
// stays green no matter what an enricher changes, so it cannot re-assert a bug
// in derived data. It fails only when a genuinely NEW type value appears —
// which is the whole point.
/**
 * Show-format label coverage + parity.
 *
 * This is the prevention for the bug where 43 `type: 'special'` shows —
 * concerts, galas, immersive experiences, cabaret, dance — silently rendered
 * as "PLAY" on the site and in digest email. Every consumer hand-rolled
 * `type === 'musical' ? 'Musical' : 'Play'`, so "not a musical" meant "a play"
 * and a new type value was invisible until someone looked at a live page. It
 * surfaced on 2026-07-30 when the owner saw Les Misérables: The Arena Concert
 * Spectacular badged PLAY.
 *
 * Two invariants, both of which would have caught it the day `special` entered
 * data/shows.json:
 *
 *   1. COVERAGE — every distinct `type` in data/shows.json has an explicit
 *      entry in SHOW_FORMATS. No relying on the unknown-input fallback.
 *   2. PARITY — src/lib/show-format.ts and scripts/lib/show-format.js agree,
 *      since the email/newsletter codebase cannot import from src/. Same
 *      pattern as classify-market-routing-parity and friends.
 *
 * A third test guards the regression directly: nothing may resolve to the
 * PLAY label unless it really is a play.
 *
 * Run: node --test tests/unit/show-format-coverage.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');

const js = require('../../scripts/lib/show-format');

// The .ts source can't be required directly, so parse its literal map. This is
// deliberately textual: it verifies the shipped TS file, not a re-implementation.
const tsSource = fs.readFileSync(path.join(REPO, 'src/lib/show-format.ts'), 'utf8');

function declaredFields() {
  const iface = tsSource.split('export interface ShowFormat')[1].split('}')[0];
  const fields = [...iface.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.ok(fields.length >= 4, `parsed too few interface fields: ${fields}`);
  return fields;
}

function parseTsFormats() {
  const body = tsSource.split('export const SHOW_FORMATS')[1];
  assert.ok(body, 'SHOW_FORMATS not found in src/lib/show-format.ts');
  const map = {};
  // Each entry looks like:  musical: { label: 'MUSICAL', title: 'Musical', ... }
  const entryRe = /^\s{2}(\w+):\s*\{([\s\S]*?)^\s{2}\},/gm;
  let m;
  while ((m = entryRe.exec(body)) !== null) {
    const [, key, fields] = m;
    const grab = (name) => {
      const f = new RegExp(`${name}:\\s*'([^']*)'`).exec(fields);
      return f ? f[1] : undefined;
    };
    // Derive the field list from the interface rather than hardcoding it. A
    // hardcoded list silently ignores any NEW ShowFormat field, which is how
    // `textClass` drifted between the two copies undetected — and it broke
    // again the moment `plural` was added.
    map[key] = Object.fromEntries(declaredFields().map((f) => [f, grab(f)]));
    if (Object.keys(map).length > 20) break; // runaway guard
  }
  return map;
}

// UNKNOWN_FORMAT lives outside SHOW_FORMATS, so the map-parity test below never
// sees it. Parse it separately — otherwise a one-sided edit to the fallback
// drifts silently, which is exactly how `border-gray-500/50` survived in one
// copy after the design-token lint forced it out of the other.
function parseTsUnknown() {
  const body = tsSource.split('const UNKNOWN_FORMAT')[1];
  assert.ok(body, 'UNKNOWN_FORMAT not found in src/lib/show-format.ts');
  const fields = body.split('};')[0];
  const grab = (name) => {
    const f = new RegExp(`${name}:\\s*'([^']*)'`).exec(fields);
    return f ? f[1] : undefined;
  };
  return Object.fromEntries(declaredFields().map((f) => [f, grab(f)]));
}

const SHOWS_PATH = path.join(REPO, 'data/shows.json');

// data/shows.json is private core data (CLAUDE.md §11): present in CI and the
// main checkout, absent in a fresh worktree. The corpus tests are the ones that
// actually catch a new type value, so they must run in CI — but a missing file
// locally is an environment gap, not a failure. hasCorpus gates those three;
// the parity and resolution tests always run.
const hasCorpus = fs.existsSync(SHOWS_PATH);
if (!hasCorpus) {
  console.log(
    `[show-format-coverage] data/shows.json not found at ${SHOWS_PATH} — ` +
      'skipping corpus-coverage tests (they run in CI, where core data is checked out). ' +
      'Run from the main checkout to exercise them locally.'
  );
}

function loadShowTypes() {
  const raw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = raw.shows || raw;
  const counts = new Map();
  for (const s of shows) {
    if (!s || typeof s.type === 'undefined' || s.type === null) continue;
    counts.set(s.type, (counts.get(s.type) || 0) + 1);
  }
  return counts;
}

describe('show-format coverage', () => {
  it('every type present in shows.json has an explicit SHOW_FORMATS entry', { skip: !hasCorpus }, () => {
    const counts = loadShowTypes();
    assert.ok(counts.size > 0, 'no show types found — shows.json failed to load');

    const unhandled = [...counts.entries()]
      .filter(([type]) => !Object.prototype.hasOwnProperty.call(js.SHOW_FORMATS, type))
      .map(([type, n]) => `${type} (${n} shows)`);

    assert.deepStrictEqual(
      unhandled,
      [],
      `Unhandled show type(s) in data/shows.json: ${unhandled.join(', ')}.\n` +
        'Add an entry to BOTH src/lib/show-format.ts and scripts/lib/show-format.js.\n' +
        'Without one, these shows render with the neutral EVENT fallback everywhere ' +
        '(and, before this guard existed, rendered as PLAY).'
    );
  });

  it('KNOWN_SHOW_TYPES lists exactly the keys of SHOW_FORMATS', () => {
    assert.deepStrictEqual(
      [...js.KNOWN_SHOW_TYPES].sort(),
      Object.keys(js.SHOW_FORMATS).sort()
    );
  });

  it('no show type resolves to the PLAY label unless it is a play', { skip: !hasCorpus }, () => {
    const counts = loadShowTypes();
    const mislabelled = [...counts.keys()]
      .filter((type) => type !== 'play' && js.resolveShowFormat(type).label === 'PLAY');
    assert.deepStrictEqual(
      mislabelled,
      [],
      `These types render as PLAY but are not plays: ${mislabelled.join(', ')}`
    );
  });
});

describe('show-format parity between src/ and scripts/', () => {
  // The parity comparison used to enumerate a hardcoded field list, so any NEW
  // field added to ShowFormat in TS was invisible to the guard. That hole was
  // real and already hit: `textClass` shipped in the TS UNKNOWN_FORMAT but was
  // missing from the JS mirror, making resolveShowFormat(unknown).textClass
  // undefined in email/newsletter code. These two tests close it.
  it('the TS interface declares no field the JS mirror omits', () => {
    const iface = tsSource.split('export interface ShowFormat')[1].split('}')[0];
    const declared = [...iface.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    assert.ok(declared.length >= 4, `parsed too few interface fields: ${declared}`);
    for (const key of Object.keys(js.SHOW_FORMATS)) {
      for (const field of declared) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(js.SHOW_FORMATS[key], field),
          `scripts/lib/show-format.js "${key}" is missing field "${field}" declared on the TS ShowFormat interface`
        );
      }
    }
  });

  it('the unknown-input fallback carries every declared field too', () => {
    // resolveShowFormat(unknown) must be a complete ShowFormat — a missing
    // field here surfaces as `undefined` in a className or email style.
    const iface = tsSource.split('export interface ShowFormat')[1].split('}')[0];
    const declared = [...iface.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
    // Guard against a vacuous pass: if the interface parse yields nothing the
    // loop below iterates zero times and the test would "pass" having checked
    // nothing. (Flagged by the Codex reviewer on the sibling test.)
    assert.ok(declared.length >= 4, `parsed too few interface fields: ${declared}`);
    const fallback = js.resolveShowFormat('a-type-that-does-not-exist');
    for (const field of declared) {
      assert.ok(
        fallback[field] !== undefined,
        `UNKNOWN_FORMAT is missing "${field}" — resolveShowFormat(unknown).${field} is undefined`
      );
    }
  });

  it('the unknown-input fallback matches VALUE-for-value across the two copies', () => {
    // Presence is not parity: the sibling test above only asserts each declared
    // field is defined. This one catches a changed value in one copy only.
    const ts = parseTsUnknown();
    assert.ok(ts.label, 'failed to parse UNKNOWN_FORMAT from the TS source');
    assert.deepStrictEqual(
      ts,
      js.resolveShowFormat('a-type-that-does-not-exist'),
      'UNKNOWN_FORMAT differs between src/lib/show-format.ts and scripts/lib/show-format.js'
    );
  });

  it('the TS and JS maps define the same format keys', () => {
    const ts = parseTsFormats();
    assert.deepStrictEqual(
      Object.keys(ts).sort(),
      Object.keys(js.SHOW_FORMATS).sort(),
      'src/lib/show-format.ts and scripts/lib/show-format.js define different formats'
    );
  });

  it('every field matches across the two copies', () => {
    const ts = parseTsFormats();
    for (const key of Object.keys(ts)) {
      assert.deepStrictEqual(
        ts[key],
        js.SHOW_FORMATS[key],
        `Format "${key}" differs between src/lib/show-format.ts and scripts/lib/show-format.js`
      );
    }
  });
});

describe('show-format resolution basics', () => {
  it('resolves the four known types to their labels', () => {
    assert.strictEqual(js.showFormatLabel('musical'), 'MUSICAL');
    assert.strictEqual(js.showFormatLabel('play'), 'PLAY');
    assert.strictEqual(js.showFormatLabel('opera'), 'OPERA');
    assert.strictEqual(js.showFormatLabel('special'), 'EVENT');
  });

  it('falls back to a neutral EVENT for null/undefined/unknown, never PLAY', () => {
    for (const bad of [null, undefined, '', 'nonsense-type']) {
      assert.strictEqual(
        js.showFormatLabel(bad),
        'EVENT',
        `Unknown input ${JSON.stringify(bad)} must not resolve to PLAY`
      );
    }
  });

  it('never pluralises a non-play type as "Plays"', () => {
    // The breadcrumb (visible AND the BreadcrumbList structured data Google
    // reads) used `type === 'musical' ? 'Musicals' : 'Plays'`, so every concert,
    // gala and opera told Google it was a Play. Codex caught this during
    // ship-check on 2026-07-30, after the pill itself was already fixed.
    assert.strictEqual(js.showFormatPlural('special'), 'Events');
    assert.strictEqual(js.showFormatPlural('opera'), 'Operas');
    assert.strictEqual(js.showFormatPlural('musical'), 'Musicals');
    assert.strictEqual(js.showFormatPlural('play'), 'Plays');
    for (const bad of [null, undefined, '', 'nonsense-type']) {
      assert.notStrictEqual(js.showFormatPlural(bad), 'Plays');
    }
  });

  it('exposes a title-case variant for prose and email rows', () => {
    assert.strictEqual(js.showFormatTitle('musical'), 'Musical');
    assert.strictEqual(js.showFormatTitle('special'), 'Event');
  });
});
