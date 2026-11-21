// BRO-6506: Playbill's play/musical tag, including compound musical tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parsePlaybillTagLine } = require('./playbill-tagline.js');

const page = (...tags) => `<div class="bsp-bio-subtitle">${tags.map(t => `<h5 class="bsp-bio-sub-text">${t}</h5>`).join('')}</div>`;

test('Play / Musical tags, with revival status from the last tag', () => {
  assert.deepEqual(parsePlaybillTagLine(page('Broadway', 'Play', 'Dark Comedy', 'Revival')), { tags: ['Broadway', 'Play', 'Dark Comedy', 'Revival'], market: 'Broadway', showType: 'play', revivalStatus: 'revival' });
  assert.equal(parsePlaybillTagLine(page('Off-Broadway', 'Musical')).showType, 'musical');
});

test('compound musical tags count as musical (Going Bacharach: "Musical Revue")', () => {
  const r = parsePlaybillTagLine(page('Off-Broadway', 'Musical Revue', 'Original'));
  assert.equal(r.showType, 'musical');
  assert.equal(r.revivalStatus, 'original');
  assert.equal(parsePlaybillTagLine(page('Broadway', 'Musical Comedy', 'Revival')).showType, 'musical');
});

test('a bare market tag-line or "Play with Music" names no type', () => {
  assert.equal(parsePlaybillTagLine(page('Off-Broadway')).showType, null);
  assert.equal(parsePlaybillTagLine(page('Off-Broadway', 'Play with Music')).showType, null);
  assert.equal(parsePlaybillTagLine(page('Off-Broadway', 'Revival')).revivalStatus, 'unknown');
  assert.equal(parsePlaybillTagLine('').showType, null);
});
