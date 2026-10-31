// Coverage-reporting tests for the CV-contradiction sweep (BRO-2348).
//
// assertCorpusScanned already has its own suite in
// tests/unit/corpus-scan-guard.test.mjs and is deliberately NOT re-covered
// here — this file is only about summarizeWindowCoverage and about the
// counting in scripts/audit-cv-flag-contradiction.js that feeds it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { summarizeWindowCoverage, shouldRefuseRedirectedGate } = require('./corpus-scan-guard.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO, 'scripts', 'audit-cv-flag-contradiction.js');

// SETUP ASSERTION (CLAUDE.md: a test whose setup silently fails looks exactly
// like a passing test). Without this, every case below would run against
// `undefined` and vacuously pass.
test('setup: the function under test is exported and the CLI exists', () => {
  assert.equal(typeof summarizeWindowCoverage, 'function');
  assert.equal(typeof shouldRefuseRedirectedGate, 'function');
  assert.ok(fs.existsSync(CLI), `expected the audit CLI at ${CLI}`);
});

// The real numbers measured on the corpus on 2026-09-07, which motivated
// BRO-2348. If the arithmetic silently changes shape, this catches it.
const REAL = {
  windowDays: 30,
  corpusShows: 2943,
  eligibleShows: 2601,
  windowShows: 132,
  openedShows: 22,
  showsWithTexts: 72,
  filesParsed: 999,
};

test('separates the four populations that a single "scanned" number conflates', () => {
  const s = summarizeWindowCoverage(REAL);
  assert.equal(s.upcomingShows, 110, 'window filter has no upper bound: 132 - 22 opened');
  assert.equal(s.skippedNoTexts, 60, 'selected but contributed nothing: 132 - 72');
  // Measured from the SAME baseline as "examined", so the two always sum to
  // the corpus: 72 + 2871 = 2943. The earlier value (2811 = corpus - window)
  // left the 60 skipped shows in neither bucket — round 2 finding 1.
  assert.equal(s.notExamined, 2871, 'corpus minus examined: 2943 - 72');
  assert.equal(s.showsWithTexts + s.notExamined, s.corpusShows, 'must partition the corpus');
  assert.equal(s.ineligibleShows, 342, 'no usable openingDate: 2943 - 2601');
});

test('the examined count is shows that yielded files, not the window size', () => {
  const s = summarizeWindowCoverage(REAL);
  // 72 is shows-that-contributed. It is NOT the window size (132) and it is
  // NOT the already-opened count (22) — three different numbers that the old
  // single "scanned" figure blurred together.
  assert.equal(s.showsWithTexts, 72);
  assert.equal(s.windowShows, 132);
  assert.equal(s.openedShows, 22);
  assert.match(s.lines[0], /examined 72 of 2943 corpus show/);
});

test('states the no-upper-bound window and the every-window exclusion', () => {
  const text = summarizeWindowCoverage(REAL).lines.join('\n');
  assert.match(text, /110 not yet opened/);
  assert.match(text, /no upper bound/);
  assert.match(text, /342 carry no usable openingDate \(missing or unparseable\)/);
  assert.match(text, /60 selected show\(s\) yielded no readable review file/);
  assert.match(text, /not a statement about the corpus/i);
});

test('full coverage reports zero blind spots rather than a misleading remainder', () => {
  const s = summarizeWindowCoverage({
    windowDays: 100000, corpusShows: 500, eligibleShows: 500,
    windowShows: 500, openedShows: 500, showsWithTexts: 500, filesParsed: 4000,
  });
  assert.equal(s.notExamined, 0);
  assert.equal(s.ineligibleShows, 0);
  assert.equal(s.upcomingShows, 0);
  assert.equal(s.skippedNoTexts, 0);
});

