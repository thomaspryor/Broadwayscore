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

// (d) a card whose notes reference a parent card id refuses and names the
// parent — ONLY when that parent is confirmed live (task #1698) in the
// supplied task-mirror fixture.
test('sessionTrackingCloneGuard refuses a self-declared "session tracking card for task #N" clone and names the parent', () => {
  const task = {
    id: '1671',
    subject: 'Session: fix validateRoundupPageTitle cross-market sibling blindness (#1652)',
    description: '## Problem Session tracking card for work on pre-existing card #1652: validateRoundupPageTitle ...',
  };
  const tasks = [task, { id: '1652', subject: 'validateRoundupPageTitle cross-market sibling blindness', status: 'in_progress' }];
  const err = sessionTrackingCloneGuard(task, tasks, {});
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
  const tasks = [task, { id: '1557', subject: 'pre-merge-review-gate.sh false-positives', status: 'in_progress' }];
  assert.equal(sessionTrackingCloneGuard(task, tasks, { force: true }), null);
});

test('sessionTrackingCloneGuard: no clone phrase present — allow (plain backlog card)', () => {
  const task = {
    id: '99',
    subject: 'Fix outlet registry gap for The Stage',
    description: 'The Stage outlet is missing from outlet-registry.json for 3 shows.',
  };
  assert.equal(sessionTrackingCloneGuard(task, [], {}), null);
});

test('sessionTrackingCloneGuard: clone phrase present but no extractable parent id fails open (no refusal)', () => {
  const task = {
    id: '100',
    subject: 'Document the session-tracking-card dispatch pathology',
    description: 'This card is about how a session tracking card can be mistaken for backlog work.',
  };
  assert.equal(sessionTrackingCloneGuard(task, [], {}), null);
});

// Task #1698 regression cases ------------------------------------------------

// #1615-shaped: cites a "parent card" that already shipped months ago — a
// citation of finished work, not a clone declaration. Not present as
// pending/in_progress in the mirror at all.
test('sessionTrackingCloneGuard: #1615-shaped card citing a long-shipped parent card is NOT refused', () => {
  const task = {
    id: '1615',
    subject: 'WE long-runner CV hardening (follow-up to wrongProduction clear)',
    description: 'Five systemic issues discovered while clearing wrongProduction FPs on WE long-runners ' +
      '(parent card 336637c5-416f-81e2-b37d-e5330882edd0, shipped 2026-04-24).',
  };
  const tasks = [task, { id: '1600', subject: 'unrelated', description: '[notion:336637c5-416f-81e2-b37d-e5330882edd0]', status: 'completed' }];
  assert.equal(sessionTrackingCloneGuard(task, tasks, {}), null);
});

// #1674-shaped: "per card #1657" cites already-merged work; #1657 is
// 'completed' in the mirror, so the guard must not treat it as a live clone
// parent.
test('sessionTrackingCloneGuard: #1674-shaped card citing an already-merged card is NOT refused', () => {
  const task = {
    id: '1674',
    subject: 'P1: time-bomb audit found stale-sentinel test fails at +30d in validate-data',
    description: 'Fix now covers all 3 CI manifests per card #1657, commit f4e34826e9a.',
  };
  const tasks = [task, { id: '1657', subject: 'CI manifest coverage', status: 'completed' }];
  assert.equal(sessionTrackingCloneGuard(task, tasks, {}), null);
});

// #1670-shaped: the actual motivating clone — "per card <uuid> (task #1662)"
// with no `#digit` immediately after "card" (the old regex branch missed
// this). #1662 is in_progress (live) in the mirror, so this MUST refuse.
test('sessionTrackingCloneGuard: #1670-shaped clone ("per card <uuid> (task #N)") with a live parent IS refused', () => {
  const task = {
    id: '1670',
    subject: 'CI guard: fail if a test writes to a real tracked data/*.json path outside tmp',
    description: 'Implementing scripts/lib/test-data-write-guard.js per card 3be637c5416f812f802ac82f43e9789c (task #1662).',
  };
  const tasks = [task, { id: '1662', subject: 'CI guard: fail if a test writes to a real tracked data/*.json path outside tmp', status: 'in_progress' }];
  const err = sessionTrackingCloneGuard(task, tasks, {});
  assert.notEqual(err, null);
  assert.match(err, /REFUSING to dispatch #1670/);
  assert.match(err, /task #1662/);
});

// #1680-shaped: self-declaration phrase ("continuing card #N") sits in the
// TITLE, before the "session-tracking card" phrase in the description — the
// leftmost regex match must land in the title for the forward-only window
// search to find the parent ref that follows it there. Parent is
// in_progress (live), so this MUST refuse.
test('sessionTrackingCloneGuard: #1680-shaped title-only self-declaration ("continuing card #N") with a live parent IS refused', () => {
  const task = {
    id: '1680',
    subject: 'Session: baseline-diff cv-flag-contradiction.js (continuing card #1657)',
    description: 'this session-tracking card exists to satisfy the per-session Notion gate.',
  };
  const tasks = [task, { id: '1657', subject: 'baseline-diff cv-flag-contradiction.js', status: 'in_progress' }];
  const err = sessionTrackingCloneGuard(task, tasks, {});
  assert.notEqual(err, null);
  assert.match(err, /REFUSING to dispatch #1680/);
  assert.match(err, /task #1657/);
});

// Self-reference: a card that happens to restate its own numeric id near the
// clone phrase must never refuse against itself (the task being evaluated is
// by definition live/dispatchable, so a naive match would always look like a
// "live parent").
test('sessionTrackingCloneGuard: a self-referential parent id is not treated as a live parent', () => {
  const task = {
    id: '1700',
    subject: 'Session tracking card for task #1700',
    description: 'This session-tracking card exists to track its own dispatch.',
    status: 'in_progress',
  };
  assert.equal(sessionTrackingCloneGuard(task, [task], {}), null);
});
