// BRO-6083: coordinator registry (scripts/lib/coordinator-registry.js), pure functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const reg = require('../../scripts/lib/coordinator-registry.js');

const NOTE = { id: '44e3f2b8-aaaa-bbbb-cccc-000000000001', body: 'OWNER REQUIREMENT: all reviews the night a show opens', createdAt: '2026-10-23T14:21:00.000Z' };
const OLD_NOTE = { id: '5336ef03-aaaa-bbbb-cccc-000000000002', body: 'OWNER DECISION Option A', createdAt: '2026-10-23T13:18:00.000Z' };
const STATUS = { id: '5a2b0132-aaaa-bbbb-cccc-000000000003', body: 'SYNC from a worker, standing down', createdAt: '2026-10-23T21:34:00.000Z' };
const notes = (comments) => new Map([['BRO-5955', { ok: true, url: 'https://linear.app/x/BRO-5955', comments }]]);
const LANE = 'scripts/lib/opening-night-lane/cutover.js';

test('registry maps opening-night paths to BRO-5955 and leaves others alone', () => {
  for (const f of [LANE, 'scripts/opening-night-poller.js', 'scripts/collect-review-texts.js', '.github/workflows/opening-night-lane.yml', 'scripts/lib/press-night-record.js',
    'scripts/lib/opening-night-checks/review-coverage.js', 'scripts/check-opening-night-readiness.js', 'scripts/opening-night-prompts/phase1.md',
    'scripts/collect-review-texts-v2.js', '.github/workflows/collect-review-texts.yml', '.github/workflows/lane-rehearsal.yml', 'scripts/outlet-listing-poller.js']) {
    assert.equal(reg.areasForFiles([f])[0]?.entry.card, 'BRO-5955', f);
  }
  assert.deepEqual(reg.areasForFiles(['src/app/page.tsx', 'scripts/land.js', 'scripts/lib/land-preflight.mjs', '.github/workflows/land.yml']), []);
});

test('card text reminder matches opening-night wording, not unrelated cards', () => {
  assert.equal(reg.areasForText('Fix the opening night poller retry').length, 1);
  assert.equal(reg.areasForText('Homepage hero spacing').length, 0);
});

test('no ack on a lane land warns, and the message names the card and its latest note', () => {
  const v = reg.judgeLand({ files: [LANE], commitText: 'fix lane', branch: 'land/x', notesByCard: notes([OLD_NOTE, NOTE, STATUS]) });
  assert.equal(v.status, 'warn');
  assert.equal(v.findings[0].status, 'missing-ack');
  const msg = reg.formatLandMessage(v);
  assert.match(msg, /BRO-5955/);
  assert.match(msg, /OWNER REQUIREMENT: all reviews the night a show opens/);
  assert.match(msg, /SYNC from a worker/);
  assert.match(msg, /COORDINATOR-ACK: BRO-5955@44e3f2b8/);
});

test('an ack of the latest coordinator note passes; worker status comments do not make it stale', () => {
  const v = reg.judgeLand({ files: [LANE], commitText: 'fix\n\nCOORDINATOR-ACK: BRO-5955@44e3f2b8\n', notesByCard: notes([NOTE, STATUS]) });
  assert.equal(v.status, 'ok');
  assert.equal(reg.formatLandMessage(v), '');
});

test('an ack of an older note is stale once the coordinator posts again', () => {
  const v = reg.judgeLand({ files: [LANE], commitText: 'COORDINATOR-ACK: BRO-5955@5336ef03', notesByCard: notes([OLD_NOTE, NOTE]) });
  assert.equal(v.findings[0].status, 'stale-ack');
  assert.match(reg.formatLandMessage(v), /older note/);
});

test('short or wrong-card acks do not count', () => {
  assert.equal(reg.judgeLand({ files: [LANE], commitText: 'COORDINATOR-ACK: BRO-5955@44e3', notesByCard: notes([NOTE]) }).status, 'warn');
  assert.equal(reg.judgeLand({ files: [LANE], commitText: 'COORDINATOR-ACK: BRO-1@44e3f2b8', notesByCard: notes([NOTE]) }).status, 'warn');
});

test('bypass, the coordinator card\'s own land and untouched areas pass', () => {
  assert.equal(reg.judgeLand({ files: [LANE], commitText: 'COORDINATOR-ACK-BYPASS: owner said land the hotfix now', notesByCard: notes([NOTE]) }).status, 'ok');
  assert.equal(reg.judgeLand({ files: [LANE], commitText: '', branch: 'land/bro-5955-cutover', notesByCard: notes([NOTE]) }).status, 'ok');
  assert.equal(reg.judgeLand({ files: [LANE], commitText: '', branch: 'land/bro-59551-x', notesByCard: notes([NOTE]) }).status, 'warn');
  assert.equal(reg.judgeLand({ files: ['src/x.ts'], commitText: '' }).status, 'skip');
});

test('an unreadable card is unknown, never ok, and the message says so', () => {
  const v = reg.judgeLand({ files: [LANE], commitText: '', notesByCard: new Map([['BRO-5955', { ok: false, error: 'HTTP 503' }]]) });
  assert.equal(v.status, 'unknown');
  assert.match(reg.formatLandMessage(v), /could not be read \(HTTP 503\)/);
});

test('a card with no coordinator note yet still warns without an ack', () => {
  const v = reg.judgeLand({ files: [LANE], commitText: '', notesByCard: notes([STATUS]) });
  assert.equal(v.status, 'warn');
  assert.match(reg.formatLandMessage(v), /No coordinator note on the card yet/);
});

test('a note starting COORDINATION (the 2026-10-23 incident wording) counts as a coordinator note', () => {
  const coord = { id: '8d29271b-aaaa-bbbb-cccc-000000000004', body: 'COORDINATION (2026-10-23, session X): do not start a parallel fix', createdAt: '2026-10-23T14:18:00.000Z' };
  assert.equal(reg.latestNote([OLD_NOTE, coord, STATUS]).id, coord.id);
  const v = reg.judgeLand({ files: [LANE], commitText: `x\n\n${reg.ackLine('BRO-5955', OLD_NOTE)}`, notesByCard: notes([OLD_NOTE, coord]) });
  assert.equal(v.findings[0].status, 'stale-ack');
});

test('card id in text matches on a word boundary only', () => {
  assert.equal(reg.areasForText('Follow-up to BRO-5955.').length, 1);
  assert.equal(reg.areasForText('see BRO-59551').length, 0);
  assert.equal(reg.areasForText('XBRO-5955').length, 0);
});

test('a marker behind markdown emphasis or a heading still counts', () => {
  for (const body of ['**COORDINATION** (2026-10-23): hold', '## COORDINATOR-NOTE: hold', '> OWNER DECISION: A']) {
    assert.ok(reg.isCoordinatorNote({ body }), body);
  }
  assert.ok(!reg.isCoordinatorNote({ body: 'SYNC: standing down, see COORDINATION above' }));
});

test('opening-night reminder carries the one-session-owns-press-night owner rule (BRO-6585)', () => {
  const entry = reg.REGISTRY.find((e) => e.area === 'opening-night');
  const text = reg.formatReminder(entry, { ok: true, comments: [], url: 'https://linear.app/x' });
  assert.match(text, /coordinator session owns press night/);
  assert.match(text, /lands nothing for that show overnight/);
});