test('upcomingShows is derived from openedShows, not from the corpus size', () => {
  // Guards the specific hardcoding a previous version of this suite could not
  // distinguish: with corpus != window, `corpus - opened` and `window -
  // opened` differ, so only the correct derivation passes.
  const s = summarizeWindowCoverage({
    windowDays: 30, corpusShows: 100, eligibleShows: 100,
    windowShows: 10, openedShows: 4, showsWithTexts: 3, filesParsed: 7,
  });
  assert.equal(s.upcomingShows, 6, 'window(10) - opened(4), not corpus(100) - opened(4)');
  assert.equal(s.skippedNoTexts, 7, 'window(10) - withTexts(3)');
  assert.equal(s.notExamined, 97, 'corpus(100) - examined(3), not corpus - window');
  assert.equal(s.showsWithTexts + s.notExamined, s.corpusShows, 'must partition the corpus');
});

test('the eligible set is never smaller than the window, so "of which" is a subset', () => {
  // Round 2 finding 4's fix had no test: with eligibleShows < windowShows the
  // independent clamps produced ineligible > notExamined, making the last
  // line's "of which" a non-subset. Only the Math.max clamp passes this.
  const s = summarizeWindowCoverage({
    windowDays: 30, corpusShows: 100, eligibleShows: 5, windowShows: 40,
    openedShows: 10, showsWithTexts: 8, filesParsed: 20,
  });
  assert.equal(s.eligibleShows, 40, 'eligible clamps UP to the window it contains');
  assert.equal(s.ineligibleShows, 60);
  assert.ok(
    s.ineligibleShows <= s.notExamined,
    `"of which" must be a subset: ineligible ${s.ineligibleShows} > notExamined ${s.notExamined}`
  );
});

test('an empty scan never reports negative or invented coverage', () => {
  const s = summarizeWindowCoverage({
    windowDays: 30, corpusShows: 2943, eligibleShows: 2601,
    windowShows: 0, openedShows: 0, showsWithTexts: 0, filesParsed: 0,
  });
  assert.equal(s.skippedNoTexts, 0);
  assert.equal(s.notExamined, 2943, 'nothing examined means the whole corpus is unexamined');
});

test('nonsense or missing inputs clamp instead of producing negative counts', () => {
  const s = summarizeWindowCoverage({
    corpusShows: 10, eligibleShows: 999, windowShows: 999,
    openedShows: 999, showsWithTexts: -5, filesParsed: undefined,
  });
  assert.equal(s.eligibleShows, 10);
  assert.equal(s.windowShows, 10);
  assert.equal(s.openedShows, 10);
  assert.equal(s.showsWithTexts, 0);
  assert.equal(s.filesParsed, 0);
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === 'number') assert.ok(v >= 0, `${k} must never be negative, got ${v}`);
  }
});

test('opened and examined clamp to the WINDOW, not the corpus', () => {
  // Round 4 finding 4: clamping these to `corpus` survived green because the
  // only nonsense-input case had corpus === windowShows. With them different,
  // clamping to corpus (100) would leave opened=50 > inWindow=10 and make
  // upcomingShows negative.
  const s = summarizeWindowCoverage({
    windowDays: 30, corpusShows: 100, eligibleShows: 100, windowShows: 10,
    openedShows: 50, showsWithTexts: 80, filesParsed: 3,
  });
  assert.equal(s.openedShows, 10, 'opened clamps to the window, not the corpus');
  assert.equal(s.showsWithTexts, 10, 'examined clamps to the window, not the corpus');
  assert.equal(s.upcomingShows, 0);
  assert.ok(s.upcomingShows >= 0 && s.skippedNoTexts >= 0);
});

test('called with no arguments it does not throw and reports an empty corpus', () => {
  const s = summarizeWindowCoverage();
  assert.equal(s.corpusShows, 0);
  assert.equal(s.notExamined, 0);
  assert.ok(Array.isArray(s.lines) && s.lines.length > 0);
});

