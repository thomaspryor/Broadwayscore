// BRO-7230: the --finalize CLI must stamp probe.incompleteReason on a short probe and leave a full one clean.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../../scripts/lib/press-night-record.js');
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function finalizeWith(lastSampleOffsetH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-fin-'));
  const embargoAt = '2026-11-10T03:00:00.000Z';
  const rec = R.emptyRecord({ showId: 's', night: '2026-11-09', embargoAt });
  rec.probe.lastSampleAt = new Date(Date.parse(embargoAt) + lastSampleOffsetH * 3600000).toISOString();
  fs.writeFileSync(R.recordPath(dir, 's', '2026-11-09'), JSON.stringify(rec));
  try {
    execFileSync('node', ['scripts/press-night-record.js', '--show=s', '--night=2026-11-09', '--finalize', `--dir=${dir}`], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) { /* the verdict print may exit non-zero; the record is what we read */ }
  return JSON.parse(fs.readFileSync(R.recordPath(dir, 's', '2026-11-09'), 'utf8')).probe;
}

test('finalize stamps incompleteReason on a probe that stopped at +2h', () => {
  const p = finalizeWith(2);
  assert.ok(p.endedAt);
  assert.match(p.incompleteReason, /stopped at \+2\.0h/);
});

test('finalize leaves a full +6h probe clean', () => {
  const p = finalizeWith(5.95);
  assert.ok(p.endedAt);
  assert.equal(p.incompleteReason, undefined);
});
