// BRO-2190: cast-changes-real-data and validate-added-review-ownership are
// wall-clock coupled by design (live data freshness / fs-mtime read by an
// unshifted child process), so they carry a `timebomb-audit-exempt:` marker
// instead of being fixed. This pins that the audit script RECOGNIZES both
// markers: delete a marker, or break readExemptFiles(), and this fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readExemptFiles, EXEMPT_MARKER } = require('../../scripts/audit-time-bomb-tests.js');
const { MANIFESTS, readManifest } = require('../../scripts/lib/test-manifest.js');

const EXEMPT = [
  'tests/unit/cast-changes-real-data.test.mjs',
  'tests/unit/validate-added-review-ownership.test.mjs',
];

// cast-changes-real-data runs from check-corpus-drift.yml (live-data job), not a
// unit manifest, so the audit does not scan it today. The marker is still pinned
// so it keeps working if the file is ever moved into a manifest.
test('validate-added-review-ownership is in a CI manifest (else the audit never sees it)', () => {
  const all = new Set(MANIFESTS.flatMap((m) => readManifest(m)));
  assert.ok(all.has(EXEMPT[1]), `${EXEMPT[1]} missing from manifests`);
});

test('audit recognizes the exemption marker, with a real reason, in both files', () => {
  const exempt = readExemptFiles(EXEMPT);
  for (const rel of EXEMPT) {
    assert.ok(exempt.has(rel), `${rel} lost its ${EXEMPT_MARKER} marker or the audit ignores it`);
    assert.ok(exempt.get(rel).length >= 20, `${rel} exemption reason is too short: "${exempt.get(rel)}"`);
  }
});

test('marker only counts on a comment line (guards against silent over-exemption)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-exempt-'));
  try {
    const rel = path.relative(path.join(import.meta.dirname, '..', '..'), path.join(dir, 'x.test.mjs'));
    fs.writeFileSync(path.join(dir, 'x.test.mjs'), `const s = "${EXEMPT_MARKER} not a comment";\n`);
    assert.equal(readExemptFiles([rel]).has(rel), false);
    fs.writeFileSync(path.join(dir, 'x.test.mjs'), `// ${EXEMPT_MARKER} real comment reason here\n`);
    assert.equal(readExemptFiles([rel]).has(rel), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