// --- The counting in the CLI itself -----------------------------------
// summarizeWindowCoverage can only be as honest as the numbers handed to it.
// These run the real CLI against a fixture corpus via BSC_AUDIT_ROOT, so a
// regression in the scan loop (counting listed files as parsed, or counting a
// directory that yielded nothing as examined) fails here.

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-coverage-'));
  const rt = path.join(root, 'data', 'review-texts');
  fs.mkdirSync(path.join(root, 'data', 'audit'), { recursive: true });
  const day = 86400000;
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const shows = [
    { id: 'good-show', openingDate: iso(Date.now() - 2 * day) },      // opened, parses
    { id: 'corrupt-show', openingDate: iso(Date.now() - 3 * day) },   // opened, 1 of 2 parses
    { id: 'pending-only', openingDate: iso(Date.now() - 4 * day) },   // dir exists, no .json
    { id: 'all-corrupt', openingDate: iso(Date.now() - 4 * day) },    // .json present, none parse
    { id: 'missing-dir', openingDate: iso(Date.now() - 5 * day) },    // no dir at all
    { id: 'future-show', openingDate: iso(Date.now() + 30 * day) },   // in window, not opened
    { id: 'ancient-show', openingDate: '1990-01-01' },                // outside window
    { id: 'bad-date-show', openingDate: 'TBD' },                      // unparseable date
    { id: 'no-date-show' },                                           // excluded at any window
  ];
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), JSON.stringify(shows));

  const file = (o) => JSON.stringify(o);
  fs.mkdirSync(path.join(rt, 'good-show'), { recursive: true });
  // TWO parseable files, so shows-examined (3) and files-parsed (4) differ.
  // With one each, `filesParsed += Math.min(parsedThisShow, 1)` was
  // indistinguishable from the truth (round 3 finding 3).
  fs.writeFileSync(path.join(rt, 'good-show', 'a.json'), file({ textWordCount: 10 }));
  fs.writeFileSync(path.join(rt, 'good-show', 'b.json'), file({ textWordCount: 12 }));
  fs.mkdirSync(path.join(rt, 'corrupt-show'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'corrupt-show', 'ok.json'), file({ textWordCount: 10 }));
  fs.writeFileSync(path.join(rt, 'corrupt-show', 'broken.json'), '{ this is not json');
  fs.mkdirSync(path.join(rt, 'pending-only', '_pending'), { recursive: true });
  // The case round 2 caught as untested: a directory that LISTS .json files
  // none of which parse. Without it, `files.length > 0` and
  // `parsedThisShow > 0` are indistinguishable and the suite passes on the
  // bug it exists to catch.
  fs.mkdirSync(path.join(rt, 'all-corrupt'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'all-corrupt', 'bad1.json'), '{ nope');
  fs.writeFileSync(path.join(rt, 'all-corrupt', 'bad2.json'), 'also not json');
  fs.mkdirSync(path.join(rt, 'future-show'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'future-show', 'f.json'), file({ textWordCount: 10 }));
  fs.mkdirSync(path.join(rt, 'ancient-show'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'ancient-show', 'x.json'), file({ textWordCount: 10 }));
  return root;
}

function runCli(root) {
  return execFileSync(process.execPath, [CLI, '--window=30'], {
    encoding: 'utf8',
    env: { ...process.env, BSC_AUDIT_ROOT: root },
  });
}

