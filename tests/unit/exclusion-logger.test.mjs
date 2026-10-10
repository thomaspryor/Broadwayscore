/**
 * Unit tests for logExclusion / getTodayJsonlPath from scripts/lib/exclusion-logger.js.
 *
 * Logic is require()'d from the lib — never copied (CLAUDE.md §15).
 *
 * Run: node --test tests/unit/exclusion-logger.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Each test gets an isolated temp dir via EXCLUSION_LOGGER_AUDIT_DIR
function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'excl-test-'));
}

function loadLogger(tmpDir) {
  // Clear require cache so each test gets fresh module state
  const modPath = path.resolve(__dirname, '../../scripts/lib/exclusion-logger.js');
  delete require.cache[modPath];
  process.env.EXCLUSION_LOGGER_AUDIT_DIR = tmpDir;
  const mod = require('../../scripts/lib/exclusion-logger');
  mod._resetForTest();
  return mod;
}

function readJsonlLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

// Capture stdout during a call
function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...args) => {
    chunks.push(chunk.toString());
    return orig(chunk, ...args);
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

describe('exclusion-logger — happy path', () => {
  it('TC1: all 5 fields → record in JSONL + stdout [EXCLUSION] prefix with valid JSON', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion, getTodayJsonlPath } = loadLogger(tmpDir);
    const before = new Date();

    const output = captureStdout(() => {
      logExclusion({ script: 'rebuild-all-reviews', showId: 'giant-2026', file: 'nytimes--ben-brantley.json', reason: 'skippedWrongProduction', details: { url: 'https://example.com/review' } });
    });

    // stdout line
    assert.ok(output.includes('[EXCLUSION] '), 'stdout must have [EXCLUSION] prefix');
    const jsonPart = output.trim().split('[EXCLUSION] ')[1];
    const parsed = JSON.parse(jsonPart);
    assert.strictEqual(parsed.script, 'rebuild-all-reviews');
    assert.strictEqual(parsed.showId, 'giant-2026');
    assert.strictEqual(parsed.reason, 'skippedWrongProduction');

    // JSONL file
    const lines = readJsonlLines(getTodayJsonlPath());
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(lines[0].script, 'rebuild-all-reviews');
    assert.ok(new Date(lines[0].ts) >= before, 'ts should be >= test start');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('exclusion-logger — validation errors', () => {
  it('TC2: missing script → throws', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion } = loadLogger(tmpDir);
    assert.throws(
      () => logExclusion({ showId: 'x', file: 'f', reason: 'r', details: {} }),
      /missing required field: script/
    );
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('TC3: missing showId → throws', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion } = loadLogger(tmpDir);
    assert.throws(
      () => logExclusion({ script: 's', file: 'f', reason: 'r', details: {} }),
      /missing required field: showId/
    );
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('TC4: missing reason → throws', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion } = loadLogger(tmpDir);
    assert.throws(
      () => logExclusion({ script: 's', showId: 'x', file: 'f', details: {} }),
      /missing required field: reason/
    );
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('TC5: file omitted but file="-" provided → accepts (show-level exclusion)', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion, getTodayJsonlPath } = loadLogger(tmpDir);
    logExclusion({ script: 's', showId: 'x', file: '-', reason: 'r', details: {} });
    const lines = readJsonlLines(getTodayJsonlPath());
    assert.strictEqual(lines[0].file, '-');
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('TC6: details is a string → throws', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion } = loadLogger(tmpDir);
    assert.throws(
      () => logExclusion({ script: 's', showId: 'x', file: 'f', reason: 'r', details: 'oops' }),
      /details must be a plain object/
    );
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('TC6b: details is null → throws', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion } = loadLogger(tmpDir);
    assert.throws(
      () => logExclusion({ script: 's', showId: 'x', file: 'f', reason: 'r', details: null }),
      /details must be a plain object/
    );
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('TC6c: details is array → throws', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion } = loadLogger(tmpDir);
    assert.throws(
      () => logExclusion({ script: 's', showId: 'x', file: 'f', reason: 'r', details: [] }),
      /details must be a plain object/
    );
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('exclusion-logger — multi-call accumulation', () => {
  it('TC7: two calls → both in same JSONL, each on own line', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion, getTodayJsonlPath } = loadLogger(tmpDir);
    logExclusion({ script: 's', showId: 'show-a', file: 'f1', reason: 'r1', details: {} });
    logExclusion({ script: 's', showId: 'show-b', file: 'f2', reason: 'r2', details: {} });
    const lines = readJsonlLines(getTodayJsonlPath());
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].showId, 'show-a');
    assert.strictEqual(lines[1].showId, 'show-b');
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('exclusion-logger — truncation', () => {
  it('TC8: details >2KB → truncated, resulting JSON line <1KB', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion, getTodayJsonlPath } = loadLogger(tmpDir);
    const bigDetails = { text: 'x'.repeat(3000) };
    logExclusion({ script: 's', showId: 'x', file: 'f', reason: 'r', details: bigDetails });
    const lines = readJsonlLines(getTodayJsonlPath());
    assert.strictEqual(lines.length, 1);
    const rawLine = fs.readFileSync(getTodayJsonlPath(), 'utf8').trim();
    assert.ok(rawLine.length < 1024, `Line length ${rawLine.length} should be < 1024`);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('exclusion-logger — file write failure', () => {
  it('TC9: read-only audit dir → logs to stderr, does NOT throw', () => {
    const tmpDir = makeTmpDir();
    // Make dir read-only so appendFileSync fails
    fs.chmodSync(tmpDir, 0o444);
    const { logExclusion } = loadLogger(tmpDir);
    const stderrChunks = [];
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...args) => {
      stderrChunks.push(chunk.toString());
      return origStderr(chunk, ...args);
    };
    try {
      // Should not throw
      assert.doesNotThrow(() => {
        logExclusion({ script: 's', showId: 'x', file: 'f', reason: 'r', details: {} });
      });
      const stderrOutput = stderrChunks.join('');
      assert.ok(stderrOutput.includes('[exclusion-logger]'), 'stderr should mention exclusion-logger');
    } finally {
      process.stderr.write = origStderr;
      fs.chmodSync(tmpDir, 0o755);
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('exclusion-logger — timestamp validity', () => {
  it('TC10: ts field is valid ISO string within ±2 seconds of now', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion, getTodayJsonlPath } = loadLogger(tmpDir);
    const before = Date.now();
    logExclusion({ script: 's', showId: 'x', file: 'f', reason: 'r', details: {} });
    const after = Date.now();
    const lines = readJsonlLines(getTodayJsonlPath());
    const ts = new Date(lines[0].ts).getTime();
    assert.ok(ts >= before - 1000 && ts <= after + 1000, `ts ${ts} not within window [${before}, ${after}]`);
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('exclusion-logger — stdout format', () => {
  it('TC11: [EXCLUSION] prefix line on stdout is parseable JSON after stripping prefix', () => {
    const tmpDir = makeTmpDir();
    const { logExclusion } = loadLogger(tmpDir);
    const output = captureStdout(() => {
      logExclusion({ script: 's', showId: 'x', file: 'f', reason: 'r', details: { k: 'v' } });
    });
    const line = output.trim().split('\n').find(l => l.startsWith('[EXCLUSION] '));
    assert.ok(line, 'no [EXCLUSION] line found');
    const json = line.replace(/^\[EXCLUSION\] /, '');
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.reason, 'r');
    fs.rmSync(tmpDir, { recursive: true });
  });
});

describe('exclusion-logger — parallel safety', () => {
  it('TC12: 5 child processes each call logExclusion once → exactly 5 well-formed JSONL lines', async () => {
    const tmpDir = makeTmpDir();
    const libPath = path.resolve(__dirname, '../../scripts/lib/exclusion-logger.js');
    const helperPath = path.join(os.tmpdir(), `excl-helper-${Date.now()}.js`);
    fs.writeFileSync(helperPath, `'use strict';
const { logExclusion } = require(${JSON.stringify(libPath)});
logExclusion({ script: 'parallel-test', showId: 'show-' + process.argv[2], file: 'f.json', reason: 'parallelSmoke', details: { idx: parseInt(process.argv[2]) } });
`);

    await Promise.all(
      [0, 1, 2, 3, 4].map(i => new Promise((resolve, reject) => {
        const child = fork(helperPath, [String(i)], {
          env: { ...process.env, EXCLUSION_LOGGER_AUDIT_DIR: tmpDir },
          stdio: 'ignore',
        });
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`child ${i} exited ${code}`)));
        child.on('error', reject);
      }))
    );

    // Give a brief moment for filesystem flush
    await new Promise(r => setTimeout(r, 100));

    const today = new Date().toISOString().slice(0, 10);
    const jsonlPath = path.join(tmpDir, `exclusions-${today}.jsonl`);
    const lines = readJsonlLines(jsonlPath);
    assert.strictEqual(lines.length, 5, `Expected 5 lines, got ${lines.length}`);
    for (const line of lines) {
      assert.ok(line.ts && line.script && line.showId && line.reason, 'line missing required fields');
    }

    fs.rmSync(helperPath);
    fs.rmSync(tmpDir, { recursive: true });
  });
});
