import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isCandidateConfirmed } = require('../../scripts/lib/ob-cross-validation.js');

const PLAYBILL = [
  { title: 'Indian Princesses', firstPreview: '2026-04-30', opening: '2026-05-19' },
  { title: 'The Reservoir', firstPreview: '2026-02-05', opening: null },
  { title: '||: GIRLS :||: CHANCE :||: MUSIC :||', firstPreview: '2026-05-12', opening: '2026-05-28' },
];

const LORTEL = [
  { title: 'Birthright', firstPreview: '2026-06-10', openingNight: '2026-06-24' },
];

test('isCandidateConfirmed: matches via Playbill', () => {
  const r = isCandidateConfirmed(
    { title: 'Indian Princesses', venue: 'Atlantic Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL }
  );
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'playbill');
});

test('isCandidateConfirmed: matches via Lortel when Playbill misses', () => {
  const r = isCandidateConfirmed(
    { title: 'Birthright', venue: 'MCC Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL }
  );
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'lortel');
});

test('isCandidateConfirmed: rejects gala/benefit phantom that neither source has', () => {
  const r = isCandidateConfirmed(
    { title: 'Spring Gala 2026', venue: 'Atlantic Theater' },
    { playbillEntries: PLAYBILL, lortelEntries: LORTEL }
  );
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /no Playbill\/Lortel match/);
});

test('isCandidateConfirmed: normalizes punctuation (||: GIRLS :|| variants)', () => {
  // Subagent extracted "Girls Chance Music" from Vineyard; Playbill stores
  // the full "||: GIRLS :||: CHANCE :||: MUSIC :||" — normalizeTitle should
  // collapse both to the same token bag.
  const r = isCandidateConfirmed(
    { title: 'Girls Chance Music', venue: 'Vineyard Theatre' },
    { playbillEntries: PLAYBILL, lortelEntries: [] }
  );
  assert.equal(r.confirmed, true, `expected confirmed; got: ${JSON.stringify(r)}`);
});

test('isCandidateConfirmed: empty sources returns not-confirmed', () => {
  const r = isCandidateConfirmed(
    { title: 'X' },
    { playbillEntries: [], lortelEntries: [] }
  );
  assert.equal(r.confirmed, false);
});

test('isCandidateConfirmed: missing title returns not-confirmed', () => {
  const r = isCandidateConfirmed({}, { playbillEntries: PLAYBILL });
  assert.equal(r.confirmed, false);
  assert.match(r.reason, /missing title/);
});
