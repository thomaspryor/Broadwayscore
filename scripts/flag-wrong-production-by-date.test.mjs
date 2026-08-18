/**
 * Integration test for scripts/flag-wrong-production-by-date.js's current-run
 * corroboration guard (scripts/lib/wrong-production-corroboration.js).
 *
 * Incident 2026-07-11: care-west-end-2026/thestage--sam-marlowe.json had a
 * misparsed publishDate (2023-10-12; live page was 2026-05-20) and was
 * auto-flagged wrongProduction, suppressing a legit T1 review. The file's own
 * theatreRecordUrl (/archive/2026/5/...) contradicted the bad date. This test
 * runs the real CLI as a subprocess against a fixture that reproduces that
 * shape and asserts the flag is HELD (not written) with a warning emitted —
 * see card #1572.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SCRIPT = path.join(import.meta.dirname, 'flag-wrong-production-by-date.js');

function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-wrong-production-by-date-'));
  const reviewTextsDir = path.join(tmp, 'review-texts');
  const showId = 'care-west-end-2026-fixture';
  const showDir = path.join(reviewTextsDir, showId);
  fs.mkdirSync(showDir, { recursive: true });

  const fixtureShowsFile = path.join(tmp, 'fixture-shows.json');
  fs.writeFileSync(fixtureShowsFile, JSON.stringify({
    shows: {
      [showId]: {
        id: showId,
        title: 'Care (fixture)',
        category: 'west-end',
        previewsStartDate: '2026-05-11',
        openingDate: '2026-05-20',
        closingDate: '2026-06-20',
      },
    },
  }));

  const reviewPath = path.join(showDir, 'thestage--sam-marlowe.json');
  fs.writeFileSync(reviewPath, JSON.stringify({
    outlet: 'The Stage',
    outletId: 'thestage',
    // Misparsed: live page was actually 2026-05-20 (in-window). This stale
    // date alone would trip the >900d-early date guard.
    publishDate: '2023-10-12',
    // Theatre Record's own archive month places the review inside the run
    // window — the STRONG signal the corroboration guard holds on.
    theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/5/39813-care',
    fullText: 'A four-star review of Care at the fixture venue.',
  }, null, 2));

  return { tmp, reviewTextsDir, fixtureShowsFile, reviewPath, showId };
}

function runFlagger({ reviewTextsDir, fixtureShowsFile }, args = []) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, REVIEW_TEXTS_DIR: reviewTextsDir, SHOWS_PATH: fixtureShowsFile },
    encoding: 'utf8',
  });
}

test('old publishDate + current-run theatreRecordUrl is HELD, not auto-flagged (dry run)', () => {
  const fx = makeFixture();
  try {
    const out = runFlagger(fx);
    assert.match(out, /HELD for human review/, 'should surface a HELD section');
    assert.match(out, new RegExp(`${fx.showId}/thestage--sam-marlowe\\.json`), 'held file should be named in output');
    assert.match(out, /theatre-record-month/, 'should report the corroboration signal');
    assert.match(out, /Held \(corroboration\):\s*1/, 'summary should count exactly one held flag');
    assert.doesNotMatch(out, /Flagged \(early\):\s*1/, 'must not also count this as a flagged review');

    const data = JSON.parse(fs.readFileSync(fx.reviewPath, 'utf8'));
    assert.notEqual(data.wrongProduction, true, 'dry run must never write');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('--apply does not write wrongProduction when corroboration is strong', () => {
  const fx = makeFixture();
  try {
    const out = runFlagger(fx, ['--apply']);
    assert.match(out, /Held \(corroboration\):\s*1/);

    const data = JSON.parse(fs.readFileSync(fx.reviewPath, 'utf8'));
    assert.notEqual(data.wrongProduction, true, 'strong corroboration must hold the flag, not write it');
    assert.equal(data.wrongProductionNote, undefined, 'no flag note should be written for a held file');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('control: same stale date WITHOUT corroboration is flagged as before', () => {
  const fx = makeFixture();
  try {
    const data = JSON.parse(fs.readFileSync(fx.reviewPath, 'utf8'));
    delete data.theatreRecordUrl;
    fs.writeFileSync(fx.reviewPath, JSON.stringify(data, null, 2));

    const out = runFlagger(fx, ['--apply']);
    assert.match(out, /Flagged \(early\):\s*1/);
    assert.doesNotMatch(out, /HELD for human review/);

    const after = JSON.parse(fs.readFileSync(fx.reviewPath, 'utf8'));
    assert.equal(after.wrongProduction, true);
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

// Task #1775: a stale wrongProductionOverride breadcrumb (from an earlier,
// unrelated clear — e.g. a false-positive recovery) must not be silently
// neutralized by a later re-flag. review-guards.js's canonical inclusion
// check treats wrongProductionOverride===true as "cleared, include anyway"
// regardless of wrongProduction, and evaluateDatePlausibility's CI backstop
// exempts any record where wrongProduction is already true — so stamping
// over the breadcrumb would both fail to suppress the review AND blind the
// push-time safety net. Mirrors review-write-guard.js's onDiskHasOverrideClear
// check (task #1678).
test('stale wrongProductionOverride breadcrumb blocks the wrongProduction stamp (date-guard branch)', () => {
  const fx = makeFixture();
  try {
    const data = JSON.parse(fs.readFileSync(fx.reviewPath, 'utf8'));
    delete data.theatreRecordUrl; // no corroboration — would otherwise be flagged (control test above)
    data.wrongProductionOverride = true;
    data.wrongProductionOverrideReason = 'false-positive recovery (fixture)';
    fs.writeFileSync(fx.reviewPath, JSON.stringify(data, null, 2));

    const out = runFlagger(fx, ['--apply']);
    assert.doesNotMatch(out, /Flagged \(early\):\s*1/, 'must not count this as a flagged review');
    assert.match(out, /Skipped \(override\/manual clear breadcrumb\):\s*1/);

    const after = JSON.parse(fs.readFileSync(fx.reviewPath, 'utf8'));
    assert.notEqual(after.wrongProduction, true, 'wrongProduction must stay unset — the stamp must not neutralize the override breadcrumb');
    assert.equal(after.wrongProductionOverride, true, 'the breadcrumb itself must survive untouched');
  } finally {
    fs.rmSync(fx.tmp, { recursive: true, force: true });
  }
});

test('stale wrongProductionOverride breadcrumb blocks the wrongProduction stamp (dateless-revival branch)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flag-wrong-production-by-date-'));
  try {
    const reviewTextsDir = path.join(tmp, 'review-texts');
    // Multi-production title: two show ids sharing the same base title, so
    // buildMultiProductionTitleIds() flags showId as a revival candidate.
    const showId = 'anansi-the-spider-revival-2027-fixture';
    const showDir = path.join(reviewTextsDir, showId);
    fs.mkdirSync(showDir, { recursive: true });

    const fixtureShowsFile = path.join(tmp, 'fixture-shows.json');
    fs.writeFileSync(fixtureShowsFile, JSON.stringify({
      shows: {
        [showId]: {
          id: showId,
          title: 'Anansi the Spider (Revival)',
          category: 'off-broadway',
          previewsStartDate: '2099-05-11',
          openingDate: '2099-05-20',
        },
        [`${showId}-orig`]: {
          id: `${showId}-orig`,
          title: 'Anansi the Spider',
          category: 'off-broadway',
          previewsStartDate: '2020-05-11',
          openingDate: '2020-05-20',
          closingDate: '2020-06-20',
        },
      },
    }));

    const reviewPath = path.join(showDir, 'outlet--critic.json');
    fs.writeFileSync(reviewPath, JSON.stringify({
      outlet: 'Fixture Outlet',
      outletId: 'fixture-outlet',
      wrongProductionOverride: true,
      wrongProductionOverrideReason: 'verified correct production (fixture)',
      fullText: 'A four-star review with no publish date.',
    }, null, 2));

    const out = runFlagger({ reviewTextsDir, fixtureShowsFile }, ['--apply']);
    assert.doesNotMatch(out, /Held \(dateless revival\):\s*1/, 'must not count this as a dateless-revival flag');
    assert.match(out, /Skipped \(override\/manual clear breadcrumb\):\s*1/);

    const after = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    assert.notEqual(after.wrongProduction, true, 'wrongProduction must stay unset');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
