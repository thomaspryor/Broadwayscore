// scripts/tests/test-data-write-guard.test.mjs
//
// Acceptance test for task #1662 (Notion 3be637c5416f812f802ac82f43e9789c).
// Per CLAUDE.md rule 15 this require()s the REAL detection function from
// scripts/lib/test-data-write-guard.js — it does not restate the regexes.
//
// Two prior fixtures (task #1649) mutated a real, symlinked, tracked
// data/*.json file in place instead of a tmp()/mkdtemp() fixture, racing
// parallel sessions and CI. This guard exists to catch a third instance
// automatically. Two things must hold:
//  1. The already-fixed files (and the rest of the current tests/ tree)
//     produce zero findings — the clean baseline the card's grep sweep found.
//  2. A synthetic file reproducing the original anti-pattern IS flagged.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// node:fs's globSync requires Node 22 — CI's unit-tests job pins Node 20
// (test.yml), so this must use the `glob` package like the CLI wrapper does.
import { globSync } from 'glob';

const require = createRequire(import.meta.url);
const { findUnsafeDataWrites } = require('../lib/test-data-write-guard.js');

const ROOT = join(import.meta.dirname, '..', '..');

describe('findUnsafeDataWrites — clean baseline', () => {
  test('the two previously-fixed files produce zero findings', () => {
    const fixedFiles = [
      'tests/unit/validate-data-push-refusal-sentinel.test.mjs',
      'tests/e2e/diary-generate-script.spec.ts',
    ];
    for (const rel of fixedFiles) {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      const findings = findUnsafeDataWrites(source);
      assert.deepEqual(findings, [], `expected no findings in ${rel}, got ${JSON.stringify(findings)}`);
    }
  });

  test('the entire current tests/ tree is clean (no false positives)', () => {
    const files = globSync('tests/**/*.{mjs,ts,js}', { cwd: ROOT, nodir: true })
      .map((f) => join(ROOT, f));
    assert.ok(files.length > 100, `expected a substantial tests/ tree, found ${files.length} files`);

    const allFindings = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const finding of findUnsafeDataWrites(source)) {
        allFindings.push({ file: file.slice(ROOT.length + 1), ...finding });
      }
    }
    assert.deepEqual(allFindings, [], `expected zero findings across tests/, got ${JSON.stringify(allFindings, null, 2)}`);
  });

  test('colocated scripts/**/*.test.{mjs,ts,js} (this file exempted) is clean', () => {
    // Mirrors the CLI wrapper's scan scope (scripts/test-data-write-guard.js)
    // and its self-exemption for this file's synthetic bad-fixture text.
    const files = globSync('scripts/**/*.test.{mjs,ts,js}', { cwd: ROOT, nodir: true })
      .map((f) => join(ROOT, f))
      .filter((f) => f !== join(import.meta.dirname, 'test-data-write-guard.test.mjs'));
    assert.ok(files.length > 10, `expected a substantial scripts/ test set, found ${files.length} files`);

    const allFindings = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const finding of findUnsafeDataWrites(source)) {
        allFindings.push({ file: file.slice(ROOT.length + 1), ...finding });
      }
    }
    assert.deepEqual(allFindings, [], `expected zero findings across scripts/**/*.test.*, got ${JSON.stringify(allFindings, null, 2)}`);
  });
});

describe('findUnsafeDataWrites — flags the original anti-pattern', () => {
  test('writeFileSync to a bare data/*.json literal is flagged', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      writeFileSync('data/shows.json', JSON.stringify(data));
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fn, 'writeFileSync');
  });

  test('backup/mutate/restore via renameSync on a real path is flagged (task #1649 shape)', () => {
    const source = `
      import { renameSync } from 'node:fs';
      import { join } from 'node:path';
      const ROOT = join(import.meta.dirname, '..', '..');
      const REAL_PATH = join(ROOT, 'data', 'diary-shows.json');
      const backupPath = REAL_PATH + '.bak';
      renameSync(REAL_PATH, backupPath);
      // ...mutate, run script, then restore...
      renameSync(backupPath, REAL_PATH);
    `;
    const findings = findUnsafeDataWrites(source);
    assert.ok(findings.length >= 2, `expected both rename calls flagged, got ${findings.length}`);
  });

  test('writeFileSync to a variable declared as a bare data/*.json literal is flagged', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      const showsPath = 'data/shows.json';
      writeFileSync(showsPath, JSON.stringify(data));
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
  });

  test('writeFileSync via join(ROOT, "data/shows.json") with a non-tmp ROOT is flagged', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const ROOT = join(import.meta.dirname, '..', '..');
      const target = join(ROOT, 'data', 'shows.json');
      writeFileSync(target, JSON.stringify(data));
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
  });

  test('writeFileSync to a relative "../data/shows.json" literal is flagged (dominant read idiom, must not bypass on write)', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      writeFileSync('../data/shows.json', JSON.stringify(data));
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
  });

  test('writeFileSync via join(__dirname, "../../data/shows.json") (single relative literal) is flagged', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const target = join(__dirname, '../../data/shows.json');
      writeFileSync(target, JSON.stringify(data));
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
  });

  test('writeFileSync via join(__dirname, "..", "..", "data", "shows.json") (multi-segment relative) is flagged', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const target = join(__dirname, '..', '..', 'data', 'shows.json');
      writeFileSync(target, JSON.stringify(data));
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
  });

  test('appendFileSync to a real data/*.json path is flagged', () => {
    const source = `
      import { appendFileSync } from 'node:fs';
      appendFileSync('data/shows.json', '\\n');
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fn, 'appendFileSync');
  });

  test('fs.promises.writeFile to a real data/*.json path is flagged', () => {
    const source = `
      import fs from 'node:fs';
      await fs.promises.writeFile('data/shows.json', JSON.stringify(data));
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fn, 'writeFile');
  });
});

