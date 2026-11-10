// LIVE-DATA-LANE: reads data/shows.json (read by the test); data/audit/stale-announced-shows-ack.json (bot ledger); data/review-texts/let-the-good-times-roll-2026 (untracked core data); +165 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateAnnouncedShow,
  isAcked,
  addAck,
  findOrphanAcks,
} = require('./lib/stale-announced-audit.js');

// Fixed clock so results don't drift: "today" is 2026-08-20.
const NOW = new Date('2026-08-20T12:00:00');
const STALE_DAYS = 30;

test('non-announced show → never flagged', () => {
  const show = { id: 'x', status: 'previews', previewsStartDate: '2020-01-01' };
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: false, acks: [] });
  assert.deepEqual(reasons, []);
});

test('announced, no previewsStartDate, no reviews → not flagged', () => {
  const show = { id: 'x', status: 'announced', previewsStartDate: null };
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: false, acks: [] });
  assert.deepEqual(reasons, []);
});

test('announced, previewsStartDate within stale window → not flagged', () => {
  const show = { id: 'x', status: 'announced', previewsStartDate: '2026-08-01' };
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: false, acks: [] });
  assert.deepEqual(reasons, []);
});

test('announced, previewsStartDate 30+ days in the past → flagged', () => {
  const show = { id: 'x', status: 'announced', previewsStartDate: '2026-06-01' };
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: false, acks: [] });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /previewsStartDate 2026-06-01 is \d+d in the past/);
});

test('announced with collected review-texts → flagged even with no previewsStartDate', () => {
  const show = { id: 'x', status: 'announced', previewsStartDate: null };
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: true, acks: [] });
  assert.deepEqual(reasons, ['data/review-texts/ has collected review file(s)']);
});

test('announced, openingDate 30+ days in the past, no previewsStartDate → flagged (straight-to-open transfer class)', () => {
  const show = { id: 'x', status: 'announced', previewsStartDate: null, openingDate: '2026-06-01' };
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: false, acks: [] });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /openingDate 2026-06-01 is \d+d in the past/);
});

test('announced, openingDate within stale window → not flagged', () => {
  const show = { id: 'x', status: 'announced', openingDate: '2026-08-01' };
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: false, acks: [] });
  assert.deepEqual(reasons, []);
});

test('announced, all three signals fire → three reasons reported', () => {
  const show = { id: 'x', status: 'announced', previewsStartDate: '2026-06-01', openingDate: '2026-06-15' };
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: true, acks: [] });
  assert.equal(reasons.length, 3);
});

test('acked show is never flagged, even when stale signals fire', () => {
  const show = { id: 'sherlock-holmes-west-end-2026', status: 'announced', previewsStartDate: '2020-01-01' };
  const acks = [{ id: 'sherlock-holmes-west-end-2026', ackedAt: NOW.toISOString(), note: 'triaged' }];
  const reasons = evaluateAnnouncedShow(show, { now: NOW, staleDays: STALE_DAYS, hasReviews: true, acks });
  assert.deepEqual(reasons, []);
});

test('ack only silences the matching show id, not others', () => {
  const acks = [{ id: 'show-a', ackedAt: NOW.toISOString(), note: 'triaged' }];
  const showB = { id: 'show-b', status: 'announced', previewsStartDate: '2026-06-01' };
  const reasons = evaluateAnnouncedShow(showB, { now: NOW, staleDays: STALE_DAYS, hasReviews: false, acks });
  assert.equal(reasons.length, 1);
});

test('isAcked matches by id', () => {
  const acks = [{ id: 'a', ackedAt: 'x', note: 'n' }];
  assert.equal(isAcked('a', acks), true);
  assert.equal(isAcked('b', acks), false);
});

test('addAck appends and re-acking the same id refreshes (no duplicates)', () => {
  let acks = addAck([], 'a', 'first note', '2026-01-01T00:00:00.000Z');
  assert.equal(acks.length, 1);
  acks = addAck(acks, 'a', 'updated note', '2026-01-02T00:00:00.000Z');
  assert.equal(acks.length, 1);
  assert.equal(acks[0].note, 'updated note');
});

// Regression guard for BRO-93: the current data/shows.json + data/audit ack
// file must produce zero flagged 'announced' shows. This is what makes
// `node --test scripts/audit-stale-announced-shows.test.mjs` the acceptance
// check for "the audit script no longer reports any stale 'announced' shows".
test('BRO-93 acceptance: current shows.json produces zero stale announced flags', () => {
  const fs = require('fs');
  const path = require('path');
  const { fileURLToPath } = require('url');
  const { loadAcks, hasEvidenceOfOpening } = require('./lib/stale-announced-audit.js');
  const { explainExclusion } = require('./lib/review-guards.js');

  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(dirname, '..');
  const showsPath = path.join(root, 'data', 'shows.json');
  const reviewTextsDir = path.join(root, 'data', 'review-texts');

  let showsData;
  try {
    showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  } catch {
    // No local data checkout (e.g. a bare CI shard without data/) — nothing to check.
    return;
  }

  // Deliberately NOT a local copy of the review-texts rule. An inline
  // `readdirSync(dir).some(f => f.endsWith('.json'))` here is what made this
  // acceptance test assert the OLD behaviour while the production script had
  // already been fixed — the test stayed red and pointed at data that was not
  // the problem. Call the real predicate so a production change reaches this
  // assertion (CLAUDE.md §15).

  const acks = loadAcks();
  const now = new Date();
  const flagged = [];
  for (const show of showsData.shows || []) {
    if (show.status !== 'announced') continue;
    const reasons = evaluateAnnouncedShow(show, {
      now,
      staleDays: 30,
      hasReviews: hasEvidenceOfOpening(reviewTextsDir, show.id, explainExclusion, show),
      acks,
    });
    if (reasons.length > 0) flagged.push({ id: show.id, reasons });
  }

  assert.deepEqual(flagged, [], `expected zero stale announced shows, got: ${JSON.stringify(flagged, null, 2)}`);
});

