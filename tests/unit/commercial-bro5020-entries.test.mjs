// BRO-5050: the BRO-5020 cap-only commercial entries must stay applied to
// data/commercial.json (private data repo, gitignored). Skips when the file
// is absent (CI jobs without the private data).
//
// BRO-5111: exact values are NOT pinned. Owner-approved fixes
// (execute-approved-fix) keep refining capitalization and, under owner
// policy B, relabel long-closed shows Fizzle/Flop on the
// no-recoupment-announced basis (grey-house, mrs-doubtfire-2021,
// thoughts-of-a-colored-man-2021). Pinning those values turned main red twice.
// The test checks what must hold for any approved value: the entry exists,
// keeps a real capitalization, has a canonical designation, and every loss
// label or recouped:true carries its basis.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const { VALID_DESIGNATIONS, VALID_DESIGNATION_BASES } = createRequire(import.meta.url)('../../scripts/lib/commercial-designations.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = process.env.COMMERCIAL_JSON || path.join(root, 'data/commercial.json');
const present = fs.existsSync(file);
const data = present ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const records = data.productions || data.shows || data;

// hasCap: BRO-5020 supplied a capitalization that must not be dropped.
const ENTRIES = {
  'the-lehman-trilogy-2021': { hasCap: true },
  'mrs-doubtfire-2021': { hasCap: true },
  'thoughts-of-a-colored-man-2021': { hasCap: true },
  'the-piano-lesson-2022': { hasCap: true },
  'caroline-or-change-2021': { designation: 'Nonprofit' },
  'grey-house': { hasCap: true },
};

for (const [slug, want] of Object.entries(ENTRIES)) {
  test(`${slug} keeps its BRO-5020 entry`, { skip: !present && 'data/commercial.json not available' }, () => {
    const rec = records[slug];
    assert.ok(rec, `${slug} missing from commercial.json`);
    assert.ok(VALID_DESIGNATIONS.includes(rec.designation), `${slug}.designation not canonical (got ${rec.designation})`);
    if (want.designation) assert.equal(rec.designation, want.designation, `${slug}.designation`);
    if (want.hasCap) {
      assert.ok(Number.isFinite(rec.capitalization) && rec.capitalization > 0,
        `${slug}.capitalization must stay a positive number (got ${rec.capitalization})`);
    }
    // Owner policy B: a Fizzle/Flop needs a designationBasis, which may be
    // "no-recoupment-announced" for a long-closed show, not a recoupedSource.
    if (['Fizzle', 'Flop'].includes(rec.designation)) {
      assert.ok(VALID_DESIGNATION_BASES.includes(rec.designationBasis),
        `${slug}: loss label needs a designationBasis (got ${rec.designationBasis})`);
    }
    if (rec.recouped === true) assert.ok(rec.recoupedSource, `${slug}: recouped:true needs recoupedSource`);
  });
}
