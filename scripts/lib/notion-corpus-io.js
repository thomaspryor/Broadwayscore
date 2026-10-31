#!/usr/bin/env node
// scripts/lib/notion-corpus-io.js — the ONE way to locate and read a Sprint 2
// Notion corpus export.
//
// WHY THIS IS A SEPARATE FILE FROM notion-corpus.js. That file opens by
// declaring "No fetch, no fs, no Notion client" and it means it: everything in
// it takes already-fetched Notion objects and returns plain data, which is what
// lets the reassembly rules — the parts that can silently lose content — be
// tested against fixtures instead of against a 95MB archive. Putting file I/O
// in there would break that on purpose-built ground. So the pure rules stay
// pure and the I/O lives here.
//
// WHY IT EXISTS AT ALL. It did not, and the cost was immediate. The published
// corpus is gzipped (`corpus.ndjson.gz`) because 95MB raw would break GitHub's
// 100MB blob limit on the next export, so the gz is the ONLY form the archive
// ever exists in once promoted. `verify-notion-corpus.js` knew that;
// `migrate-import-ledger.js` did not — it looked for `corpus.ndjson` inside the
// directory it was handed, found nothing, and returned an empty index. The
// visible symptom was a run that printed
//
//     resolved via corpus   0  (no --corpus given)
//
// with `--corpus` given, pointed at a corpus that verifies clean. The
// title-recovery step was skipped in silence and the migration would have
// written 92 rows with `pageId: null` that were recoverable.
//
// Every later consumer — the S3-T6 dry-run disposition report, the S3-T7a
// anti-join — reads this corpus to decide what is and is not accounted for.
// Each one reimplementing half of "find the file" is how a completeness check
// passes by finding nothing.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const RAW_NAME = 'corpus.ndjson';
const GZ_NAME = 'corpus.ndjson.gz';

/**
 * Resolve a user-supplied `--corpus` value to an actual corpus file.
 *
 * Accepts an export DIRECTORY (preferring the raw ndjson if a working copy is
 * present, else the published gz) or a FILE path directly. Returns null when
 * nothing is there — callers decide whether that is fatal.
 */
function corpusPath(dirOrFile) {
  if (!dirOrFile) return null;
  let stat;
  try {
    stat = fs.statSync(dirOrFile);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    const raw = path.join(dirOrFile, RAW_NAME);
    const gz = path.join(dirOrFile, GZ_NAME);
    // Raw wins when both are present, because a working run directory has the
    // raw file and that is the one being iterated on. In a PUBLISHED directory
    // only the gz exists — promote-notion-corpus.sh:122 `rm -f "$DEST/corpus.ndjson"`
    // is what guarantees that, and it is the only thing standing between this
    // preference and certifying a stale raw copy alongside a fresh gz. If that
    // rm is ever dropped, this preference has to be revisited with it.
    if (fs.existsSync(raw)) return raw;
    if (fs.existsSync(gz)) return gz;
    return null;
  }
  return dirOrFile;
}

/**
 * Read every record. THROWS when the corpus is missing rather than returning an
 * empty array: `[]` is indistinguishable from a genuinely empty archive at the
 * call site, and every consumer of this treats "no pages" as "nothing to
 * reconcile" — which is precisely how a missing corpus turns into a green
 * completeness check.
 *
 * Malformed lines are counted, not thrown on, matching readRows() in
 * import-ledger.js: a torn line should be reported, not silently dropped and
 * not fatal.
 */
function readCorpusRecords(dirOrFile) {
  const file = corpusPath(dirOrFile);
  if (!file) {
    throw new Error(
      `no corpus at ${dirOrFile || '<unset>'} — looked for ${RAW_NAME} and ${GZ_NAME}`
    );
  }
  const text = file.endsWith('.gz')
    ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
    : fs.readFileSync(file, 'utf8');
  const records = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { file, records, malformed };
}

module.exports = { corpusPath, readCorpusRecords, RAW_NAME, GZ_NAME };
