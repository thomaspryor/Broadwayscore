// LIVE-DATA-LANE: planPromotions() reads data/retired-show-ids.json (core data)
// BRO-8120: a run declared as a priorRun of a transfer row is not minted again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const TODAY = '2026-11-23';

test('a run declared as a priorRun of a transfer row is not minted again (Punch / Young Vic)', () => {
  const { planPromotions } = require('../../scripts/promote-historical-we.js');
  const shows = [{ id: 'punch-west-end-2025', title: 'Punch', market: 'west-end', venue: 'Apollo Theatre', openingDate: '2025-05-01',
    priorRuns: [{ openingDate: '2025-03-06', closingDate: '2025-04-12', venue: 'Young Vic' }] }];
  const c = { title: 'Punch', venue: 'Young Vic', openingDate: '2025-03-06', previewsStartDate: '2025-02-25', closingDate: '2025-04-12', season: '2024-2025', genres: ['play'], signals: ['wos-review'] };
  const r = planPromotions({ candidates: [c], shows, approvals: {}, today: TODAY });
  assert.equal(r.toPromote.length, 0);
  assert.match(r.skipped[0].reason, /priorRun/);
  const other = planPromotions({ candidates: [{ ...c, title: 'Different Play' }], shows, approvals: {}, today: TODAY });
  assert.equal(other.toPromote.length, 1);
});
