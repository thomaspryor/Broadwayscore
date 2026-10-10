// Regression: an UNCHANGED unresolved error set must not scream URGENT every
// morning (owner got "BSC URGENT (day 6)" AND "(day 7)" on consecutive days,
// 2026-07-25). Escalation is milestone-based: new set, day 3, day 7, then weekly.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getDigestSubject, errorSetFingerprint, isEscalationDay, updateErrorFingerprint } =
  require('../../scripts/health-check.js');

const err = (name) => ({ name, status: 'error', message: 'boom' });
const results = (...names) => names.map(err);

test('day-6 repeat of the same error set gets a calm subject, not URGENT', () => {
  const set = results('T1 Coverage', 'SEO health');
  const history = { consecutiveErrorDays: 6, lastErrorFingerprint: errorSetFingerprint(set) };
  const subject = getDigestSubject(set, history, {});
  assert.ok(!subject.includes('URGENT'), `expected calm subject, got: ${subject}`);
  assert.ok(subject.includes('unchanged'), subject);
});

test('day-7 milestone of the same set escalates once', () => {
  const set = results('T1 Coverage', 'SEO health');
  const history = { consecutiveErrorDays: 7, lastErrorFingerprint: errorSetFingerprint(set) };
  assert.ok(getDigestSubject(set, history, {}).includes('URGENT'));
});

test('a NEW error joining the set re-escalates immediately even off-milestone', () => {
  const yesterday = results('T1 Coverage');
  const today = results('T1 Coverage', 'Grosses stale');
  const history = { consecutiveErrorDays: 6, lastErrorFingerprint: errorSetFingerprint(yesterday) };
  assert.ok(getDigestSubject(today, history, {}).includes('URGENT'));
});

test('an error RESOLVING changes the fingerprint so the smaller set re-alerts (ACTION/URGENT path)', () => {
  const yesterday = results('T1 Coverage', 'Grosses stale');
  const today = results('T1 Coverage');
  const history = { consecutiveErrorDays: 6, lastErrorFingerprint: errorSetFingerprint(yesterday) };
  // Set changed → not "unchanged"; subject may be URGENT (still day>=5) but must not claim unchanged.
  assert.ok(!getDigestSubject(today, history, {}).includes('unchanged'));
});

test('day-2 repeat of the same single-error set is calm; first sighting is not', () => {
  const set = results('T1 Coverage');
  const fresh = { consecutiveErrorDays: 2, lastErrorFingerprint: '' };
  assert.ok(getDigestSubject(set, fresh, {}).includes('ACTION NEEDED'));
  const repeat = { consecutiveErrorDays: 2, lastErrorFingerprint: errorSetFingerprint(set) };
  assert.ok(repeat && getDigestSubject(set, repeat, {}).includes('unchanged'));
});

test('milestones: 3, 7, 14, 21... and nothing else', () => {
  const yes = [3, 7, 14, 21, 28];
  const no = [1, 2, 4, 5, 6, 8, 9, 10, 13, 15];
  for (const d of yes) assert.equal(isEscalationDay(d), true, `day ${d}`);
  for (const d of no) assert.equal(isEscalationDay(d), false, `day ${d}`);
});

test('updateErrorFingerprint records the post-autofix actionable set; clears on all-green', () => {
  const history = {};
  updateErrorFingerprint(history, results('A', 'B'), { B: { fixed: true } });
  assert.equal(history.lastErrorFingerprint, 'A');
  updateErrorFingerprint(history, [], {});
  assert.equal(history.lastErrorFingerprint, '');
});
