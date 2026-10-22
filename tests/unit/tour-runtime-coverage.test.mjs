/**
 * BRO-4750 / BRO-4776: tour runtime coverage and agreement with its source.
 *
 * LIVE-DATA test (reads data/shows.json and data/tour-schedules.json, the real
 * files, like scripts/verify-provider-spend-streak.test.mjs). It is NOT in the
 * test.yml unit batch: shows.json is rewritten daily and new tours appear, so a
 * data assertion there would redden main with no code change (BRO-3425). It runs
 * in check-corpus-drift.yml's "Live-data assertions" step, and is quarantined in
 * scripts/lib/test-yml-manifest-paths.js. Run it by hand:
 *   node --test tests/unit/tour-runtime-coverage.test.mjs
 * BRO-4776's tour-runtime-source-agreement.test.mjs imports this same suite,
 * so the acceptance command and the existing live-data workflow both run it.
 *
 * What it pins: a tour page showed no runtime for 11 tours at the Reddit launch.
 * scripts/enrich-tour-runtimes.js now fills a tour's runtime from the tour's own
 * Tours To You page (scripts/lib/tour-runtime.js), and tourInheritance copies a
 * parent's runtime and synopsis when the parent is plausibly the same
 * production. So a tour without a runtime or synopsis is either waiting for the
 * next daily run or a documented gap below. A gap that closes must be removed
 * from its list here; a closed gap is reported, not failed.
 *
 * The Broadway parent's runtime is never COPIED by the pipeline for tour cuts
 * that differ; this test does not assert a tour's runtime differs from or equals
 * its parent's, only that the tour page has one.
 */
// TESTS-VS-DERIVED-DATA-EXEMPT: live coverage and source agreement, not pinned show facts; checks current tour pages against shows.json and reports closed documented gaps
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
// BRO-4763: run the parent/tour backfill assertion in the existing live-data
// workflow step, without adding it to test.yml's code-only batch.
import './sound-of-music-synopsis.test.mjs';

const require = createRequire(import.meta.url);
const { extractTourRuntime, pageIsTour } = require('../../scripts/lib/tour-runtime.js');
const { parseCompactRuntime } = require('../../scripts/lib/todaytix-runtime.js');
const { politeFetchText } = require('../../scripts/lib/tours-to-you.js');
const { createRunBudget } = require('../../scripts/lib/run-budget.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// Tours whose source publishes no runtime / whose Broadway parent has no
// synopsis to inherit. id -> why. Empty runtime list: every tour has a page that
// publishes one today.
const KNOWN_NO_RUNTIME = new Map([]);
// BRO-447: standalone tours (no tourOf) hand-added 2026-10-09 (BRO-4931). The
// daily auto-fix-show-data.js run now targets them (selectDailyTargets). An
// AWAITING entry expires: past AWAITING_UNTIL with no synopsis, the daily
// pipeline is not filling it, so fix that or give the tour a permanent reason.
const AWAITING_UNTIL = '2026-10-25';
const STANDALONE_AWAITING = `BRO-447 AWAITING — standalone tour, no parent to inherit from; daily auto-fix-show-data.js (check-show-freshness.yml) generates + verifies one by ${AWAITING_UNTIL}`;
const KNOWN_NO_SYNOPSIS = new Map([
  ['dolly-partons-smoky-mountain-christmas-carol-tour-2026', STANDALONE_AWAITING],
  ['the-unauthorized-hallmark-ish-parody-musical-tour-2026', STANDALONE_AWAITING],
  ['dr-seuss-the-cat-in-the-hat-tour-2027', STANDALONE_AWAITING],
  ['the-bodyguard-tour-2026', STANDALONE_AWAITING],
  ['spamilton-an-american-parody-tour-2018', 'BRO-447 — standalone tour; auto-fix generated a plot but search results only confirm "a Hamilton parody", so synopsis-grounding rejected it (run 38137409424)'],
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
  const today = new Date().toISOString().slice(0, 10);
  const exempt = (id) => KNOWN_NO_SYNOPSIS.has(id) && !(KNOWN_NO_SYNOPSIS.get(id) === STANDALONE_AWAITING && today > AWAITING_UNTIL);
  const missing = tours.filter((s) => !hasSynopsis(s) && !exempt(s.id)).map((s) => s.id);
  assert.deepEqual(missing, [], `tours with no synopsis (>= ${SYNOPSIS_MIN_CHARS} chars): ${missing.join(', ')}`);
});

// A gap that closes is good news, so it is reported, not failed: this file runs
// in check-corpus-drift.yml, where a red step files a repeat-failure card, and
// the-sound-of-music-tour-2025 gaining a synopsis did exactly that (BRO-447).
test('documented gaps that have closed are reported for removal', (t) => {
  if (needsData(t)) return;
  const byId = new Map(tours.map((s) => [s.id, s]));
  const closed = [
    ...[...KNOWN_NO_RUNTIME.keys()].filter((id) => !byId.has(id) || byId.get(id).runtime).map((id) => `${id} (KNOWN_NO_RUNTIME)`),
    ...[...KNOWN_NO_SYNOPSIS.keys()].filter((id) => !byId.has(id) || hasSynopsis(byId.get(id))).map((id) => `${id} (KNOWN_NO_SYNOPSIS)`),
  ];
  for (const c of closed) t.diagnostic(`gap closed (or tour gone), remove from its list: ${c}`);
});

test('a runtime written by the pipeline names its tour source and is well formed', (t) => {
  if (needsData(t)) return;
  const fromPipeline = tours.filter((s) => s.runtimeSource);
  for (const s of fromPipeline) {
    assert.match(s.runtimeSource, TOURS_TO_YOU_PAGE, `${s.id}: runtimeSource must be the tour's Tours To You page`);
    assert.match(String(s.runtime), RUNTIME_FORMAT, `${s.id}: runtime "${s.runtime}" is not like "2h 35m"`);
  }
});

test('every sourced tour runtime agrees with its published tour page', { timeout: 300000 }, async (t) => {
  if (needsData(t)) return;
  const budget = createRunBudget(4);
  const pages = new Map();
  for (const tour of tours.filter((s) => s.runtimeSource)) {
    await t.test(tour.id, async () => {
      assert.match(tour.runtimeSource, TOURS_TO_YOU_PAGE);
      if (!pages.has(tour.runtimeSource)) {
        pages.set(tour.runtimeSource, politeFetchText(tour.runtimeSource, { budget }));
      }
      const html = await pages.get(tour.runtimeSource);
      assert.ok(pageIsTour(html, tour), `${tour.id}: runtimeSource names a different show`);
      const published = extractTourRuntime(html);
      assert.ok(published, `${tour.id}: runtimeSource publishes no unambiguous runtime`);
      assert.equal(parseCompactRuntime(tour.runtime), published.minutes,
        `${tour.id}: stored ${tour.runtime}, published ${published.runtime} (${tour.runtimeSource})`);
    });
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
