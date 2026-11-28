import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pickFingerprintOwners, duplicateTextTarget } = require('../../scripts/lib/fingerprint-owner.js');

// BRO-4188: 1776-2022 deadline--greg-evans.json (same-url loser, duplicateOf
// pete-hammond) sorts before deadline--pete-hammond.json (canonical).
test('same-url loser sorting first never owns the fingerprint', () => {
  const owners = pickFingerprintOwners([
    { file: 'deadline--greg-evans.json', fingerprint: 'F', duplicateOf: 'deadline--pete-hammond.json' },
    { file: 'deadline--pete-hammond.json', fingerprint: 'F' },
  ]);
  assert.equal(owners.get('F'), 'deadline--pete-hammond.json');
});

test('a canonical carrying last week\'s stale pointer still beats its loser', () => {
  const owners = pickFingerprintOwners([
    { file: 'a.json', fingerprint: 'F', duplicateOf: 'b.json' },
    { file: 'b.json', fingerprint: 'F', duplicateTextOf: 'a.json' },
  ]);
  assert.equal(owners.get('F'), 'b.json');
});

test('plain duplicates keep readdir order (first file owns)', () => {
  const owners = pickFingerprintOwners([
    { file: 'a.json', fingerprint: 'F' },
    { file: 'b.json', fingerprint: 'F' },
    { file: 'c.json', fingerprint: 'G' },
  ]);
  assert.equal(owners.get('F'), 'a.json');
  assert.equal(owners.get('G'), 'c.json');
});

test('duplicateTextTarget refuses self and duplicateOf cycles', () => {
  assert.equal(duplicateTextTarget('a.json', 'a.json', {}), null);
  assert.equal(duplicateTextTarget('a.json', undefined, undefined), null);
  assert.equal(duplicateTextTarget('a.json', 'b.json', { duplicateOf: 'a.json' }), null);
  // BRO-8206: the owner's own duplicateTextOf is cleared in the same 1C run,
  // so its pre-run value must not block the correct pointer.
  assert.equal(duplicateTextTarget('a.json', 'b.json', { duplicateTextOf: 'a.json' }), 'b.json');
  assert.equal(duplicateTextTarget('a.json', 'b.json', {}), 'b.json');
});

// BRO-8206: a forum repost must never own text that a real outlet page also carries.
const FORUM = 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2654250';
const REAL = 'https://theaterpizzazz.com/falls-for-jodie-a-stalker-in-love-and-pain/';

test('real outlet page owns text over a forum repost that sorts first', () => {
  const owners = pickFingerprintOwners([
    { file: 'talkinbroadway--alix-cohen.json', fingerprint: 'fp', url: FORUM },
    { file: 'theater-pizzazz--alix-cohen.json', fingerprint: 'fp', url: REAL },
  ]);
  assert.equal(owners.get('fp'), 'theater-pizzazz--alix-cohen.json');
});

test('a stale duplicateTextOf pointer at the forum file heals', () => {
  const owners = pickFingerprintOwners([
    { file: 'talkinbroadway--alix-cohen.json', fingerprint: 'fp', url: FORUM },
    { file: 'theater-pizzazz--alix-cohen.json', fingerprint: 'fp', url: REAL, duplicateTextOf: 'talkinbroadway--alix-cohen.json' },
  ]);
  const owner = owners.get('fp');
  assert.equal(owner, 'theater-pizzazz--alix-cohen.json');
  assert.equal(duplicateTextTarget('theater-pizzazz--alix-cohen.json', owner, {}), null);
  assert.equal(duplicateTextTarget('talkinbroadway--alix-cohen.json', owner, {}), 'theater-pizzazz--alix-cohen.json');
});

test('duplicateOf still outranks the forum penalty (BRO-4188 order kept)', () => {
  const owners = pickFingerprintOwners([
    { file: 'a.json', fingerprint: 'fp', url: REAL, duplicateOf: 'x.json' },
    { file: 'b.json', fingerprint: 'fp', url: FORUM },
  ]);
  assert.equal(owners.get('fp'), 'b.json');
});

test('no url keeps readdir order', () => {
  const owners = pickFingerprintOwners([
    { file: 'a.json', fingerprint: 'fp' },
    { file: 'b.json', fingerprint: 'fp' },
  ]);
  assert.equal(owners.get('fp'), 'a.json');
});

test('stale mutual pair heals in ONE pass: forum file points at the owner even though the owner still holds the old pointer', () => {
  const ownerMeta = { duplicateTextOf: 'talkinbroadway--alix-cohen.json' };
  assert.equal(duplicateTextTarget('talkinbroadway--alix-cohen.json', 'theater-pizzazz--alix-cohen.json', ownerMeta), 'theater-pizzazz--alix-cohen.json');
});
