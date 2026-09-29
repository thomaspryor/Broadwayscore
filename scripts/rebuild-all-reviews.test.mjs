import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// BRO-925 — per-file exclusion logging (silent failure pattern).
//
// rebuild-all-reviews.js has no main() wrapper: requiring it as a module
// would normally run the ENTIRE pipeline (shows.json read, review-texts
// walk, reviews.json write — see that file's own "Require-as-a-library
// escape hatch" comment above its `module.exports`). It short-circuits with
// a top-level `return` when require.main !== module, so require()ing it here
// is safe and exercises the real getBestScore()/logExclusion() functions
// (CLAUDE.md rule 15 — never re-implement production logic in a test).
//
// Point both audit-file writers at a throwaway tmp dir BEFORE requiring the
// module, since their AUDIT_DIR constants are read once at module load time.
const tmpAuditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-all-reviews-test-audit-'));
process.env.EXCLUSION_LOGGER_AUDIT_DIR = tmpAuditDir;
process.env.REBUILD_EXCLUSION_AUDIT_DIR = tmpAuditDir;

const require = createRequire(import.meta.url);
const { getBestScore, logExclusion, stats } = require('./rebuild-all-reviews.js');
const { writeShowExclusionsFile, showExclusionsPath } = require('./lib/rebuild-exclusion-audit.js');

test.after(() => {
  fs.rmSync(tmpAuditDir, { recursive: true, force: true });
});

test('getBestScore: a review with no score signals at all returns null (the skippedNoScore case)', () => {
  assert.equal(getBestScore({}), null);
  assert.equal(getBestScore({ scoreStatus: 'TO_BE_CALCULATED' }), null);
});

test('logExclusion("skippedNoScore", ...): buffers a per-file record into stats.byShow — this is the gap BRO-925 closes (previously stats.skippedNoScore++ with zero per-file trail)', () => {
  const showId = 'fear-of-13-test-show';
  const before = (stats.byShow[showId]?.exclusions || []).length;

  logExclusion('skippedNoScore', showId, 'wsj--unknown.json', { url: 'https://wsj.example/review' });

  const entries = stats.byShow[showId].exclusions;
  assert.equal(entries.length, before + 1);
  const entry = entries[entries.length - 1];
  assert.equal(entry.file, 'wsj--unknown.json');
  assert.equal(entry.reason, 'skippedNoScore');
  assert.equal(entry.evidence.url, 'https://wsj.example/review');
});

test('logExclusion: multiple reasons for the same show (skippedWrongShow + skippedDuplicateText style) all land in the same per-show buffer', () => {
  const showId = 'multi-reason-test-show';
  logExclusion('skippedWrongShow', showId, 'deadline--unknown.json', { outletId: 'deadline' });
  logExclusion('skippedDuplicateText', showId, 'nysr--scheck.json', { outletId: 'nysr' });

  const entries = stats.byShow[showId].exclusions;
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((e) => e.reason).sort(), ['skippedDuplicateText', 'skippedWrongShow']);
});

test('end-to-end: buffered exclusions flush to data/audit/rebuild-exclusions-{showId}.json with file + reason for every excluded file', () => {
  const showId = 'end-to-end-test-show';
  logExclusion('skippedWrongShow', showId, 'deadline--unknown.json', { outletId: 'deadline' });
  logExclusion('skippedDuplicateText', showId, 'nysr--scheck.json', { outletId: 'nysr' });
  logExclusion('skippedNoScore', showId, 'wsj--unknown.json', {});

  const outPath = writeShowExclusionsFile(showId, stats.byShow[showId].exclusions, tmpAuditDir);
  assert.equal(outPath, showExclusionsPath(showId, tmpAuditDir));
  assert.ok(fs.existsSync(outPath), 'rebuild-exclusions-{showId}.json must exist');

  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(written.showId, showId);
  assert.equal(written.exclusions.length, 3);
  for (const exclusion of written.exclusions) {
    assert.ok(exclusion.file, 'every entry must record the file path');
    assert.ok(exclusion.reason, 'every entry must record the reason');
  }
  assert.deepEqual(
    written.exclusions.map((e) => e.reason).sort(),
    ['skippedDuplicateText', 'skippedNoScore', 'skippedWrongShow']
  );
});

test('logExclusion: whole-show skips (file === "-", e.g. skippedPreviewsShows/skippedUpcomingShows/skippedOrphanDirs) do NOT get buffered per-show — they fire before any file is read, so every previews/upcoming show would otherwise get a phantom rebuild-exclusions-{showId}.json on every run', () => {
  const showId = 'whole-show-skip-test-show';
  logExclusion('skippedPreviewsShows', showId, '-', null, { reason: 'Broadway show in previews' });
  logExclusion('skippedUpcomingShows', showId, '-', null, { reason: "Show in 'upcoming' status" });

  assert.equal(stats.byShow[showId], undefined, 'a whole-show skip must not create a stats.byShow entry at all');
});

test('writeShowExclusionsFile: a show with zero exclusions never gets a file (avoids thousands of empty files on a full rebuild)', () => {
  const showId = 'clean-show-no-exclusions';
  const outPath = writeShowExclusionsFile(showId, stats.byShow[showId]?.exclusions || [], tmpAuditDir);
  assert.equal(outPath, null);
  assert.equal(fs.existsSync(showExclusionsPath(showId, tmpAuditDir)), false);
});

// The tests above call logExclusion()/writeShowExclusionsFile() directly, so
// they'd keep passing even if the actual `getBestScore(data) === null` call
// site (main per-file loop) stopped calling logExclusion, or the post-loop
// flush loop were deleted (adversarial review finding, Codex, BRO-925) — there
// is no fixture corpus this file can drive the real pipeline against to
// exercise that wiring end-to-end (see the --help warning in
// rebuild-all-reviews.js: the pipeline is top-level module code with no way
// to inject a fake review-texts dir). A source-text assertion is the
// pragmatic middle ground: it fails loudly if either call site is ever
// removed, without re-implementing the pipeline's logic.
test('wiring: the getBestScore-null call site and the post-loop flush loop both still exist in source', () => {
  const source = fs.readFileSync(new URL('./rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /scoreResult === null\)\s*\{[\s\S]{0,1200}?logExclusion\("skippedNoScore"/,
    'the null-score branch must call logExclusion("skippedNoScore", ...) — this is the exact gap BRO-925 closes'
  );
  assert.match(
    source,
    /Object\.entries\(stats\.byShow\)[\s\S]{0,200}?writeShowExclusionsFile\(/,
    'a loop over stats.byShow must flush each show\'s buffered exclusions via writeShowExclusionsFile(...)'
  );
});
