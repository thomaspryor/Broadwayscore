import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { scanWorkflows, MIN_EXPECTED_WORKFLOWS } = require('./scan-alert-ledger-gaps.js');

// The 0/1/2 exit contract is load-bearing — 2 must never collapse into 1,
// because an uncaught throw exits 1 and a BROKEN guard must not be mistaken for
// a guard that found real violations. Before these tests the whole scanner was
// top-level code with no require.main guard, so none of this was reachable from
// a test and a regression would have shipped silently (review finding).

const NO_VIOLATIONS = () => [];

function makeTree(fileCount, { contents = 'name: x\n' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-gaps-'));
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(dir, `wf-${String(i).padStart(3, '0')}.yml`), contents);
  }
  return dir;
}

test('code 0 when a real tree has no violations', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 0);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS);
    assert.deepEqual(r.violations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 1, with each violation prefixed by its file, when the checker reports', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => ['job X missing the staging line']);
    assert.equal(r.code, 1);
    assert.equal(r.violations.length, MIN_EXPECTED_WORKFLOWS);
    assert.match(r.violations[0], /^wf-000\.yml: job X missing the staging line$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 — NOT 0 — when the tree is too small to be real', () => {
  // The regression this guards: a scanner printing "clean" having scanned
  // nothing. Must not be 0, and must not be 1 either (nothing was found).
  const dir = makeTree(3);
  try {
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 2);
    assert.match(r.error, /refusing to report a verdict/);
    assert.deepEqual(r.violations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 when the directory does not exist', () => {
  const r = scanWorkflows(path.join(os.tmpdir(), 'scan-gaps-does-not-exist-xyz'), NO_VIOLATIONS);
  assert.equal(r.code, 2);
  assert.match(r.error, /could not read/);
});

test('code 2 — NOT 1 — when the checker itself throws', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => { throw new Error('checker exploded'); });
    assert.equal(r.code, 2);
    assert.match(r.error, /checker threw on .*checker exploded/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 — NOT 1 — when the checker returns undefined', () => {
  // The 2->1 collapse: iterating undefined threw OUT of scanWorkflows, the CLI
  // had no catch, and node exited 1 — a BROKEN checker reported as "violations
  // found". Realistic trigger: an early `return;` added for a no-jobs workflow.
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => undefined);
    assert.equal(r.code, 2);
    assert.match(r.error, /checker returned undefined \(expected an array\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 — NOT 1 — when the checker returns null', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => null);
    assert.equal(r.code, 2);
    assert.match(r.error, /checker returned null/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a STRING return fabricates nothing — a string is iterable, per character', () => {
  // Measured against the real repo before the fix: 732 fabricated violations,
  // one per character. "Says violations when it merely broke."
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => 'boom');
    assert.equal(r.code, 2);
    assert.match(r.error, /checker returned string/);
    assert.deepEqual(r.violations, [], 'must not fabricate per-character violations');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The 2->1 collapse kept MOVING rather than closing: first the iteration was
// outside the try, then the catch handler itself could throw on `err.message`.
// These drive the catch handler with values that make naive error formatting
// explode. Each must return code 2 from scanWorkflows, never escape it.
for (const [label, thrower] of [
  ['throw null', () => { throw null; }],
  ['throw undefined', () => { throw undefined; }],
  ['throw a string', () => { throw 'plain string'; }],
  ['throw an object whose .message getter throws', () => {
    throw { get message() { throw new Error('nested'); } };
  }],
  ['throw an object whose toString throws', () => {
    throw { toString() { throw new Error('nested'); }, get message() { return undefined; } };
  }],
  ['throw a Symbol', () => { throw Symbol('nope'); }],
]) {
  test(`code 2 — NOT 1 — when the checker does: ${label}`, () => {
    const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
    try {
      let r;
      assert.doesNotThrow(() => { r = scanWorkflows(dir, thrower); }, `${label} escaped scanWorkflows`);
      assert.equal(r.code, 2);
      assert.match(r.error, /checker threw on /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('code 2 when the checker returns an array of non-strings (no [object Object] findings)', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => [{ job: 'x' }]);
    assert.equal(r.code, 2);
    assert.match(r.error, /a non-string \(object\) violation at index 0/);
    assert.deepEqual(r.violations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 when the checker returns a sparse array (holes stringify to "undefined")', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const sparse = ['a'];
    sparse[2] = 'c'; // index 1 is a hole
    const r = scanWorkflows(dir, () => sparse);
    assert.equal(r.code, 2);
    assert.match(r.error, /a non-string \(undefined\) violation at index 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 — and the reason says EMPTY, not "non-string" — on an empty-string element', () => {
  // An empty string IS a string. Reporting it as a "non-string violation" sent
  // the reader hunting for the wrong bug (review finding).
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => ['ok', '']);
    assert.equal(r.code, 2);
    assert.match(r.error, /an empty violation at index 1/);
    assert.doesNotMatch(r.error, /non-string/);
    assert.deepEqual(r.violations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 on a violation containing a newline (one finding must not print as two lines)', () => {
  // A violation carrying an embedded \n prints as TWO stdout lines, so a caller
  // counting lines disagrees with TOTAL VIOLATIONS — the scanner over-reports
  // its own verdict (review finding).
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => ['line one\nline two']);
    assert.equal(r.code, 2);
    assert.match(r.error, /a multi-line violation at index 0/);
    assert.deepEqual(r.violations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanned counts files READ, not files FOUND, on a mid-scan code-2 return', () => {
  // files.length claimed credit for files never opened (review finding).
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    let calls = 0;
    const r = scanWorkflows(dir, () => {
      calls += 1;
      if (calls === 3) throw new Error('boom on the third file');
      return [];
    });
    assert.equal(r.code, 2);
    assert.equal(r.scanned, 2, 'two files were fully read and checked before the throw');
    assert.notEqual(r.scanned, MIN_EXPECTED_WORKFLOWS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 on a violation containing a bare \r (it OVERWRITES the printed line)', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => ['visible\rHIDDEN']);
    assert.equal(r.code, 2);
    assert.match(r.error, /a control-character violation at index 0/);
    assert.deepEqual(r.violations, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an array overriding [Symbol.iterator] to yield nothing cannot turn a REAL finding into code 0', () => {
  // Validating one array and then PUBLISHING a second read of it was a hole,
  // not a guard: the publish step used for..of, so a hostile iterator silently
  // dropped every finding the validator had just approved (review finding).
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => {
      const a = ['job X missing the staging line'];
      a[Symbol.iterator] = function* () { /* yields nothing */ };
      return a;
    });
    assert.equal(r.code, 1, 'the real finding must still be reported');
    assert.equal(r.violations.length, MIN_EXPECTED_WORKFLOWS);
    assert.match(r.violations[0], /job X missing the staging line$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an element whose value CHANGES between validation and publication publishes the validated value', () => {
  const dir = makeTree(1 + MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => {
      const a = [];
      let reads = 0;
      Object.defineProperty(a, 0, {
        get() { reads += 1; return reads === 1 ? 'real finding' : undefined; },
        enumerable: true,
        configurable: true,
      });
      return a;
    });
    assert.equal(r.code, 1);
    for (const v of r.violations) {
      assert.doesNotMatch(v, /undefined/, 'a second read must never reach the output');
      assert.match(v, /real finding$/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a Proxy that under-reports length to the validator cannot smuggle an element past it', () => {
  // length is snapshotted ONCE: a Proxy answering 0 to the validator and its
  // real length to the publisher would otherwise bypass validation entirely
  // (review finding).
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const r = scanWorkflows(dir, () => {
      const target = ['smuggled\nmulti-line finding'];
      let lengthReads = 0;
      return new Proxy(target, {
        get(t, k) {
          if (k === 'length') { lengthReads += 1; return lengthReads === 1 ? 0 : t.length; }
          return t[k];
        },
      });
    });
    assert.equal(r.code, 0, 'nothing was validated, so nothing may be published');
    assert.deepEqual(r.violations, [], 'the smuggled element must not reach the output');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('code 2 when a workflow FILENAME contains a newline (it prefixes every record)', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    fs.writeFileSync(path.join(dir, 'aa-bad\nname.yml'), 'name: x\n');
    const r = scanWorkflows(dir, () => ['job X missing the staging line']);
    assert.equal(r.code, 2);
    assert.match(r.error, /filename contains a control character/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanned is 0 — not the file count — on the too-few-workflows refusal', () => {
  const dir = makeTree(3);
  try {
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 2);
    assert.equal(r.scanned, 0, 'nothing was opened or checked');
    assert.match(r.error, /found only 3 workflow file\(s\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const REAL_FINDING = 'job X missing the staging line';

for (const [label, lying] of [
  ['NaN', NaN],
  ['undefined', undefined],
  ['-1', -1],
  ['0.5', 0.5],
]) {
  test(`code 2 — NOT a false-clean 0 — when the array's length LIES: ${label}`, () => {
    // Snapshotting length fixed the double-read, but a snapshot of a LIE is
    // still a lie: `i < n` is false on the first test, validation is skipped
    // entirely, and a REAL finding publishes as code 0 — the "clean verdict
    // having scanned nothing" this whole file exists to prevent (review
    // finding, measured against the live tree).
    const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
    try {
      const r = scanWorkflows(dir, () => new Proxy([REAL_FINDING], {
        get(t, k) { return k === 'length' ? lying : t[k]; },
      }));
      assert.notEqual(r.code, 0, 'a real finding must never publish as clean');
      assert.equal(r.code, 2);
      assert.match(r.error, /length is not a non-negative integer/);
      assert.deepEqual(r.violations, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('an OBJECT-valued length terminates instead of spinning on repeated coercion', () => {
  // `i < n` coerces an object length on EVERY comparison, so a valueOf() that
  // grows never terminates. typeof is checked before any comparison happens.
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    let coercions = 0;
    const r = scanWorkflows(dir, () => new Proxy([REAL_FINDING], {
      get(t, k) {
        if (k === 'length') return { valueOf() { coercions += 1; return coercions; } };
        return t[k];
      },
    }));
    assert.equal(r.code, 2);
    assert.equal(coercions, 0, 'typeof must reject it before any coercion');
    assert.match(r.error, /length is not a non-negative integer \(object\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, code] of [['NEL U+0085', 0x85], ['LINE SEPARATOR U+2028', 0x2028], ['PARAGRAPH SEPARATOR U+2029', 0x2029]]) {
  test(`code 2 on a violation containing ${label} (a line terminator too)`, () => {
    const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
    try {
      const r = scanWorkflows(dir, () => [`before${String.fromCharCode(code)}after`]);
      assert.equal(r.code, 2);
      assert.match(r.error, /violation at index 0/);
      assert.deepEqual(r.violations, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('.YML (uppercase) is scanned, not silently skipped', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    fs.writeFileSync(path.join(dir, 'zz-shouty.YML'), 'name: z\n');
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS + 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink POINTING AT A DIRECTORY cannot wedge the scan (EISDIR regression)', () => {
  // Accepting every symlink let a dir-shaped one reach readFileSync -> EISDIR,
  // and with fail-fast over a sorted list an early-sorting name aborted the
  // WHOLE scan at code 2. statSync follows the link, so it is excluded instead.
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    const realDir = path.join(dir, 'a-real-directory');
    fs.mkdirSync(realDir);
    // "aaa-" sorts before every wf-NNN.yml, so a regression aborts everything.
    fs.symlinkSync(realDir, path.join(dir, 'aaa-points-at-a-dir.yml'));
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 0, `expected a clean scan, got code ${r.code}: ${r.error}`);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink to a real workflow IS scanned (silent-skip regression)', () => {
  // The opposite error: filtering on dirent.isFile() alone excluded every
  // symlinked workflow, silently under-reporting.
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    fs.symlinkSync(path.join(dir, 'wf-000.yml'), path.join(dir, 'zz-linked.yml'));
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 0);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS + 1, 'the symlinked workflow must be scanned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a BROKEN symlink is skipped rather than wedging the scan', () => {
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    fs.symlinkSync(path.join(dir, 'nothing-here.yml'), path.join(dir, 'aaa-broken.yml'));
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.code, 0, `expected a clean scan, got code ${r.code}: ${r.error}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('.yaml workflows are scanned too, not silently ignored', () => {
  // GitHub Actions honours both extensions; matching only .yml would let a
  // future alerting.yaml go unscanned while still printing a clean verdict.
  const dir = makeTree(MIN_EXPECTED_WORKFLOWS);
  try {
    fs.writeFileSync(path.join(dir, 'zz-modern.yaml'), 'name: y\n');
    const r = scanWorkflows(dir, NO_VIOLATIONS);
    assert.equal(r.scanned, MIN_EXPECTED_WORKFLOWS + 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real repo scans clean', () => {
  const { findMissingLedgerCommits } = require('./alert-ledger-commit-check.js');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.github', 'workflows');
  const r = scanWorkflows(dir, findMissingLedgerCommits);
  assert.equal(r.code, 0, `expected the repo to be clean, got: ${r.violations.join('; ')} ${r.error || ''}`);
  assert.ok(r.scanned > MIN_EXPECTED_WORKFLOWS, 'sanity: the repo should have many workflows');
});
