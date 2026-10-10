/**
 * BRO-4750: every national tour carries a runtime and a synopsis.
 *
 * LIVE-DATA test (reads data/shows.json and data/tour-schedules.json, the real
 * files, like scripts/verify-provider-spend-streak.test.mjs). It is NOT in the
 * test.yml unit batch: shows.json is rewritten daily and new tours appear, so a
 * data assertion there would redden main with no code change (BRO-3425). It runs
 * in check-corpus-drift.yml's "Live-data assertions" step, and is quarantined in
 * scripts/lib/test-yml-manifest-paths.js. Run it by hand:
 *   node --test tests/unit/tour-runtime-coverage.test.mjs
 *
 * What it pins: a tour page showed no runtime for 11 tours at the Reddit launch.
 * scripts/enrich-tour-runtimes.js now fills a tour's runtime from the tour's own
 * Tours To You page (scripts/lib/tour-runtime.js), and tourInheritance copies a
 * parent's runtime and synopsis when the parent is plausibly the same
 * production. So a tour without a runtime or synopsis is either waiting for the
 * next daily run or a documented gap below. A gap that closes must be removed
 * from its list here, so the lists can only shrink.
 *
 * The Broadway parent's runtime is never COPIED by the pipeline for tour cuts
 * that differ; this test does not assert a tour's runtime differs from or equals
 * its parent's, only that the tour page has one.
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: structural coverage (every tour has a runtime and a synopsis); it pins no fact about a specific show, only two documented gaps that must shrink
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// Tours whose source publishes no runtime / whose Broadway parent has no
// synopsis to inherit. id -> why. Empty runtime list: every tour has a page that
// publishes one today.
const KNOWN_NO_RUNTIME = new Map([]);
const KNOWN_NO_SYNOPSIS = new Map([
  ['the-sound-of-music-tour-2025', 'BRO-4763 — parent the-sound-of-music-1998 has no synopsis for the tour to inherit; Tours To You pages carry none'],
]);

const SYNOPSIS_MIN_CHARS = 40; // scripts/lib/tour-page-audit.js flags a shorter synopsis
const RUNTIME_FORMAT = /^(\d+h(\s\d+m)?|\d+m)$/; // "2h 35m", "3h", "90m"
const TOURS_TO_YOU_PAGE = /^https:\/\/tourstoyou\.org\/shows\/[a-z0-9-]+\/$/;

let tours = [];
try {
  const shows = readJson('data/shows.json').shows || [];
  tours = shows.filter((s) => s.category === 'tour');
} catch { /* no local data: every test below skips */ }

const needsData = (t) => {
  if (tours.length < 10) { t.skip('data/shows.json has no national tours here (run ./scripts/setup-local-data.sh)'); return true; }
  return false;
};
const hasSynopsis = (s) => String(s.synopsis || '').trim().length >= SYNOPSIS_MIN_CHARS;

test('every national tour has a runtime, or is a documented gap', (t) => {
  if (needsData(t)) return;
  const missing = tours.filter((s) => !s.runtime && !KNOWN_NO_RUNTIME.has(s.id)).map((s) => s.id);
  assert.deepEqual(missing, [], `tours with no runtime (the daily Fetch Tour Schedules run fills these from the tour's Tours To You page; list a tour in KNOWN_NO_RUNTIME only when its source publishes none): ${missing.join(', ')}`);
});

test('every national tour has a synopsis, or is a documented gap', (t) => {
  if (needsData(t)) return;
  const missing = tours.filter((s) => !hasSynopsis(s) && !KNOWN_NO_SYNOPSIS.has(s.id)).map((s) => s.id);
  assert.deepEqual(missing, [], `tours with no synopsis (>= ${SYNOPSIS_MIN_CHARS} chars): ${missing.join(', ')}`);
});

test('documented gaps are still gaps (the lists only shrink)', (t) => {
  if (needsData(t)) return;
  const byId = new Map(tours.map((s) => [s.id, s]));
  for (const id of KNOWN_NO_RUNTIME.keys()) {
    assert.ok(byId.has(id) && !byId.get(id).runtime, `${id} now has a runtime (or is gone): remove it from KNOWN_NO_RUNTIME`);
  }
  for (const id of KNOWN_NO_SYNOPSIS.keys()) {
    assert.ok(byId.has(id) && !hasSynopsis(byId.get(id)), `${id} now has a synopsis (or is gone): remove it from KNOWN_NO_SYNOPSIS`);
  }
});

test('a runtime written by the pipeline names its tour source and is well formed', (t) => {
  if (needsData(t)) return;
  const fromPipeline = tours.filter((s) => s.runtimeSource);
  for (const s of fromPipeline) {
    assert.match(s.runtimeSource, TOURS_TO_YOU_PAGE, `${s.id}: runtimeSource must be the tour's Tours To You page`);
    assert.match(String(s.runtime), RUNTIME_FORMAT, `${s.id}: runtime "${s.runtime}" is not like "2h 35m"`);
  }
});

test('every stored tour runtime is well formed', (t) => {
  if (needsData(t)) return;
  const bad = tours.filter((s) => s.runtime && !RUNTIME_FORMAT.test(String(s.runtime))).map((s) => `${s.id}: ${s.runtime}`);
  assert.deepEqual(bad, []);
});

test('a tour whose schedule source is saved has that source on a Tours To You page', (t) => {
  if (needsData(t)) return;
  let schedules;
  try { schedules = readJson('data/tour-schedules.json').tours || {}; } catch { t.skip('no data/tour-schedules.json here'); return; }
  const tourIds = new Set(tours.map((s) => s.id));
  const wrong = Object.entries(schedules)
    .filter(([id, e]) => tourIds.has(id) && e && e.source && !/^https:\/\/tourstoyou\.org\/shows\//.test(e.source))
    .map(([id, e]) => `${id}: ${e.source}`);
  assert.deepEqual(wrong, [], 'enrich-tour-runtimes.js reads a tour\'s saved schedule source first; it must be a Tours To You page');
});
