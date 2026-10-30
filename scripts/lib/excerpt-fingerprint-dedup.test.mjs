import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const D = require('./excerpt-fingerprint-dedup.js');
const { createClaimLedger } = require('./dedup-survivor.js');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

// Shape of the a-few-good-men-2026 pair (BRO-6585): same outlet, same BWW roundup
// excerpt, a byline mangled by a leading "b", neither record has a url or fullText.
const EXCERPT = 'A taut, polished revival that finds fresh urgency in Sorkin\'s courtroom drama, anchored by a commanding central performance.';
const real = { outletId: 'independent', outlet: 'The Independent', criticName: 'Caitlin Hornik', bwwExcerpt: EXCERPT };
const mangled = { outletId: 'independent', outlet: 'The Independent', criticName: 'Bcaitlin Hornik', bwwExcerpt: EXCERPT };

test('byline-mangled twin with the same bwwExcerpt at the same outlet is collapsed (BRO-6628)', () => {
  const seen = new Map();
  assert.deepEqual(D.checkExcerptDuplicate(real, 'independent', 'independent--caitlin-hornik.json', seen), { duplicateOf: null });
  const second = D.checkExcerptDuplicate(mangled, 'independent', 'independent--bcaitlin-hornik.json', seen);
  assert.equal(second.duplicateOf, 'independent--caitlin-hornik.json', 'first-seen file wins');
});

test('whitespace and punctuation differences in the excerpt still match', () => {
  const seen = new Map();
  D.checkExcerptDuplicate(real, 'independent', 'a.json', seen);
  const noisy = { ...mangled, bwwExcerpt: '  ' + EXCERPT.replace(/ /g, '  ').toUpperCase() + ' ' };
  assert.equal(D.checkExcerptDuplicate(noisy, 'independent', 'b.json', seen).duplicateOf, 'a.json');
});

test('the same excerpt at a DIFFERENT outlet is not a duplicate', () => {
  const seen = new Map();
  D.checkExcerptDuplicate(real, 'independent', 'a.json', seen);
  assert.equal(D.checkExcerptDuplicate(real, 'guardian', 'b.json', seen).duplicateOf, null);
});

test('a different excerpt at the same outlet is kept', () => {
  const seen = new Map();
  D.checkExcerptDuplicate(real, 'independent', 'a.json', seen);
  const other = { ...mangled, bwwExcerpt: 'Hornik found the second act sluggish, with the verdict landing far more softly than the rest of the staging promised.' };
  assert.equal(D.checkExcerptDuplicate(other, 'independent', 'b.json', seen).duplicateOf, null);
});

test('records with usable fullText are left to the fullText fingerprint dedup', () => {
  const full = { ...real, fullText: 'x'.repeat(150) };
  assert.deepEqual(D.excerptFingerprintKeys(full, 'independent'), []);
  const seen = new Map();
  D.checkExcerptDuplicate(real, 'independent', 'a.json', seen);
  assert.equal(D.checkExcerptDuplicate(full, 'independent', 'b.json', seen).duplicateOf, null);
});

test('short generic excerpts never collide', () => {
  const seen = new Map();
  const a = { bwwExcerpt: 'Great show!' };
  D.checkExcerptDuplicate(a, 'independent', 'a.json', seen);
  assert.equal(D.checkExcerptDuplicate({ bwwExcerpt: 'Great show!' }, 'independent', 'b.json', seen).duplicateOf, null);
  assert.deepEqual(D.excerptFingerprintKeys({}, 'independent'), []);
  assert.deepEqual(D.excerptFingerprintKeys(null, 'independent'), []);
});

test('a bwwExcerpt and a dtliExcerpt with the same text do not cross-match (field is part of the key)', () => {
  const seen = new Map();
  D.checkExcerptDuplicate({ bwwExcerpt: EXCERPT }, 'independent', 'a.json', seen);
  assert.equal(D.checkExcerptDuplicate({ dtliExcerpt: EXCERPT }, 'independent', 'b.json', seen).duplicateOf, null);
});

test('claims route through the dedup ledger so a dropped winner releases them (BRO-5901)', () => {
  const ledger = createClaimLedger();
  const seen = new Map();
  const claim = (m, k, v) => ledger.setClaim(m, k, v);
  ledger.begin();
  D.checkExcerptDuplicate(real, 'independent', 'a.json', seen, claim);
  assert.equal(seen.size, 1);
  ledger.arm();
  assert.equal(ledger.rollback(), 1, 'winner died at a later gate');
  assert.equal(seen.size, 0, 'rollback gives the claim back');
  assert.equal(D.checkExcerptDuplicate(mangled, 'independent', 'b.json', seen, claim).duplicateOf, null);
});

test('rebuild-all-reviews.js wires the excerpt dedup after the fullText fingerprint dedup and before the ledger arms', () => {
  const js = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  const fp = js.indexOf('[CROSS-OUTLET FINGERPRINT DEDUP]');
  const ex = js.indexOf('checkExcerptDuplicate(data');
  const arm = js.indexOf('ledger.arm();', ex);
  assert.ok(fp > 0 && ex > fp && arm > ex, 'order: fingerprint dedup, excerpt dedup, ledger.arm');
});

test('the survivor tie-break keeps the unmangled byline in either file order (BRO-6628 review)', () => {
  const { compareFilesForDedupPriority: cmp } = require('./rebuild-helpers.js');
  const a = { file: 'independent--bcaitlin-hornik.json' }, b = { file: 'independent--caitlin-hornik.json' };
  assert.equal([a, b].sort(cmp)[0].file, b.file);
  assert.equal([b, a].sort(cmp)[0].file, b.file);
});

test('West End excerpt fields are fingerprinted too (shared EXCERPT_FIELDS list)', () => {
  const seen = new Map();
  const rec = { theStageExcerpt: EXCERPT };
  D.checkExcerptDuplicate(rec, 'thestage', 'a.json', seen);
  assert.equal(D.checkExcerptDuplicate(rec, 'thestage', 'b.json', seen).duplicateOf, 'a.json');
});
