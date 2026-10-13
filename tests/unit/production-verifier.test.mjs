/**
 * BRO-2278: cross-tour-leg venue guard in scripts/lib/production-verifier.js.
 * Run: node --test tests/unit/production-verifier.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyProduction, findOtherTourLegVenue } = require('../../scripts/lib/production-verifier.js');

const QEH = 'Queen Elizabeth Hall - Southbank Centre';
const SHOW = { id: 'tour-show-off-west-end-2026', venue: QEH, category: 'off-west-end' };
// The BRO-749 case: a Salford-leg review surfaced for the QEH show page.
const WRONG_LEG = 'A joyous adaptation with a terrific young cast. The Boy at the Back of the Class runs until 18 April at the Lowry, Salford.';

function verify(text, overrides = {}) {
  return verifyProduction({ showId: SHOW.id, text, category: SHOW.category, showData: SHOW, ...overrides });
}

test('a review of another tour leg is rejected on a West End / Off-West End show', () => {
  const r = verify(WRONG_LEG);
  assert.equal(r.shouldReject, true);
  assert.ok(r.issues.some((i) => i.type === 'uk_tour_leg_venue_mismatch'));
});

test('a review that names this show\'s own venue and the next stop is kept', () => {
  const r = verify('At the Queen Elizabeth Hall until 12 April, then tours to the Lowry, Salford until 18 April.');
  assert.equal(r.shouldReject, false);
});

test('tour framing and bare mentions of another venue are not flagged', () => {
  assert.equal(findOtherTourLegVenue('The tour visits the Lowry later in the spring.', QEH), null, 'no current-run language');
  assert.equal(findOtherTourLegVenue('After its run at the Lowry until March, it now arrives in London.', QEH), null, 'after-its-run framing');
  assert.equal(findOtherTourLegVenue('Previously seen at Chichester Festival Theatre until May last year.', 'Gielgud Theatre'), null, 'previously/last-year framing');
});

test('a venue that is part of the show\'s own venue name is never "another leg"', () => {
  assert.equal(findOtherTourLegVenue('It plays at the Lowry until Saturday.', 'The Lowry, Salford'), null);
});

test('Broadway / off-Broadway / uncategorized calls are unchanged (Les Liaisons transfer sentence)', () => {
  // Codex review finding on the first attempt: passing the show's category
  // through for US shows turned on the London-venue check and dropped this
  // genuine Booth Theatre review at gather time.
  const lesLiaisons = 'Les Liaisons Dangereuses comes to the Booth Theatre after starting at the Donmar Warehouse in London.';
  const showData = { id: 'les-liaisons-dangereuses-2016', venue: 'Booth Theatre', category: 'broadway' };
  for (const category of [undefined, 'off-broadway']) {
    const r = verifyProduction({ showId: showData.id, text: lesLiaisons, category, showData });
    assert.equal(r.shouldReject, false, `category=${category}`);
  }
  // And the tour-leg check itself needs a UK category.
  assert.equal(verify(WRONG_LEG, { category: undefined }).shouldReject, false);
  assert.equal(verify(WRONG_LEG, { showData: { ...SHOW, venue: undefined } }).shouldReject, false, 'no declared venue, no check');
});

test('audit-tour-leg-venues.js reports the wrong-leg file and skips already-excluded ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-2278-'));
  const rt = path.join(dir, 'review-texts', SHOW.id);
  fs.mkdirSync(rt, { recursive: true });
  fs.writeFileSync(path.join(rt, 'a.json'), JSON.stringify({ fullText: WRONG_LEG }));
  fs.writeFileSync(path.join(rt, 'b.json'), JSON.stringify({ fullText: WRONG_LEG, wrongProduction: true }));
  fs.writeFileSync(path.join(rt, 'c.json'), JSON.stringify({ fullText: 'At the Queen Elizabeth Hall until 12 April.' }));
  fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows: [SHOW] }));
  const res = spawnSync(process.execPath, [path.resolve('scripts/audit-tour-leg-venues.js'), '--json'], {
    env: { ...process.env, REVIEW_TEXTS_DIR: path.join(dir, 'review-texts'), SHOWS_PATH: path.join(dir, 'shows.json') },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.scanned, 2, 'the excluded file is not scanned');
  assert.deepEqual(out.hits.map((h) => h.file), ['a.json']);
});
