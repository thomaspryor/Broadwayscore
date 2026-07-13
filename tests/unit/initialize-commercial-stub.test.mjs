import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { main, makeStub, SLUG_RE } = require('../../scripts/initialize-commercial-stub.js');

function withTmpFile(initial, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'init-commercial-stub-'));
  const path = join(dir, 'commercial.json');
  writeFileSync(path, JSON.stringify(initial, null, 2) + '\n');
  try { return fn(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function captureConsole(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const code = fn();
    return { code, logs, errs };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test('makeStub returns the expected stub shape', () => {
  const stub = makeStub();
  assert.deepEqual(stub, {
    designation: 'TBD',
    capitalization: null,
    weeklyRunningCost: null,
    recouped: false,
    recoupedSource: null,
    notes: 'Auto-enrolled stub; awaiting model + curation.',
    sources: [],
  });
});

test('SLUG_RE accepts lowercase alphanumeric + hyphens, rejects everything else', () => {
  assert.ok(SLUG_RE.test('some-show-2026'));
  assert.ok(SLUG_RE.test('abc123'));
  assert.ok(!SLUG_RE.test('Bad Slug!'));
  assert.ok(!SLUG_RE.test('Some-Show'));
  assert.ok(!SLUG_RE.test('show_name'));
  assert.ok(!SLUG_RE.test(''));
});

test('creates a stub entry for a new slug and writes it to disk', () => {
  withTmpFile({ shows: {}, modelLastRun: '2026-01-01' }, (p) => {
    const { code, logs } = captureConsole(() =>
      main([`--show=test-stub-zzz`, `--data-file=${p}`])
    );
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('Created stub entry for test-stub-zzz')));

    const written = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(written.shows['test-stub-zzz'], makeStub());
    // modelLastRun / other top-level keys preserved
    assert.equal(written.modelLastRun, '2026-01-01');
  });
});

test('is idempotent: re-running on an existing entry is a no-op and does not rewrite the file', () => {
  withTmpFile({ shows: {}, modelLastRun: '2026-01-01' }, (p) => {
    main([`--show=test-stub-zzz`, `--data-file=${p}`]);
    const beforeRaw = readFileSync(p, 'utf8');

    const { code, logs } = captureConsole(() =>
      main([`--show=test-stub-zzz`, `--data-file=${p}`])
    );
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes('Entry exists for test-stub-zzz — no-op')));

    const afterRaw = readFileSync(p, 'utf8');
    assert.equal(afterRaw, beforeRaw, 'file must be byte-identical after a no-op run');
  });
});

test('preserves existing 2-space indent + trailing newline formatting', () => {
  withTmpFile({ shows: {}, modelLastRun: '2026-01-01' }, (p) => {
    main([`--show=test-stub-zzz`, `--data-file=${p}`]);
    const raw = readFileSync(p, 'utf8');
    assert.ok(raw.endsWith('\n'), 'file should end with a trailing newline');
    assert.equal(JSON.stringify(JSON.parse(raw), null, 2) + '\n', raw, 'file should be 2-space indented JSON');
  });
});

test('missing --show exits 2 with usage on stderr', () => {
  withTmpFile({ shows: {} }, (p) => {
    const { code, errs } = captureConsole(() => main([`--data-file=${p}`]));
    assert.equal(code, 2);
    assert.ok(errs.some((l) => l.toLowerCase().includes('usage')));
  });
});

test('invalid slug format exits 2 without writing the file', () => {
  withTmpFile({ shows: {} }, (p) => {
    const before = readFileSync(p, 'utf8');
    const { code, errs } = captureConsole(() =>
      main([`--show=Bad Slug!`, `--data-file=${p}`])
    );
    assert.equal(code, 2);
    assert.ok(errs.some((l) => l.includes('Invalid slug')));
    const after = readFileSync(p, 'utf8');
    assert.equal(before, after, 'file must be untouched on validation failure');
  });
});

test('supports multiple --show= args in one invocation', () => {
  withTmpFile({ shows: {} }, (p) => {
    const { code } = captureConsole(() =>
      main([`--show=show-one`, `--show=show-two`, `--data-file=${p}`])
    );
    assert.equal(code, 0);
    const written = JSON.parse(readFileSync(p, 'utf8'));
    assert.ok(written.shows['show-one']);
    assert.ok(written.shows['show-two']);
  });
});
