import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyCandidate,
  summarizeShow,
  summarizeRun,
  evaluateAcceptance,
} = require('./coverage-adversarial-probe.js');

const SHOW = { id: 'the-car-man-west-end-2026', title: 'The Car Man' };

function guardsFor({ includable, exclusionReason }) {
  return {
    isIncludableForRebuild: () => includable,
    explainExclusion: () => exclusionReason,
  };
}

test('classifyCandidate: URL not on disk at all is a gap', () => {
  const onDisk = new Map();
  const r = classifyCandidate('https://example.com/review', SHOW, onDisk, guardsFor({ includable: false }));
  assert.equal(r.state, 'gap');
  assert.equal(r.reason, null);
});

test('classifyCandidate: on-disk + includable is live', () => {
  const onDisk = new Map([['https://example.com/review', { data: {}, filePath: '/x.json' }]]);
  const r = classifyCandidate('https://example.com/review', SHOW, onDisk, guardsFor({ includable: true }));
  assert.equal(r.state, 'live');
});

test('classifyCandidate: on-disk + guard-excluded is named, not silently dropped', () => {
  const onDisk = new Map([['https://example.com/review', { data: { wrongProduction: true }, filePath: '/x.json' }]]);
  const r = classifyCandidate('https://example.com/review', SHOW, onDisk, guardsFor({ includable: false, exclusionReason: 'wrongProduction' }));
  assert.equal(r.state, 'excluded');
  assert.equal(r.reason, 'wrongProduction');
});

test('classifyCandidate: explainExclusion returning null on a non-includable file still names it', () => {
  // Defensive: explainExclusion is the single source of truth, but a caller
  // must never crash or silently swallow a review that's excluded for a
  // reason the predicate itself can't name.
  const onDisk = new Map([['https://example.com/review', { data: {}, filePath: '/x.json' }]]);
  const r = classifyCandidate('https://example.com/review', SHOW, onDisk, guardsFor({ includable: false, exclusionReason: null }));
  assert.equal(r.state, 'excluded');
  assert.equal(r.reason, 'unknown');
});

test('summarizeShow: passes with zero candidates', () => {
  const s = summarizeShow([]);
  assert.equal(s.pass, true);
});

test('summarizeShow: fails when any candidate is a gap', () => {
  const s = summarizeShow([
    { url: 'a', state: 'live' },
    { url: 'b', state: 'gap' },
    { url: 'c', state: 'excluded' },
  ]);
  assert.equal(s.pass, false);
  assert.equal(s.gaps.length, 1);
  assert.equal(s.live, 1);
  assert.equal(s.excluded, 1);
});

test('summarizeRun: no measured shows is inconclusive, never clean', () => {
  const r = summarizeRun([
    { showId: 'a', sampleState: 'settling', candidates: [] },
    { showId: 'b', sampleState: 'unknown-date', candidates: [] },
  ]);
  assert.equal(r.verdict, 'inconclusive');
  assert.equal(r.measured, 0);
});

test('summarizeRun: clean when every measured show passes', () => {
  const r = summarizeRun([
    { showId: 'a', sampleState: 'measured', candidates: [{ state: 'live' }] },
    { showId: 'b', sampleState: 'measured', candidates: [{ state: 'excluded' }] },
  ]);
  assert.equal(r.verdict, 'clean');
  assert.equal(r.measured, 2);
});

test('summarizeRun: gaps-found when at least one measured show has a real gap', () => {
  const r = summarizeRun([
    { showId: 'a', sampleState: 'measured', candidates: [{ state: 'live' }] },
    { showId: 'b', sampleState: 'measured', candidates: [{ state: 'gap' }] },
  ]);
  assert.equal(r.verdict, 'gaps-found');
  assert.deepEqual(r.gapShows, ['b']);
  assert.equal(r.gapCount, 1);
});

test('evaluateAcceptance: fewer than 2 measurable runs is not accepted', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-20', verdict: 'clean' },
  ]);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /only 1 measurable/);
});

test('evaluateAcceptance: an inconclusive (outage) run does not count as evidence either way', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-06', generatedAt: '2026-07-06T00:00:00Z', verdict: 'clean' },
    { date: '2026-07-13', generatedAt: '2026-07-13T00:00:00Z', verdict: 'inconclusive' },
    { date: '2026-07-20', generatedAt: '2026-07-20T00:00:00Z', verdict: 'clean' },
  ]);
  // The two measurable entries (07-06, 07-20) are 14 days apart and both
  // clean — accepted, with the outage week correctly skipped rather than
  // resetting or completing the streak on its own.
  assert.equal(r.accepted, true);
});

test('evaluateAcceptance: a gaps-found run resets the streak', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-06', generatedAt: '2026-07-06T00:00:00Z', verdict: 'clean' },
    { date: '2026-07-13', generatedAt: '2026-07-13T00:00:00Z', verdict: 'gaps-found', gapCount: 2, gapShows: ['x'] },
    { date: '2026-07-20', generatedAt: '2026-07-20T00:00:00Z', verdict: 'clean' },
  ]);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /2026-07-13/);
});

test('evaluateAcceptance: two clean runs too close together (same-day re-trigger) is not accepted', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-20', generatedAt: '2026-07-20T00:00:00Z', verdict: 'clean' },
    { date: '2026-07-20', generatedAt: '2026-07-20T04:00:00Z', verdict: 'clean' },
  ]);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /not two distinct weekly cadences/);
});

test('evaluateAcceptance: two consecutive clean weeks, properly spaced, is accepted', () => {
  const r = evaluateAcceptance([
    { date: '2026-07-13', generatedAt: '2026-07-13T00:00:00Z', verdict: 'clean' },
    { date: '2026-07-20', generatedAt: '2026-07-20T00:00:00Z', verdict: 'clean' },
  ]);
  assert.equal(r.accepted, true);
  assert.match(r.reason, /2 consecutive clean weekly run/);
});