describe('findUnsafeDataWrites — inline escape hatch', () => {
  test('a flagged write is suppressed by a same-line test-data-write-guard-allow comment', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      writeFileSync('data/shows.json', JSON.stringify(data)); // test-data-write-guard-allow: intentional, see task #1662 discussion
    `;
    assert.deepEqual(findUnsafeDataWrites(source), []);
  });

  test('the allow comment only suppresses the line it is on, not the whole file', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      writeFileSync('data/shows.json', JSON.stringify(data)); // test-data-write-guard-allow: intentional
      writeFileSync('data/reviews.json', JSON.stringify(data));
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1);
    assert.match(findings[0].target, /reviews\.json/);
  });
});

describe('findUnsafeDataWrites — resolves identifiers by nearest preceding declaration, not file-wide', () => {
  test('an unsafe decl is still flagged even when a same-named safe decl appears LATER in the file', () => {
    const source = `
      import { writeFileSync, mkdtempSync } from 'node:fs';
      // Unrelated earlier block using the real path directly.
      const target = 'data/shows.json';
      writeFileSync(target, JSON.stringify(data));
      // Unrelated later block reusing the name for a legitimate tmp fixture.
      const target2setup = () => { const target = mkdtempSync('/tmp/x-'); return target; };
    `;
    const findings = findUnsafeDataWrites(source);
    assert.equal(findings.length, 1, 'the earlier unsafe write must not be hidden by a later same-named safe decl');
  });

  test('a safe decl is not flagged even when an unrelated same-named unsafe decl exists EARLIER in the file', () => {
    const source = `
      import { writeFileSync, mkdtempSync } from 'node:fs';
      import { join } from 'node:path';
      // Unrelated earlier block that never actually writes.
      const target = 'data/shows.json';
      // Unrelated later block: same name, redeclared as a legitimate tmp fixture, then used.
      const target2 = mkdtempSync('/tmp/x-');
      const fixturePath = join(target2, 'shows.json');
      writeFileSync(fixturePath, JSON.stringify(data));
    `;
    assert.deepEqual(findUnsafeDataWrites(source), []);
  });
});

describe('findUnsafeDataWrites — does not flag legitimate tmp fixtures', () => {
  test('writeFileSync into an mkdtempSync-derived path is not flagged', () => {
    const source = `
      import { writeFileSync, mkdtempSync } from 'node:fs';
      import { join } from 'node:path';
      import { tmpdir } from 'node:os';
      const fixtureDir = mkdtempSync(join(tmpdir(), 'fixture-'));
      const fixturePath = join(fixtureDir, 'shows.json');
      writeFileSync(fixturePath, JSON.stringify(data));
    `;
    assert.deepEqual(findUnsafeDataWrites(source), []);
  });

  test('copyFileSync FROM a real data/*.json path into a tmp fixture is not flagged (read-only source)', () => {
    const source = `
      import { copyFileSync, mkdtempSync } from 'node:fs';
      import { join } from 'node:path';
      const REAL_SHOWS_JSON = join(ROOT, 'data/shows.json');
      const fixtureDir = mkdtempSync(join(require('node:os').tmpdir(), 'x-'));
      const fixturePath = join(fixtureDir, 'shows.json');
      copyFileSync(REAL_SHOWS_JSON, fixturePath);
    `;
    assert.deepEqual(findUnsafeDataWrites(source), []);
  });

  test('writeFileSync via env RUNNER_TEMP base is not flagged', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const TMP_DIR = process.env.RUNNER_TEMP || '/tmp';
      const sentinel = join(TMP_DIR, 'data', 'shows.json');
      writeFileSync(sentinel, 'x');
    `;
    assert.deepEqual(findUnsafeDataWrites(source), []);
  });

  test('writeFileSync to an unrelated non-data path is not flagged', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      writeFileSync('/tmp/scratch/output.json', 'x');
    `;
    assert.deepEqual(findUnsafeDataWrites(source), []);
  });

  test('a relative path into an unrelated fixtures dir (not the repo data/ root) is not flagged', () => {
    const source = `
      import { writeFileSync } from 'node:fs';
      writeFileSync('../fixtures/data/sample.json', 'x');
    `;
    assert.deepEqual(findUnsafeDataWrites(source), []);
  });

  test('reading via join(__dirname, "..", "..", "data", "shows.json") is never flagged (only WRITE_CALLS targets are scanned)', () => {
    const source = `
      import { readFileSync } from 'node:fs';
      import { join } from 'node:path';
      const target = join(__dirname, '..', '..', 'data', 'shows.json');
      const data = JSON.parse(readFileSync(target, 'utf8'));
    `;
    assert.deepEqual(findUnsafeDataWrites(source), []);
  });
});
