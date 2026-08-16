// scripts/tests/test-data-write-guard.test.mjs
//
// Task #1662: CI guard for tests that write a real tracked data/*.json path
// outside a tmp fixture. Per CLAUDE.md rule 15 this require()s the REAL
// decision functions from scripts/lib/test-data-write-guard.js — it does not
// restate the resolution logic.
//
// Coverage:
//  (a) unit tests on the pure resolver (resolvedIsTrackedDataJson,
//      analyzeSource against synthetic snippets) — the shapes that must and
//      must not be flagged, including the two already-fixed real regressions
//      (task #1649's shows.json fixture, the diary-shows.json two-hop case)
//      and the local-function-tracing regression this task's own dev loop
//      hit (a helper wrapping mkdtempSync, resolved via a name that collides
//      with an unrelated inner local of the same name).
//  (b) acceptance criterion #1 — the CURRENT tests/ + scripts/ tree is clean
//      (no false positives on real files, including the two already-fixed
//      ones).
//  (c) acceptance criterion #2 — a synthetic fixture file that writeFileSync's
//      a real data/*.json path outside tmp is correctly flagged.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolvedIsTrackedDataJson,
  segmentIsDataDir,
  analyzeSource,
  scanFile,
  listTestFiles,
  EXEMPTION,
} = require('../lib/test-data-write-guard.js');

// ─── resolvedIsTrackedDataJson / segmentIsDataDir ───────────────────────────

describe('resolvedIsTrackedDataJson', () => {
  test('single-hop literal: last segment already spells data/*.json', () => {
    assert.equal(resolvedIsTrackedDataJson(['data/shows.json']), true);
  });

  test('two-hop: an earlier segment resolves to a bare "data" dir', () => {
    assert.equal(resolvedIsTrackedDataJson(['../../data', 'diary-shows.json']), true);
  });

  test('no data segment anywhere -> not flagged', () => {
    assert.equal(resolvedIsTrackedDataJson(['/tmp/xyz', 'fixture.json']), false);
  });

  test('last segment is not .json -> not flagged even with a data dir present', () => {
    assert.equal(resolvedIsTrackedDataJson(['data', 'review-texts']), false);
  });

  test('empty segment list -> not flagged', () => {
    assert.equal(resolvedIsTrackedDataJson([]), false);
  });

  test('"metadata" must not match as a data dir (substring, not a path segment)', () => {
    assert.equal(segmentIsDataDir('metadata'), false);
    assert.equal(resolvedIsTrackedDataJson(['some/metadata', 'x.json']), false);
  });

  test('a NESTED subdirectory baked into one literal string is still flagged (ship-check finding)', () => {
    // `[^/]+` (single flat level only) missed this shape — `.+` (any depth)
    // is required so a whole path like 'data/review-texts/foo/bar.json'
    // passed as ONE string literal (not built via separate path.join args)
    // still resolves as a real tracked path.
    assert.equal(resolvedIsTrackedDataJson(['data/review-texts/foo/bar.json']), true);
  });
});

// ─── analyzeSource: synthetic snippets ──────────────────────────────────────

