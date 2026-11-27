// BRO-8407 class guard. shows-write-guard refuses a NEW row whose title is a
// fragment of a catalogued row at the same venue with overlapping dates
// (newRowFragmentFindings). A promoter that dedups only with
// duplicateOfCandidate never sees that pair, mints the row, and the save throws
// for the whole batch ("Sasha Velour's Travesty" beside "Travesty" aborted every
// OB promotion run). Any script that writes through the guard AND dedups with
// duplicateOfCandidate must also ask the fragment detector before it mints a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('guarded promoters that dedup with duplicateOfCandidate also run the fragment check (BRO-8407)', () => {
  const offenders = [];
  let checked = 0;
  for (const f of fs.readdirSync(SCRIPTS).filter((n) => n.endsWith('.js'))) {
    const src = strip(fs.readFileSync(path.join(SCRIPTS, f), 'utf8'));
    if (!/createShowsWriteGuard\s*\(/.test(src) || !/duplicateOfCandidate\s*\(/.test(src)) continue;
    checked++;
    if (!/newRowFragmentFindings\s*\(|newRowDuplicate\s*\(/.test(src)) offenders.push(f);
  }
  assert.ok(checked >= 2, `expected to inspect the guarded promoters, saw ${checked}`);
  assert.deepEqual(offenders, [], `these write through shows-write-guard but never run the title-fragment check, so one candidate can abort the whole run at save: ${offenders.join(', ')}`);
});
