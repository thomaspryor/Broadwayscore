import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDailyReport,
  decideDayMissing,
  decideDayViolation,
} from './lib/scheduled-email-count-rules.js';
import { buildSubject } from './lib/reddit-post-email.js';

// BRO-4483's acceptance command names this file. The owner's October 11
// correction allows separate Reddit drafts; BRO-4956 fixed the monitor.
// Exercise the real subject builder and monitor without sending any email.
const OWNER = 'owner@example.test';
const DAY = '2026-09-30';
const DRAFTS = [
  { showTitle: 'How Shakespeare Saved My Life', score: 69, subreddit: 'offbroadwayNYC' },
  { showTitle: 'The Standard Of Living', score: 70, subreddit: 'TheWestEnd' },
  { showTitle: 'Delirium', score: 87, subreddit: 'Broadway' },
];
const DAILY_SUBJECTS = [
  'Morning digest \u2014 Wed, Sep 30 · 41 decisions for you',
  '1 broadcast-ready · 1 opening today · Sep 30',
];
const REDDIT_SUBJECTS = DRAFTS.map(draft => buildSubject(draft, 'new'));

function email(subject, created_at = '2026-09-30T12:00:00Z') {
  return { to: [OWNER], subject, created_at };
}

function incidentBucket(extra = []) {
  return buildDailyReport([
    ...DAILY_SUBJECTS.map(subject => email(subject)),
    ...REDDIT_SUBJECTS.map(subject => email(subject)),
    ...extra,
  ], OWNER).get(DAY);
}

test('BRO-4483: September 30 has two daily digests and three legitimate Reddit drafts', () => {
  const bucket = incidentBucket();
  const decision = decideDayViolation(bucket, DAY);
  assert.deepEqual(bucket.senders.get('reddit-post-ready').subjects, [
    'Reddit post ready: How Shakespeare Saved My Life (69/100) for r/offbroadwayNYC',
    'Reddit post ready: The Standard Of Living (70/100) for r/TheWestEnd',
    'Reddit post ready: Delirium (87/100) for r/Broadway',
  ]);
  assert.equal(bucket.other.length, 0);
  assert.equal(decision.senderCount, 3);
  assert.equal(decision.violation, false);
  assert.deepEqual(decision.duplicateKeys, []);
  assert.deepEqual(decision.unexpectedKeys, []);
  assert.deepEqual(decideDayMissing(bucket, DAY).missingExpected, []);
});

for (const subject of REDDIT_SUBJECTS) {
  test(`BRO-4483: a repeated draft still raises a violation: ${subject}`, () => {
    const decision = decideDayViolation(incidentBucket([email(subject)]), DAY);
    assert.equal(decision.violation, true);
    assert.deepEqual(decision.duplicateKeys, ['reddit-post-ready']);
  });
}

for (const [key, subject] of [
  ['morning-digest', 'Morning digest \u2014 Wed, Sep 30 · updated decisions'],
  ['opening-digest', '2 broadcast-ready · Sep 30'],
]) {
  test(`BRO-4483: ${key} still has a daily limit even when its subject changes`, () => {
    const decision = decideDayViolation(incidentBucket([email(subject)]), DAY);
    assert.equal(decision.violation, true);
    assert.deepEqual(decision.duplicateKeys, [key]);
  });
}

test('BRO-4483: crossing UTC midnight does not reset the ET duplicate check', () => {
  const bucket = incidentBucket([email(REDDIT_SUBJECTS[0], '2026-10-01T03:59:59Z')]);
  assert.deepEqual(decideDayViolation(bucket, DAY).duplicateKeys, ['reddit-post-ready']);
});

test('BRO-4483: an identical subject on the next ET day is not a same-day duplicate', () => {
  const days = buildDailyReport([
    email(REDDIT_SUBJECTS[0], '2026-10-01T03:59:59Z'),
    email(REDDIT_SUBJECTS[0], '2026-10-01T04:00:00Z'),
  ], OWNER);
  assert.deepEqual([...days.keys()], [DAY, '2026-10-01']);
  for (const [day, bucket] of days) {
    assert.equal(decideDayViolation(bucket, day).violation, false);
  }
});

test('BRO-4483: a day without Reddit drafts still satisfies the daily sender policy', () => {
  const bucket = buildDailyReport(DAILY_SUBJECTS.map(subject => email(subject)), OWNER).get(DAY);
  assert.equal(decideDayViolation(bucket, DAY).violation, false);
  assert.deepEqual(decideDayMissing(bucket, DAY).missingExpected, []);
});