describe('analyzeSource: writeFileSync', () => {
  test('flags a literal real data/*.json path (task #1649 shape)', () => {
    const src = `
      const fs = require('fs');
      const path = require('path');
      const SHOWS_JSON = path.join(ROOT, 'data/shows.json');
      fs.writeFileSync(SHOWS_JSON, '{}');
    `;
    const { violations, error } = analyzeSource(src);
    assert.equal(error, null);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].fn, 'writeFileSync');
    assert.equal(violations[0].argIndex, 0);
  });

  test('flags a two-hop path.join real data dir (diary-shows.json shape)', () => {
    const src = `
      const path = require('path');
      const dataDir = path.join(__dirname, '../../data');
      const diaryPath = path.join(dataDir, 'diary-shows.json');
      fs.writeFileSync(diaryPath, '{}');
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 1);
  });

  test('does NOT flag a mkdtemp-derived fixture path', () => {
    const src = `
      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
      const fixturePath = path.join(fixtureDir, 'shows.json');
      fs.writeFileSync(fixturePath, '{}');
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 0);
  });

  test('does NOT flag a write whose content merely CONTAINS the text "data/x.json" (arg1, not arg0)', () => {
    const src = `
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gi-'));
      fs.writeFileSync(path.join(dir, '.gitignore'), 'data/shows.json\\n');
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 0);
  });
});

describe('analyzeSource: copyFileSync (dest-only semantics)', () => {
  test('does NOT flag reading a real path as the SOURCE into a tmp dest', () => {
    const src = `
      const REAL = path.join(ROOT, 'data/shows.json');
      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
      const fixturePath = path.join(fixtureDir, 'shows.json');
      fs.copyFileSync(REAL, fixturePath);
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 0);
  });

  test('flags writing a real path as the DEST (the restore-direction bug)', () => {
    const src = `
      const REAL = path.join(ROOT, 'data/shows.json');
      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
      const backup = path.join(fixtureDir, 'backup.json');
      fs.copyFileSync(backup, REAL);
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].fn, 'copyFileSync');
    assert.equal(violations[0].argIndex, 1);
  });
});

describe('analyzeSource: renameSync (both-arg semantics)', () => {
  test('flags moving the real path OUT of place (arg 0)', () => {
    const src = `
      const path = require('path');
      const dataDir = path.join(__dirname, '../../data');
      const diaryPath = path.join(dataDir, 'diary-shows.json');
      fs.renameSync(diaryPath, diaryPath + '.bak');
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].argIndex, 0);
  });

  test('flags renaming a tmp file ONTO the real path (arg 1)', () => {
    const src = `
      const REAL = path.join(ROOT, 'data/shows.json');
      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
      const staged = path.join(fixtureDir, 'staged.json');
      fs.renameSync(staged, REAL);
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].argIndex, 1);
  });

  test('does NOT flag a rename entirely within a tmp dir', () => {
    const src = `
      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
      const a = path.join(fixtureDir, 'a.json');
      const b = path.join(fixtureDir, 'b.json');
      fs.renameSync(a, b);
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 0);
  });
});