// BRO-5263: a stale ack (retired/closed/missing show) hid a 2-year-old announced
// row behind an inaccurate note. Orphan acks must be detectable.
test('findOrphanAcks: flags acks whose show is missing or no longer announced', () => {
  const shows = [
    { id: 'live', status: 'announced' },
    { id: 'opened', status: 'open' },
    { id: 'shut', status: 'closed' },
  ];
  const acks = [{ id: 'live' }, { id: 'opened' }, { id: 'shut' }, { id: 'retired-gone' }];
  assert.deepEqual(findOrphanAcks(shows, acks).map(a => a.id), ['opened', 'shut', 'retired-gone']);
  assert.deepEqual(findOrphanAcks(shows, []), []);
  assert.deepEqual(findOrphanAcks(shows, null), []);
});

// BRO-7080: girls-chance-music-off-broadway-2024 sat in 'upcoming' with no
// dates and 5 clean review files; the audit only looked at 'announced'.
test('upcoming/previews with no openingDate and collected reviews are flagged (BRO-7080)', () => {
  const opts = { now: NOW, staleDays: STALE_DAYS, hasReviews: true, acks: [] };
  const gcm = { id: 'girls-chance-music-off-broadway-2024', status: 'upcoming', previewsStartDate: null, openingDate: null };
  assert.equal(evaluateAnnouncedShow(gcm, opts).length, 1);
  assert.equal(evaluateAnnouncedShow({ ...gcm, status: 'previews' }, opts).length, 1);
  // A dated show is the status flip's job; no reviews is just a future show.
  assert.deepEqual(evaluateAnnouncedShow({ ...gcm, openingDate: '2026-06-01' }, opts), []);
  assert.deepEqual(evaluateAnnouncedShow(gcm, { ...opts, hasReviews: false }), []);
  // A returning production's earlier-run reviews are not evidence this run opened.
  assert.deepEqual(evaluateAnnouncedShow({ ...gcm, priorRuns: [{ venue: 'x' }] }, opts), []);
  // Acks still silence it; open shows are never audited.
  assert.deepEqual(evaluateAnnouncedShow(gcm, { ...opts, acks: [{ id: gcm.id }] }), []);
  assert.deepEqual(evaluateAnnouncedShow({ ...gcm, status: 'open' }, opts), []);
  // An ack on an upcoming show is not an orphan.
  assert.deepEqual(findOrphanAcks([gcm], [{ id: gcm.id }]), []);
});

test('evidenceSinceFor: upcoming/previews count only in-run reviews; announced keeps undated rule (BRO-7080)', async () => {
  const { evidenceSinceFor, describeOpeningEvidence } = require('./lib/stale-announced-audit.js');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  assert.equal(evidenceSinceFor({ status: 'announced' }, NOW), null);
  assert.equal(evidenceSinceFor({ status: 'previews', previewsStartDate: '2026-11-04' }, NOW), '2026-11-04');
  assert.equal(evidenceSinceFor({ status: 'upcoming' }, NOW), '2025-08-20');
  // Replay: jackals-off-broadway-2026 held 2014/2017 Woyzeck reviews; an
  // undated file is not in-run either. Only a 2026 review counts.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7080-'));
  fs.mkdirSync(path.join(dir, 'jackals'));
  const w = (n, d) => fs.writeFileSync(path.join(dir, 'jackals', n), JSON.stringify(d));
  w('a.json', { publishDate: '2017-05-24', url: 'https://www.theguardian.com/stage/2017/may/24/woyzeck-review' });
  w('b.json', { url: 'https://www.standard.co.uk/woyzeck-review' });
  const explain = () => null;
  const show = { id: 'jackals', status: 'upcoming' };
  assert.equal(describeOpeningEvidence(dir, 'jackals', explain, show, { since: evidenceSinceFor(show, NOW) }).hasEvidence, false);
  assert.equal(describeOpeningEvidence(dir, 'jackals', explain, show).hasEvidence, true);
  w('c.json', { publishDate: '2026-05-28', url: 'https://nystagereview.com/2026/05/28/jackals' });
  assert.equal(describeOpeningEvidence(dir, 'jackals', explain, show, { since: evidenceSinceFor(show, NOW) }).hasEvidence, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
