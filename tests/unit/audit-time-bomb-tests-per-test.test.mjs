// BRO-5590: the time-bomb audit's exemption used to be whole-file, so one
// clock-coupled test hid every future bomb added to its file. A per-test marker
// (`timebomb-audit-exempt-test: <name> | <reason>`) exempts only that test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  readExemptTests, readExemptFiles, exemptionReason, EXEMPT_TEST_MARKER, EXEMPT_MARKER,
} = require('../../scripts/audit-time-bomb-tests.js');

const ROOT = path.join(import.meta.dirname, '..', '..');

function withFixture(src, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-pertest-'));
  try {
    const abs = path.join(dir, 'x.test.mjs');
    fs.writeFileSync(abs, src);
    return fn(path.relative(ROOT, abs));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('per-test marker exempts only the named test, not its file neighbours', () => {
  withFixture(`// ${EXEMPT_TEST_MARKER} reads fs mtime | fs clock is not shifted\n`, (rel) => {
    const tests = readExemptTests([rel]);
    const files = readExemptFiles([rel]);
    assert.match(exemptionReason(rel, 'reads fs mtime', files, tests), /fs clock/);
    assert.equal(exemptionReason(rel, 'some other test', files, tests), null);
    assert.equal(files.has(rel), false, 'per-test marker must not become a whole-file exemption');
  });
});

test('whole-file marker still exempts every test in the file', () => {
  withFixture(`// ${EXEMPT_MARKER} clock coupled by design for this whole file\n`, (rel) => {
    const tests = readExemptTests([rel]);
    const files = readExemptFiles([rel]);
    assert.ok(exemptionReason(rel, 'anything at all', files, tests));
  });
});

test('per-test marker needs a comment line, a name, and a reason', () => {
  const bad = [
    `const s = "${EXEMPT_TEST_MARKER} t | not a comment";\n`,
    `// ${EXEMPT_TEST_MARKER} no reason separator\n`,
    `// ${EXEMPT_TEST_MARKER} name only |   \n`,
    `// ${EXEMPT_TEST_MARKER} | reason but no name\n`,
  ];
  for (const src of bad) {
    withFixture(src, (rel) => assert.equal(readExemptTests([rel]).has(rel), false, src));
  }
});

test('a file may exempt several tests independently', () => {
  withFixture(`// ${EXEMPT_TEST_MARKER} a | reason a here\n// ${EXEMPT_TEST_MARKER} b | reason b here\n`, (rel) => {
    const tests = readExemptTests([rel]);
    const files = readExemptFiles([rel]);
    assert.equal(exemptionReason(rel, 'a', files, tests), 'reason a here');
    assert.equal(exemptionReason(rel, 'b', files, tests), 'reason b here');
    assert.equal(exemptionReason(rel, 'c', files, tests), null);
  });
});

test('TAP-escaped "#" matches its unescaped marker; a "|" in the name is kept (split at last "|")', () => {
  withFixture(`// ${EXEMPT_TEST_MARKER} a # b | c | the reason\n`, (rel) => {
    const tests = readExemptTests([rel]);
    const files = readExemptFiles([rel]);
    assert.equal(exemptionReason(rel, 'a \\# b | c', files, tests), 'the reason');
    assert.equal(exemptionReason(rel, 'a \\# b', files, tests), null);
  });
});
