/**
 * Pins the two runtime parsers together.
 *
 * src/lib/calendar/duration.ts is canonical (it is vendored into the iOS app and
 * must stay dependency-free), but the prebuild runs as plain `node` with no TS
 * loader, so scripts/lib/parse-runtime.js exists as a CommonJS mirror. Two
 * copies of a parser drift silently — one gets a fix, the other does not, and
 * the symptom is a calendar event sized differently from what the diary card
 * says. This runs BOTH over the same inputs, including every distinct runtime
 * string in the real dataset, and fails the moment they disagree.
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: structural only — it pins no fact about any
// show. data/shows.json is used purely as a corpus of real runtime STRINGS to
// feed both parsers; the assertion is that the two implementations agree with
// each other, whatever the data says. The one numeric check is a wide 5-95%
// coverage band whose entire purpose is to notice when the upstream data
// changes, so it cannot rot into re-asserting a stale fact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseRuntimeMinutes as canonical, resolveDurationMin as canonicalDuration } from '../../src/lib/calendar';

const require_ = createRequire(import.meta.url);
const mirror = require_('../../scripts/lib/parse-runtime.js');

const FIXTURES = [
  '2h 30m', '2h', '95m', '1 hr 50 min', '2:30', '1h 45m', '3h 15m',
  '90 minutes', '2 hours', '1:55', '', '   ', 'varies', 'TBC', 'N/A',
  '30h', '0m', '0h 0m', '8h 1m', '2.5h', 'two hours', '120',
];

test('mirror and canonical agree on the fixture table', () => {
  for (const f of FIXTURES) {
    assert.equal(
      mirror.parseRuntimeMinutes(f), canonical(f),
      `parseRuntimeMinutes disagreed on ${JSON.stringify(f)}`,
    );
    assert.equal(
      mirror.resolveDurationMin(f), canonicalDuration(f),
      `resolveDurationMin disagreed on ${JSON.stringify(f)}`,
    );
  }
  for (const f of [null, undefined]) {
    assert.equal(mirror.parseRuntimeMinutes(f), canonical(f as null | undefined));
  }
});

test('the shared constants have not drifted apart', () => {
  assert.equal(mirror.DEFAULT_RUNTIME_MIN, 150);
  assert.equal(mirror.CURTAIN_BUFFER_MIN, 15);
});

test('mirror and canonical agree on every runtime string in the real dataset', (t) => {
  // data/shows.json is the private core-data checkout — absent in some CI legs.
  const showsPath = path.join(process.cwd(), 'data', 'shows.json');
  if (!fs.existsSync(showsPath)) {
    t.skip('data/shows.json not present (core-data checkout missing)');
    return;
  }
  const shows = JSON.parse(fs.readFileSync(showsPath, 'utf-8')).shows ?? [];
  // Array.from rather than spread — this repo's tsconfig target predates
  // downlevelIteration, so spreading a Set is a compile error here.
  const distinct = Array.from(
    new Set(shows.map((s: { runtime?: string }) => s.runtime).filter(Boolean)),
  );
  assert.ok(distinct.length > 0, 'expected at least one runtime value in the dataset');

  for (const r of distinct as string[]) {
    assert.equal(mirror.parseRuntimeMinutes(r), canonical(r), `disagreed on real value ${JSON.stringify(r)}`);
  }

  // Guards the 22%-coverage finding: if this ever approaches 100%, the
  // "default duration is the common path" comments are stale and the UI should
  // stop hedging. If it drops toward 0, the upstream runtime scrape broke.
  const withRuntime = shows.filter((s: { runtime?: string }) => s.runtime).length;
  const pct = Math.round((withRuntime / shows.length) * 100);
  assert.ok(pct > 5 && pct < 95, `runtime coverage ${pct}% is outside the expected band — investigate`);
});
