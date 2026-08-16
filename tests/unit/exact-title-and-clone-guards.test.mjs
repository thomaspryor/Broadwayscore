// Task #1672: bsc-next.js warned about duplicate dispatches then dispatched
// them anyway. Requires the real dispatch-guards.js/dispatch-overlap-check.js
// functions (CLAUDE.md rule 15) — never reimplements the guard logic here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findOverlappingCards } = require('../../scripts/lib/dispatch-overlap-check.js');
const {
  exactTitleOverlapGuard,
  sessionTrackingCloneGuard,
} = require('../../scripts/lib/dispatch-guards.js');

// (a) exact normalised subject match against a live in_progress card refuses.
test('exactTitleOverlapGuard refuses an exact normalized title match (task #1662/#1670 class)', () => {
  const task = { id: '1662', subject: 'CI guard: fail if a test writes to a real tracked data/*.json path outside tmp' };
  const other = { id: '1670', subject: 'CI guard: fail if a test writes to a real tracked data/*.json path outside tmp', notes: '' };
  const overlaps = findOverlappingCards({ id: task.id, subject: task.subject, notes: '' }, [other]);
  const err = exactTitleOverlapGuard(task, overlaps, {});
  assert.notEqual(err, null);
  assert.match(err, /REFUSING to dispatch #1662/);
  assert.match(err, /#1670/);
});

// (b) --force overrides that refusal.
test('exactTitleOverlapGuard: --force overrides the exact-title refusal', () => {
  const task = { id: '1662', subject: 'CI guard: fail if a test writes to a real tracked data/*.json path outside tmp' };
  const other = { id: '1670', subject: 'CI guard: fail if a test writes to a real tracked data/*.json path outside tmp', notes: '' };
  const overlaps = findOverlappingCards({ id: task.id, subject: task.subject, notes: '' }, [other]);
  assert.equal(exactTitleOverlapGuard(task, overlaps, { force: true }), null);
  assert.equal(exactTitleOverlapGuard(task, overlaps, { 'dry-run': true }), null);
});

// (c) a merely-similar (prefix) title still only warns — no refusal, and
// findOverlappingCards itself still reports it as 'similar-title', not
// 'exact-title-match'.
test('exactTitleOverlapGuard: a prefix-only title overlap is not refused (stays warn-only via similar-title)', () => {
  const task = { id: '5', subject: 'Extract pushCookieSecretWithMeta() helper so OTP outlets inherit cookie fix' };
  const other = { id: '6', subject: 'Extract pushCookieSecretWithMeta() helper so OTP outlets inherit cookie', notes: '' };
  const overlaps = findOverlappingCards({ id: task.id, subject: task.subject, notes: '' }, [other]);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].reason, 'similar-title');
  assert.equal(exactTitleOverlapGuard(task, overlaps, {}), null);
});

test('exactTitleOverlapGuard: no overlaps at all — allow', () => {
  assert.equal(exactTitleOverlapGuard({ id: '1' }, [], {}), null);
});

// (d) a card whose notes reference a parent card id refuses and names the parent.
test('sessionTrackingCloneGuard refuses a self-declared "session tracking card for task #N" clone and names the parent', () => {
  const task = {
    id: '1671',
    subject: 'Session: fix validateRoundupPageTitle cross-market sibling blindness (#1652)',
    description: '## Problem Session tracking card for work on pre-existing card #1652: validateRoundupPageTitle ...',
  };
  const err = sessionTrackingCloneGuard(task, {});
  assert.notEqual(err, null);
  assert.match(err, /REFUSING to dispatch #1671/);
  assert.match(err, /task #1652/);
});

test('sessionTrackingCloneGuard: --force overrides the clone refusal', () => {
  const task = {
    id: '1590',
    subject: 'Session: fix heredoc merge-gate false positives',
    description: 'Session tracking card for task #1557 (pre-merge-review-gate.sh false-positives)',
  };
  assert.equal(sessionTrackingCloneGuard(task, { force: true }), null);
});

test('sessionTrackingCloneGuard: no clone phrase present — allow (plain backlog card)', () => {
  const task = {
    id: '99',
    subject: 'Fix outlet registry gap for The Stage',
    description: 'The Stage outlet is missing from outlet-registry.json for 3 shows.',
  };
  assert.equal(sessionTrackingCloneGuard(task, {}), null);
});

test('sessionTrackingCloneGuard: clone phrase present but no extractable parent id fails open (no refusal)', () => {
  const task = {
    id: '100',
    subject: 'Document the session-tracking-card dispatch pathology',
    description: 'This card is about how a session tracking card can be mistaken for backlog work.',
  };
  assert.equal(sessionTrackingCloneGuard(task, {}), null);
});
