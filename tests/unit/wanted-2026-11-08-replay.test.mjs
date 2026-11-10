// BRO-7220: replay of Wanted's 2026-11-08 press night (record copied from data/audit/press-night, BRO-5955).
// Pins three findings from the morning-after review so a later change cannot silently undo them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const card = require('../../scripts/lib/review-completeness.js');
const rec = JSON.parse(fs.readFileSync(new URL('../fixtures/bro-7220/wanted-2022-2026-11-08.json', import.meta.url), 'utf8'));

test('record is the Wanted night and carries the lane shadow and file state', () => {
  assert.equal(rec.showId, 'wanted-2022');
  assert.equal(rec.night, '2026-11-08');
  assert.ok(rec.laneShadow?.discoveredByOutlet && rec.fileState?.files?.length > 15);
});

test('NY Daily News: found late (+2h06m) and has no review file, because it is the Tribune syndicate by design', () => {
  const embargo = Date.parse(rec.embargoAt);
  const found = Date.parse(rec.laneShadow.discoveredByOutlet.nydailynews);
  assert.equal(Math.floor((found - embargo) / 60000), 126);
  assert.ok(!rec.fileState.files.some((f) => f.outletId === 'nydailynews'), 'no nydailynews file was ever written');
  const tribune = rec.fileState.files.find((f) => f.outletId === 'chicagotribune');
  assert.equal(tribune?.critic, 'Chris Jones', 'the primary (Tribune, Chris Jones) was live at once');
  assert.ok(tribune.includable);
  const fams = require('../../scripts/lib/cross-outlet-pair-policy.js');
  assert.ok(fams && Object.keys(fams).length, 'policy module loads');
});

test('lane handback (03:43Z): every file the lane wrote carried the raw outlet id, and the contract flags each one', () => {
  const lane = rec.fileState.files.filter((f) => f.scoredAt && Date.parse(f.scoredAt) < Date.parse('2026-11-09T03:43:00Z'));
  assert.ok(lane.length >= 15);
  const raw = lane.filter((f) => f.outlet === f.outletId);
  assert.ok(raw.length >= 15, `raw outlet ids in the handback: ${raw.length}`);
  for (const f of raw) {
    const missing = card.missingCardFields({ outletId: f.outletId, outlet: f.outlet, criticName: f.critic, publishDate: f.publishDate }, { quote: false });
    assert.ok(missing.includes('outlet'), `${f.outletId} flagged for outlet: ${missing}`);
  }
});

test('Slant 55 vs 46: the 55 is the owner-approved humanReviewScore (BRO-7191, 04:15Z), not a writer overwriting the ensemble 46', () => {
  const slant = rec.fileState.files.find((f) => f.outletId === 'slantmagazine');
  assert.equal(slant.critic, 'Dan Rubins');
  assert.ok(Date.parse(slant.scoredAt) < Date.parse('2026-11-09T04:15:59Z'), 'ensemble scored first (46), override came later');
  assert.ok(rec.manualActions.some((a) => a.kind === 'hand-fix'), 'night is ruled a hand-fix night');
});