test('the CLI counts files it PARSED, not files it listed', () => {
  const root = buildFixture();
  try {
    const out = runCli(root);
    // SETUP ASSERTION: if the fixture were not picked up, the line would be
    // absent or carry the real corpus numbers, and the greps below would be
    // meaningless.
    assert.match(out, /^Coverage: /m, `no coverage line in output:\n${out}`);
    // good-show 2 + corrupt-show 1 (broken.json must NOT count) + future-show 1
    // = 4 parsed. ancient-show is outside the window; all-corrupt yields 0.
    // Listing rather than parsing would give 7.
    assert.match(out, /\(4 review file\(s\) parsed\)/, out);
    assert.doesNotMatch(out, /\(5 review file\(s\) parsed\)/, 'counted a corrupt file as parsed');
    assert.doesNotMatch(out, /\(7 review file\(s\) parsed\)/, 'counted all-corrupt files as parsed');
    // files-parsed (4) must not collapse to shows-examined (3).
    assert.doesNotMatch(out, /\(3 review file\(s\) parsed\)/, 'counted shows, not files');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI does not report a show as examined when it yielded nothing', () => {
  const root = buildFixture();
  try {
    const out = runCli(root);
    // Examined = good-show, corrupt-show, future-show = 3 of 9 corpus shows.
    // pending-only has a directory but no .json; all-corrupt parses none;
    // missing-dir has no directory.
    assert.match(out, /^Coverage: examined 3 of 9 corpus show\(s\)/m, out);
    // Window selects good, corrupt, pending-only, all-corrupt, missing-dir,
    // future = 6. Examined = good, corrupt, future = 3.
    assert.match(out, /selected 6 show\(s\): 5 already opened, 1 not yet opened/, out);
    // pending-only (no .json), all-corrupt (none parse), missing-dir (no dir).
    assert.match(out, /3 selected show\(s\) yielded no readable review file/, out);
    // bad-date-show ('TBD') and no-date-show are both ineligible at ANY window,
    // which is what "missing or unparseable" claims (round 3 finding 2).
    // examined + notExamined must equal the corpus: 3 + 6 = 9. An earlier
    // version asserted 2 here, which locked in the round 2 finding 1 P0.
    assert.match(out, /6 corpus show\(s\) were NOT examined, of which 2 carry no usable openingDate/, out);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a redirected root is refused for --strict and --update-baseline', () => {
  // Round 2 finding 3's fix had no test: the suite never invoked --strict, so
  // deleting the refusal left it fully green while the CI gate at
  // test.yml:4485 became passable against a decoy corpus.
  const root = buildFixture();
  try {
    for (const flag of ['--strict', '--update-baseline']) {
      let code = 0, stderr = '';
      try {
        execFileSync(process.execPath, [CLI, '--window=30', flag], {
          encoding: 'utf8', stdio: 'pipe',
          env: { ...process.env, BSC_AUDIT_ROOT: root },
        });
      } catch (e) {
        code = e.status;
        stderr = String(e.stderr || '');
      }
      assert.equal(code, 2, `${flag} with BSC_AUDIT_ROOT must exit 2, got ${code}`);
      assert.match(stderr, /BSC_AUDIT_ROOT is set/, stderr);
    }
    // Report-only against the same redirected root must still work.
    assert.match(runCli(root), /^Coverage: /m);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unusable --window is refused rather than scanned as clean', () => {
  // Round 3 finding 1: --window=abc made parseInt return NaN, every date
  // comparison false, and --strict exit 0 having examined ZERO shows while
  // the coverage line printed a plausible "--window=0d".
  for (const w of ['abc', '-5', '0']) {
    let code = 0, stderr = '';
    try {
      execFileSync(process.execPath, [CLI, `--window=${w}`, '--strict'], {
        encoding: 'utf8', stdio: 'pipe',
      });
    } catch (e) {
      code = e.status;
      stderr = String(e.stderr || '');
    }
    assert.equal(code, 2, `--window=${w} --strict must exit 2, got ${code}`);
    assert.match(stderr, /--window must be a positive number of days/, stderr);
  }
});

test('the corpus-empty FAIL-LOUD gate is actually armed under --strict', () => {
  // Round 4 finding 1: `{ gate: args.strict || args.updateBaseline }` could be
  // mutated to `{ gate: false }` with every suite still green, because the
  // BSC_AUDIT_ROOT refusal made empty-corpus + --strict unconstructible. The
  // refusal now applies only to a NON-EMPTY redirected corpus, so this case
  // reaches the guard — and it can only ever FAIL, never pass.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-empty-'));
  fs.mkdirSync(path.join(root, 'data', 'audit'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'shows.json'), '[]');
  try {
    let code = 0, stderr = '';
    try {
      execFileSync(process.execPath, [CLI, '--window=30', '--strict'], {
        encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, BSC_AUDIT_ROOT: root },
      });
    } catch (e) {
      code = e.status;
      stderr = String(e.stderr || '');
    }
    assert.equal(code, 1, `empty corpus under --strict must FAIL (exit 1), got ${code}`);
    assert.match(stderr, /scanned 0 review files/, stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a --window token that parseInt would silently truncate is refused', () => {
  // Round 4 finding 3: parseInt('1e9') === 1 and parseInt('30d') === 30, so
  // validating parseInt's RESULT let nonsense through as a plausible window.
  for (const w of ['1e9', '30d', '3O', '1.5', '1=e9', '30=d', '']) {
    let code = 0, stderr = '';
    try {
      execFileSync(process.execPath, [CLI, `--window=${w}`, '--strict'], {
        encoding: 'utf8', stdio: 'pipe',
      });
    } catch (e) {
      code = e.status;
      stderr = String(e.stderr || '');
    }
    assert.equal(code, 2, `--window=${w} must exit 2, got ${code}`);
    assert.match(stderr, /--window must be a positive number of days/, stderr);
  }
});

test('a redirected gate is refused only when a redirect is actually in effect', () => {
  // Round 5 finding 3: with the predicate inlined, deleting the rootOverride
  // term made EVERY real --strict run exit 2 while the suite stayed green.
  const R = shouldRefuseRedirectedGate;
  // No redirect: never refused, whatever else is true. This is the case that
  // pins that a legitimate CI --strict run can still PASS.
  assert.equal(R({ rootOverride: '', corpusEntries: 5000, strict: true }), false);
  assert.equal(R({ rootOverride: '', corpusEntries: 5000, updateBaseline: true }), false);
  assert.equal(R({ rootOverride: undefined, corpusEntries: 5000, strict: true }), false);
  // Redirect + non-empty decoy + a gate-capable flag: refused.
  assert.equal(R({ rootOverride: '/tmp/x', corpusEntries: 1, strict: true }), true);
  assert.equal(R({ rootOverride: '/tmp/x', corpusEntries: 1, updateBaseline: true }), true);
  // Redirect + EMPTY corpus: allowed through, so it reaches the FAIL-LOUD guard.
  assert.equal(R({ rootOverride: '/tmp/x', corpusEntries: 0, strict: true }), false);
  // Redirect + report-only: always allowed.
  assert.equal(R({ rootOverride: '/tmp/x', corpusEntries: 99 }), false);
  assert.equal(R(), false);
});

test('a --window flag without the "=<digits>" form is refused, not silently defaulted', () => {
  // A bare `--window 7` used to match nothing, get dropped, and let the sweep
  // scan the DEFAULT 30 days while printing "--window=30d" and exiting 0.
  // Passing the flag separately from its value must fail loudly instead.
  // '--windowX30' is the input that distinguishes requiring the '=' from
  // blindly slicing 9 characters: the latter yields '30' and accepts it as a
  // thirty-day window. Without this case that mutation survives green.
  for (const argv of [['--window', '7'], ['--window'], ['--window7'], ['--windowX30']]) {
    let code = 0, stderr = '';
    try {
      execFileSync(process.execPath, [CLI, ...argv, '--strict'], {
        encoding: 'utf8', stdio: 'pipe',
      });
    } catch (e) {
      code = e.status;
      stderr = String(e.stderr || '');
    }
    assert.equal(code, 2, `${argv.join(' ')} must exit 2, got ${code}`);
    assert.match(stderr, /--window must be a positive number of days/, stderr);
  }
});
