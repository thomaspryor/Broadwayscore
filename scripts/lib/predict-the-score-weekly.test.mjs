// BRO-7463. Requires the real module. Run: node --test scripts/lib/predict-the-score-weekly.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildReport, renderEmail, easternHour, titleFor } = require('./predict-the-score-weekly.js');

const NOW = new Date('2026-11-20T17:45:00Z');
const d = (daysAgo) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();
const calls = [
  { user_id: 'u-owner', show_id: 'show-a', called_score: 99, locked_at: d(1) },
  { user_id: 'u1', show_id: 'show-a', called_score: 70, locked_at: d(20) },
  { user_id: 'u1', show_id: 'show-b', called_score: 60, locked_at: d(2) },   // old person, new prediction
  { user_id: 'u2', show_id: 'show-a', called_score: 80, locked_at: d(3) },   // new person
  { user_id: 'u2', show_id: 'show-b', called_score: 55, locked_at: d(1) },
  { user_id: 'u3', show_id: 'show-a', called_score: 71, locked_at: d(8) },   // just outside the week
];

test('counts people and predictions, excluding the owner', () => {
  const r = buildReport(calls, { ownerUserIds: ['u-owner'], now: NOW, titles: { 'show-a': 'Show A' } });
  assert.equal(r.people, 3);
  assert.equal(r.predictions, 5);
  assert.equal(r.ownerPredictions, 1);
  assert.equal(r.newPeople, 1);        // u2 only; u1 first predicted 20 days ago
  assert.equal(r.newPredictions, 3);   // u1 show-b, u2 x2
  assert.deepEqual(r.perShow.map((s) => [s.title, s.count, s.average]), [['Show A', 3, 73.7], ['Show B', 2, 57.5]]);
});

test('without an owner id the owner counts as a person', () => {
  assert.equal(buildReport(calls, { now: NOW }).people, 4);
});

test('output never carries a user id', () => {
  const r = buildReport(calls, { ownerUserIds: ['u-owner'], now: NOW });
  const { subject, text } = renderEmail(r);
  const blob = JSON.stringify(r) + subject + text;
  for (const id of ['u-owner', 'u1', 'u2', 'u3']) assert.ok(!blob.includes(id), `leaked ${id}`);
});

test('email wording', () => {
  const r = buildReport(calls, { ownerUserIds: ['u-owner'], now: NOW, titles: { 'show-a': 'Show A' } });
  const { subject, text } = renderEmail(r);
  assert.equal(subject, 'Predict the Score: 3 people so far (+1 this week)');
  const lines = text.split('\n');
  assert.match(lines[0], /^3 people have made a prediction .* 1 of them started this week\.$/);
  assert.equal(lines.at(-1), 'https://broadwayscorecard.com/admin/forecasts');
  assert.ok(lines.includes('Claude'));
  assert.ok(text.includes('Show A: 3, 73.7'));
  assert.ok(text.includes('leave out your own account (1 prediction from you)'));
  assert.ok(!/—|–/.test(text + subject), 'no em or en dashes');
});

test('empty and singular cases', () => {
  const none = renderEmail(buildReport([], { now: NOW }));
  assert.equal(none.subject, 'Predict the Score: no one has predicted yet');
  assert.ok(!none.text.includes('By show'));
  const one = renderEmail(buildReport([calls[3]], { now: NOW }));
  assert.equal(one.subject, 'Predict the Score: 1 person so far (+1 this week)');
  assert.match(one.text, /^1 person has made/);
});

test('title fallback and Eastern hour', () => {
  assert.equal(titleFor('the-lost-boys-2026', {}), 'The Lost Boys 2026');
  assert.equal(easternHour(new Date('2026-11-20T17:45:00Z')), 12); // EST
  assert.equal(easternHour(new Date('2026-07-17T16:45:00Z')), 12); // EDT
  assert.equal(easternHour(new Date('2026-07-17T17:45:00Z')), 13);
});

test('weekday and owner-not-found wording', async () => {
  const { easternWeekday } = require('./predict-the-score-weekly.js');
  assert.equal(easternWeekday(new Date('2026-11-20T17:45:00Z')), 'Fri');
  const r = buildReport(calls, { now: NOW });
  r.ownerFound = false;
  assert.match(renderEmail(r).text, /Your own account was not found/);
});
