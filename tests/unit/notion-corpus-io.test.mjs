// tests/unit/notion-corpus-io.test.mjs — the corpus locator/reader.
//
// This file exists because of one specific silent failure. The PUBLISHED Sprint 2
// corpus is `corpus.ndjson.gz` (95MB raw would break GitHub's 100MB blob limit),
// but migrate-import-ledger.js looked only for `corpus.ndjson` and returned an
// empty index when it did not find one. Running it against the real archive
// printed "resolved via corpus 0 (no --corpus given)" — with --corpus given —
// and skipped title recovery for 75 rows that were recoverable.
//
// The shape of that bug is what is asserted here: reading a gz archive must
// yield records, and a corpus that cannot be found must THROW rather than come
// back as an empty array that every caller reads as "nothing to reconcile".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const io = require(path.join(REPO, 'scripts/lib/notion-corpus-io.js'));

const RECORDS = [
  { id: 'aaa', properties: { Name: 'first card' } },
  { id: 'bbb', properties: { Name: 'second card' } },
];
const NDJSON = `${RECORDS.map((r) => JSON.stringify(r)).join('\n')}\n`;

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-io-'));
  return d;
}

test('reads a gzipped published corpus from its directory', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'corpus.ndjson.gz'), zlib.gzipSync(Buffer.from(NDJSON)));
  const { file, records, malformed } = io.readCorpusRecords(d);
  assert.equal(records.length, 2, 'the gz archive must be read, not skipped');
  assert.equal(malformed, 0);
  assert.ok(file.endsWith('.gz'));
  assert.deepEqual(records.map((r) => r.id), ['aaa', 'bbb']);
});

test('reads a raw corpus from its directory, and prefers it over the gz', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'corpus.ndjson'), NDJSON);
  fs.writeFileSync(path.join(d, 'corpus.ndjson.gz'), zlib.gzipSync(Buffer.from('')));
  const { file, records } = io.readCorpusRecords(d);
  assert.equal(records.length, 2, 'a working raw export must win over a stale gz');
  assert.ok(file.endsWith('corpus.ndjson'));
});

test('accepts a file path directly, gz or raw', () => {
  const d = tmpdir();
  const raw = path.join(d, 'somewhere.ndjson');
  fs.writeFileSync(raw, NDJSON);
  assert.equal(io.readCorpusRecords(raw).records.length, 2);

  const gz = path.join(d, 'somewhere.ndjson.gz');
  fs.writeFileSync(gz, zlib.gzipSync(Buffer.from(NDJSON)));
  assert.equal(io.readCorpusRecords(gz).records.length, 2);
});

test('a missing corpus THROWS — it never reads as an empty archive', () => {
  // The whole point. Returning [] here is what turned a missing corpus into a
  // green completeness check: every consumer treats "no pages" as "nothing to
  // reconcile", so the anti-join that exists to catch silent loss passes by
  // finding nothing to compare.
  const d = tmpdir();
  assert.throws(() => io.readCorpusRecords(d), /no corpus at/);
  assert.throws(() => io.readCorpusRecords(path.join(d, 'nope.ndjson')), /no corpus at/);
  assert.throws(() => io.readCorpusRecords(null), /no corpus at/);
  assert.equal(io.corpusPath(d), null);
  assert.equal(io.corpusPath(null), null);
});

test('a torn line is counted, not thrown on and not silently dropped', () => {
  const d = tmpdir();
  fs.writeFileSync(path.join(d, 'corpus.ndjson'), `${NDJSON}{"id":"ccc"`);
  const { records, malformed } = io.readCorpusRecords(d);
  assert.equal(records.length, 2);
  assert.equal(malformed, 1, 'a half-written line must be reported');
});

test('migrate-import-ledger refuses a --corpus it cannot read, instead of skipping recovery', () => {
  // The user-visible half of the bug: the flag was accepted, the recovery step
  // did not run, and the output said "(no --corpus given)". Silence on a flag
  // that WAS given is the failure mode; exiting non-zero is the fix.
  const { execFileSync } = require('node:child_process');
  const d = tmpdir();
  let code = 0;
  let out = '';
  try {
    out = execFileSync(
      process.execPath,
      [path.join(REPO, 'scripts/migrate-import-ledger.js'), `--corpus=${d}`, '--legacy=/nonexistent-legacy.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } catch (err) {
    code = err.status;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  assert.notEqual(code, 0, 'an unreadable --corpus must be fatal');
  assert.doesNotMatch(out, /no --corpus given/, 'must never report a given flag as absent');
});
