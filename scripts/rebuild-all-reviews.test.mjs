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

// BRO-938 — "CV pre-pass promotes wrongProduction through temporal override".
// The card feared the rebuild's CV pre-pass (which copies cv.wrongProduction to
// the top level) would undo the temporal override. It cannot: the override runs
// at CV write time (content-verifier.js) and stores confidence 'low', and the
// pre-pass only promotes high/medium rows plus 'low' rows with a strong
// different-show signal (which the override itself refuses to veto). These
// tests pin both halves so the ordering cannot drift.
const { applyTemporalOverrides, hasStrongDifferentShowSignal } = require('./lib/review-guards.js');

test('BRO-938: a wrongProduction verdict inside the opening window is stored as low confidence, which the pre-pass ignores', () => {
  const issues = ['mentions a different staging'];
  const reasoning = 'venue differs';
  const r = applyTemporalOverrides(true, false, 'high', '2026-04-10', '2026-04-14', { issues, reasoning });
  assert.equal(r.wpConfidence, 'low');
  const eligible = r.wpConfidence === 'high' || r.wpConfidence === 'medium'
    || (r.wpConfidence === 'low' && hasStrongDifferentShowSignal(issues, reasoning));
  assert.equal(eligible, false);
});

test('BRO-938: a definitive different-show verdict is NOT downgraded by the override (promotion is intended)', () => {
  const issues = ['This is a completely different show'];
  const reasoning = 'completely different show, not this production';
  assert.equal(hasStrongDifferentShowSignal(issues, reasoning), true);
  const r = applyTemporalOverrides(true, false, 'high', '2026-04-10', '2026-04-14', { issues, reasoning });
  assert.equal(r.wpConfidence, 'high');
});

test('BRO-938 wiring: the CV pre-pass still skips confidence other than high/medium/strong-low', () => {
  const source = fs.readFileSync(new URL('./rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /const cv = d\.contentVerification;[\s\S]{0,900}?if \(cv\.confidence !== 'high' && cv\.confidence !== 'medium' && !cvLowButStrong\) continue;/,
    'pre-pass must skip low-confidence CV rows (the temporal-override output) unless cvLowButStrong'
  );
});

// BRO-720 — allowEarlyDate must clear date-only auto-flags that carry a
// wrongProductionReason (Alice in Wonderland WE 2026: ROH-run reviews with
// allowEarlyDate:true stayed excluded because any reason counted as manual).
const { shouldAutoClearWrongProduction } = require('./lib/wrong-production-autoclear.js');

test('BRO-720: allowEarlyDate clears a date-only auto-reason flag', () => {
  for (const reason of [
    'anticipatory_pre_opening_post',
    'Haiku reverify: publishDate 2025 vs showId year 2026',
  ]) {
    assert.equal(shouldAutoClearWrongProduction({
      wrongProduction: true, allowEarlyDate: true, wrongProductionReason: reason,
    }), true, reason);
  }
});

test('BRO-720: manual/audit reasons, CV-confirmed and allowCrossMarket-only still keep the flag', () => {
  assert.equal(shouldAutoClearWrongProduction({
    wrongProduction: true, allowEarlyDate: true, wrongProductionReason: 'cross-market contamination (audit)',
  }), false);
  assert.equal(shouldAutoClearWrongProduction({
    wrongProduction: true, allowEarlyDate: true, wrongProductionReason: 'anticipatory_pre_opening_post',
    contentVerification: { wrongProduction: true, confidence: 'high' },
  }), false);
  assert.equal(shouldAutoClearWrongProduction({
    wrongProduction: true, allowCrossMarket: true, wrongProductionReason: 'anticipatory_pre_opening_post',
  }), false);
});

test('BRO-720 wiring: every date-based wrongProduction writer is behind an allowEarlyDate bypass', () => {
  const src = fs.readFileSync(new URL('./rebuild-all-reviews.js', import.meta.url), 'utf8');
  // pre-pass date guards (pre-window + dateless-revival) sit after this early continue
  assert.ok(/if \(d\.allowEarlyDate\) continue;[\s\S]{0,6000}\[PRE-OPENING\][\s\S]{0,6000}\[DATELESS-REVIVAL\]/.test(src));
  // inclusion-pass pre-opening guard
  assert.ok(src.includes('data.publishDate && showDateMap[showId] && !data.allowEarlyDate && !data.routedFromShowId'));
  assert.ok(src.includes('shouldAutoClearWrongProduction(data)'));
});

test('BRO-720: ingest anticipatory gate and rebuild clear agree on allowEarlyDate (no re-flag loop)', () => {
  const ingest = fs.readFileSync(new URL('./collect-review-texts.js', import.meta.url), 'utf8');
  assert.ok(/anticip\.rejected && !shouldSkipWrongProductionAudit\(data\) && !data\.allowEarlyDate/.test(ingest));
  const rebuild = fs.readFileSync(new URL('./rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.ok(/isDateOnlyAutoReason\(data\.wrongProductionReason\)/.test(rebuild));
});

test('BRO-720: adjudicated note keeps a date-only-reason flag even with allowEarlyDate', () => {
  const { isDateOnlyAutoReason } = require('./lib/wrong-production-autoclear.js');
  assert.equal(isDateOnlyAutoReason('anticipatory_pre_opening_post'), true);
  assert.equal(isDateOnlyAutoReason('cross-market contamination (audit)'), false);
  assert.equal(isDateOnlyAutoReason(undefined), false);
});

test('BRO-720 wiring: rebuild imports isDateOnlyAutoReason from the autoclear lib', () => {
  const rebuild = fs.readFileSync(new URL('./rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.ok(/isDateOnlyAutoReason,\n\} = require\('\.\/lib\/wrong-production-autoclear'\)/.test(rebuild));
});