describe('analyzeSource: local-function tracing', () => {
  test('resolves a helper function that wraps mkdtempSync (dev-loop regression pin)', () => {
    // Mirrors tests/unit/review-gate.test.mjs's makeRepo() shape: an outer
    // scope declares `const repo = makeRepo()`, and makeRepo's OWN body
    // separately declares an unrelated `const repo = mkdtempSync(...)`. A
    // name-keyed (rather than declaration-node-keyed) cycle guard falsely
    // treated the inner `repo` as a self-reference and lost the tmp signal.
    const src = `
      function makeRepo() {
        const repo = mkdtempSync(join(tmpdir(), 'x-'));
        return repo;
      }
      test('t', () => {
        const repo = makeRepo();
        writeFileSync(join(repo, 'data', 'scratch.json'), '{}');
      });
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 0);
  });

  test('two sibling scopes reusing the same local name resolve independently (no cross-contamination)', () => {
    const src = `
      const path = require('path');
      test('a', () => {
        const repo = path.join(ROOT, 'data', 'shows.json');
        readSomething(repo);
      });
      test('b', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
        fs.writeFileSync(path.join(repo, 'scratch.json'), '{}');
      });
    `;
    const { violations } = analyzeSource(src);
    // 'b's write must NOT be flagged (its own repo is tmp-derived), and 'a'
    // never calls a write function at all — zero violations either way, but
    // the point of this fixture is that resolving 'b' must not accidentally
    // pick up 'a's unrelated same-named real-path local.
    assert.equal(violations.length, 0);
  });
});

describe('analyzeSource: scope-resolution adversarial cases (second-opinion review findings)', () => {
  test('module-level reassignment: an EARLIER call site resolves to the value at that point, not the final one', () => {
    // `x` is tmp-derived when SAFE_WRITE runs, then reassigned to a real path
    // afterward. A flat "last declaration in the file wins" env would
    // wrongly resolve SAFE_WRITE's target using the LATER real-path value.
    const src = `
      let x = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
      fs.writeFileSync(path.join(x, 'scratch.json'), '{}'); // SAFE_WRITE
      x = path.join(ROOT, 'data/shows.json');
      fs.writeFileSync(x, JSON.stringify(reload()));
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 1, `expected exactly the second (real) write flagged, got: ${JSON.stringify(violations)}`);
    assert.match(violations[0].snippet, /JSON\.stringify\(reload\(\)\)/);
  });

  test('function parameter is never shadowed BY an outer same-named real-path constant', () => {
    // `target` is SHADOW-JSON's own parameter (opaque — this tool cannot
    // know what caller passed), not the module-level `target` constant.
    // Falling through to the outer constant would misclassify every call to
    // this generic helper as a violation regardless of what it's actually
    // called with.
    const src = `
      const target = path.join(ROOT, 'data/shows.json');
      function writeJson(target, data) {
        fs.writeFileSync(target, data);
      }
      writeJson(someTmpPath, '{}');
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 0, `expected the parameter to shadow the outer const, got: ${JSON.stringify(violations)}`);
  });

  test('arrow function with expression body also shadows its own parameter', () => {
    const src = `
      const target = path.join(ROOT, 'data/shows.json');
      const writeJson = (target, data) => fs.writeFileSync(target, data);
      writeJson(someTmpPath, '{}');
    `;
    const { violations } = analyzeSource(src);
    assert.equal(violations.length, 0);
  });
});

describe('analyzeSource: exemption + TypeScript', () => {
  test('EXEMPTION marker anywhere in the file suppresses the finding at scanFile level', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-exempt-'));
    const file = path.join(tmpDir, 'fixture.mjs');
    try {
      fs.writeFileSync(file, `
        // ${EXEMPTION}: reviewed, this is a synthetic fixture, not a real path
        const path = require('path');
        const SHOWS_JSON = path.join(ROOT, 'data/shows.json');
        fs.writeFileSync(SHOWS_JSON, '{}');
      `);
      const result = scanFile(file);
      assert.equal(result.exempt, true);
      assert.equal(result.violations.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('.ts source is transpiled and still analyzed (type annotations do not hide a violation)', () => {
    const src = `
      import path from 'path';
      interface Options { flag: boolean }
      const SHOWS_JSON: string = path.join(ROOT, 'data/shows.json');
      function opts(): Options { return { flag: true }; }
      fs.writeFileSync(SHOWS_JSON, JSON.stringify(opts()));
    `;
    const { violations, error } = analyzeSource(src, { isTypeScript: true });
    assert.equal(error, null);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].fn, 'writeFileSync');
  });
});

// ─── acceptance criteria (task #1662) ───────────────────────────────────────

describe('acceptance criteria', () => {
  test('criterion 1: the current tests/ + scripts/ tree is clean', () => {
    const files = listTestFiles();
    assert.ok(files.length > 100, `expected a substantial file list, got ${files.length}`);

    const violations = [];
    const errors = [];
    for (const file of files) {
      const result = scanFile(file);
      if (result.error) errors.push({ file, error: result.error });
      for (const v of result.violations) violations.push({ ...v, file });
    }

    assert.deepEqual(
      violations,
      [],
      `expected zero violations, found: ${JSON.stringify(violations, null, 2)}`,
    );
    // A parse failure would silently exclude a file from coverage — acorn (a
    // full ES2022 parser) plus the TypeScript transpile path should handle
    // every real file in this repo; any error here means a real coverage gap,
    // not just a violation, and must be visible to fix rather than swallowed.
    assert.deepEqual(errors, [], `expected zero parse errors, found: ${JSON.stringify(errors, null, 2)}`);
  });

  test('criterion 2: a synthetic fixture writeFileSync-ing a real data/*.json path outside tmp is flagged', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-negative-fixture-'));
    const file = path.join(tmpDir, 'bad-fixture.test.mjs');
    try {
      fs.writeFileSync(file, `
        import { readFileSync, writeFileSync } from 'node:fs';
        import path from 'node:path';
        const SHOWS_JSON = path.join(process.cwd(), 'data', 'shows.json');
        const backup = readFileSync(SHOWS_JSON, 'utf8');
        writeFileSync(SHOWS_JSON, '{"shows":[]}');
      `);
      const result = scanFile(file);
      assert.equal(result.error, null);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].fn, 'writeFileSync');
      assert.match(result.violations[0].resolvedPath, /data\/shows\.json$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('an unparseable file surfaces a non-null error, not a silent clean pass (ship-check finding)', () => {
    // main() escalates parseErrors.length to process.exitCode = 1 — a file
    // this guard cannot parse must never look identical to "scanned, clean".
    // That aggregation is a few lines directly inspectable in the file; this
    // pins the building block it relies on: listTestFiles() honors a
    // repoRoot override (used here to scope the scan to a throwaway
    // fixture), and scanFile() reports the parse failure rather than
    // swallowing it.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-parse-error-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'tests'));
      const badFile = path.join(tmpDir, 'tests', 'bad.test.mjs');
      fs.writeFileSync(badFile, 'this is not valid javascript &&&');
      const files = listTestFiles({ repoRoot: tmpDir });
      assert.equal(files.length, 1);
      const result = scanFile(files[0]);
      assert.notEqual(result.error, null);
      assert.equal(result.violations.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
