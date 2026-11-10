// BRO-7080 replay of BRO-4503 / BRO-5557: title-fragment duplicate stubs at the
// same venue were written by promoters that bypass add-show-action, because the
// save guard's key-index rule never pairs them. Rows are the originals from
// data commit 6d26b3edd^ (shows.json before the BRO-4503 merge).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { newRowFragmentFindings } = require('./shows-duplicate-rule.js');
const { createShowsWriteGuard } = require('./shows-write-guard.js');

const jena = { id: 'jena-friedman-motherfucker-off-broadway-2026', slug: 'jena-friedman-motherfucker-off-broadway-2026', title: 'Jena Friedman: Motherfucker', venue: 'SoHo Playhouse', category: 'off-broadway', type: 'play', status: 'open', openingDate: '2026-10-01', closingDate: '2026-10-11' };
const stub = { id: 'motherfucker-off-broadway-2026', slug: 'motherfucker-off-broadway-2026', title: 'Motherfucker', venue: 'Soho Playhouse Main Stage', category: 'off-broadway', type: 'play', status: 'open', openingDate: '2026-10-01' };
const bourneLong = { id: 'matthew-bournes-new-adventures-cinderella-off-west-end-2026', slug: 'matthew-bournes-new-adventures-cinderella-off-west-end-2026', title: "Matthew Bourne's New Adventures - Cinderella", venue: "Sadler's Wells", category: 'off-west-end', type: 'musical', status: 'upcoming', previewsStartDate: '2026-12-01', closingDate: '2027-01-17' };
const bourneStub = { ...bourneLong, id: 'matthew-bournes-cinderella-off-west-end-2026', slug: 'matthew-bournes-cinderella-off-west-end-2026', title: "Matthew Bourne's Cinderella" };
const other = { id: 'hamlet-off-broadway-2026', slug: 'hamlet-off-broadway-2026', title: 'Hamlet', venue: 'SoHo Playhouse', category: 'off-broadway', type: 'play', status: 'open', openingDate: '2026-10-01' };

test('a new fragment stub at the same house is a finding; existing pairs and declared ones are not', () => {
  assert.deepEqual(newRowFragmentFindings([jena], [jena, stub]).map(f => [f.show.id, f.existing.id]), [[stub.id, jena.id]]);
  assert.deepEqual(newRowFragmentFindings([bourneLong], [bourneLong, bourneStub]).map(f => f.show.id), [bourneStub.id]);
  // Already on disk together: not this save's doing.
  assert.deepEqual(newRowFragmentFindings([jena, stub], [jena, stub]), []);
  // distinctFrom on either side declares a real second production.
  assert.deepEqual(newRowFragmentFindings([jena], [jena, { ...stub, distinctFrom: [jena.id] }]), []);
  assert.deepEqual(newRowFragmentFindings([{ ...jena, distinctFrom: [stub.id] }], [{ ...jena, distinctFrom: [stub.id] }, stub]), []);
  // An unrelated title at the same venue, or a different venue, is fine.
  assert.deepEqual(newRowFragmentFindings([jena], [jena, other]), []);
  assert.deepEqual(newRowFragmentFindings([jena], [jena, { ...stub, venue: 'Lucille Lortel Theatre' }]), []);
});

test('saveShows refuses the Motherfucker stub and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7080-frag-'));
  const p = path.join(dir, 'shows.json');
  try {
    fs.writeFileSync(p, JSON.stringify({ _meta: {}, shows: [jena] }, null, 2) + '\n');
    const guard = createShowsWriteGuard(p);
    const data = guard.loadShows();
    data.shows.push({ ...stub });
    assert.throws(() => guard.saveShows(data), /refusing to write 1 new duplicate.*motherfucker-off-broadway-2026/s);
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')).shows.map(s => s.id), [jena.id]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
