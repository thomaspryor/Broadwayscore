import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterAutoFlagged,
  filterStaleAbsences,
  filterPastEvents,
  filterStaleAddedDates,
  dedupeByPersonShow,
  reconcileClosure,
  detectContradictions,
  detectCrossShowConflicts,
  applyPublicFilters,
  normalizeIdentifier,
} from '../../scripts/lib/cast-changes-filters.js';

const TODAY = new Date('2026-05-23');

test('filterAutoFlagged removes [AUTO-FLAGGED] entries', () => {
  const events = [
    { type: 'arrival', name: 'A', role: 'X', note: '[AUTO-FLAGGED] verify' },
    { type: 'arrival', name: 'B', role: 'Y', note: 'Verified' },
  ];
  const out = filterAutoFlagged(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'B');
});

test('filterStaleAbsences drops absences whose endDate is in the past', () => {
  const events = [
    { type: 'absence', name: 'Alison', role: 'Anne', date: '2025-11-24', endDate: '2026-02-22' },
    { type: 'absence', name: 'Meg', role: 'Mary', date: '2026-05-01', endDate: '2026-09-12' },
    { type: 'absence', name: 'OpenEnded', role: 'X', date: '2026-05-10' },
  ];
  const out = filterStaleAbsences(events, TODAY);
  assert.deepEqual(out.map(e => e.name).sort(), ['Meg', 'OpenEnded']);
});

test('filterPastEvents keeps absences regardless of date', () => {
  const events = [
    { type: 'departure', name: 'Old', role: 'X', date: '2026-01-01' },
    { type: 'departure', name: 'Recent', role: 'Y', date: '2026-05-20' },
    { type: 'absence', name: 'Absent', role: 'Z', date: '2025-12-01', endDate: '2026-06-30' },
  ];
  const out = filterPastEvents(events, TODAY, 7);
  assert.deepEqual(out.map(e => e.name).sort(), ['Absent', 'Recent']);
});

test('filterStaleAddedDates drops undated events with stale addedDate', () => {
  const events = [
    { type: 'note', name: 'OldNote', role: 'X', addedDate: '2026-01-01' },
    { type: 'note', name: 'FreshNote', role: 'Y', addedDate: '2026-05-01' },
    { type: 'arrival', name: 'Dated', role: 'Z', date: '2026-09-01', addedDate: '2026-01-01' },
  ];
  const out = filterStaleAddedDates(events, TODAY, 60);
  assert.deepEqual(out.map(e => e.name).sort(), ['Dated', 'FreshNote']);
});

test('dedupeByPersonShow keeps most-recent addedDate per (name,type,role)', () => {
  const events = [
    { type: 'arrival', name: 'Eric Anderson', role: 'Meyer Wolfsheim', addedDate: '2026-02-11', note: 'AUTO' },
    { type: 'arrival', name: 'Eric Anderson', role: 'Meyer Wolfsheim', addedDate: '2026-04-25', note: 'verified' },
  ];
  const out = dedupeByPersonShow(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].addedDate, '2026-04-25');
});

test('dedupeByPersonShow prefers specific role over Unknown', () => {
  const events = [
    { type: 'arrival', name: 'Eric', role: 'Unknown', addedDate: '2026-04-05' },
    { type: 'arrival', name: 'Eric', role: 'Meyer Wolfsheim', addedDate: '2026-02-11' },
  ];
  const out = dedupeByPersonShow(events);
  assert.equal(out.length, 2, 'different roles produce different keys');
});

test('reconcileClosure suppresses per-actor departures on the closure date', () => {
  const events = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-14' },
    { type: 'departure', name: 'Nicholas Christopher', role: 'Anatoly', date: '2026-06-14', note: 'Production closes June 14, 2026' },
    { type: 'departure', name: 'Lea Michele', role: 'Florence', date: '2026-06-21', note: 'Final performance' },
  ];
  const out = reconcileClosure(events);
  const names = out.map(e => `${e.type}:${e.name}`).sort();
  assert.deepEqual(names, ['closure:Chess', 'departure:Lea Michele']);
});

test('detectContradictions flags arrival after closure', () => {
  const events = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-14' },
    { type: 'arrival', name: 'JoJo', role: 'Florence', date: '2026-06-23', endDate: '2026-09-13' },
  ];
  const warnings = detectContradictions(events);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'closure-vs-later-arrival');
  assert.equal(warnings[0].laterArrivals[0].name, 'JoJo');
});

test('applyPublicFilters pipeline integration', () => {
  const events = [
    { type: 'arrival', name: 'Eric', role: 'Meyer', note: '[AUTO-FLAGGED] verify', addedDate: '2026-02-11' },
    { type: 'absence', name: 'Alison', role: 'Anne', date: '2025-11-24', endDate: '2026-02-22' },
    { type: 'arrival', name: 'JoJo', role: 'Florence', date: '2026-06-23', addedDate: '2026-04-08' },
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-14', addedDate: '2026-05-02' },
    { type: 'departure', name: 'Nicholas Christopher', role: 'Anatoly', date: '2026-06-14', addedDate: '2026-05-02', note: 'Production closes June 14, 2026' },
  ];
  const out = applyPublicFilters(events, TODAY);
  const types = out.map(e => `${e.type}:${e.name}`).sort();
  assert.deepEqual(types, ['arrival:JoJo', 'closure:Chess']);
});

test('normalizeIdentifier strips nickname quotes and parens', () => {
  assert.equal(normalizeIdentifier('Joanna "JoJo" Levesque'), 'joanna levesque');
  assert.equal(normalizeIdentifier("Joanna 'JoJo' Levesque"), 'joanna levesque');
  assert.equal(normalizeIdentifier('Joanna Levesque'), 'joanna levesque');
  assert.equal(normalizeIdentifier('Joanna “JoJo” Levesque'), 'joanna levesque');
  assert.equal(normalizeIdentifier('Tom Felton (Returns)'), 'tom felton');
  assert.equal(normalizeIdentifier('TBD [understudy]'), 'tbd');
});

test('dedupeByPersonShow collapses name variants', () => {
  const events = [
    { type: 'arrival', name: 'Joanna "JoJo" Levesque', role: 'Florence', addedDate: '2026-04-08' },
    { type: 'arrival', name: "Joanna 'JoJo' Levesque", role: 'Florence', addedDate: '2026-04-09' },
    { type: 'arrival', name: 'Joanna Levesque', role: 'Florence', addedDate: '2026-04-07' },
  ];
  const out = dedupeByPersonShow(events);
  assert.equal(out.length, 1);
  assert.equal(out[0].addedDate, '2026-04-09'); // newest wins
});

test('reconcileClosure suppresses departures within 3 days of closure with closure-note', () => {
  const events = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-14' },
    { type: 'departure', name: 'A', role: 'Lead', date: '2026-06-12', note: 'Production closes June 14' },
    { type: 'departure', name: 'B', role: 'Lead', date: '2026-06-14', note: 'Final performance' },
    { type: 'departure', name: 'C', role: 'Lead', date: '2026-06-16', note: 'Production ends' },
    { type: 'departure', name: 'D', role: 'Lead', date: '2026-06-21', note: 'Final performance, successor TBA' },
  ];
  const out = reconcileClosure(events);
  const names = out.filter(e => e.type === 'departure').map(e => e.name).sort();
  // A (±2d w/ closure note), B (exact date), C (±2d w/ closure note) all suppressed.
  // D survives — date >3 days away from closure (June 21 vs June 14 = 7d), genuine personal departure.
  assert.deepEqual(names, ['D']);
});

test('reconcileClosure does NOT suppress unrelated departures near closure date', () => {
  const events = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-14' },
    { type: 'departure', name: 'Lea', role: 'Florence', date: '2026-06-13', note: 'stepping down for tour' },
  ];
  const out = reconcileClosure(events);
  assert.equal(out.filter(e => e.type === 'departure').length, 1, 'unrelated note kept');
});

test('detectContradictions flags arrival redundant with currentCast', () => {
  const currentCast = [{ name: 'Eric Anderson', role: 'Meyer Wolfsheim', since: '2025-09-01' }];
  const events = [
    { type: 'arrival', name: 'Eric Anderson', role: 'Meyer Wolfsheim', date: '2025-08-01', sourceUrl: 'x' },
  ];
  const warnings = detectContradictions(events, currentCast);
  const kinds = warnings.map(w => w.kind);
  assert.ok(kinds.includes('arrival-already-in-current-cast'));
});

test('detectCrossShowConflicts flags overlapping arrivals without exit', () => {
  const data = {
    'gatsby-2024': {
      currentCast: [],
      upcoming: [
        { type: 'arrival', name: 'Eric Anderson', role: 'Meyer', date: '2025-09-01' },
      ],
    },
    'moulin-rouge-2020': {
      currentCast: [],
      upcoming: [
        { type: 'arrival', name: 'Eric Anderson', role: 'Zidler', date: '2026-05-19' },
      ],
    },
  };
  const out = detectCrossShowConflicts(data);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cross-show-overlap-without-exit');
  assert.equal(out[0].name, 'Eric Anderson');
});

test('detectCrossShowConflicts ignores conflicts when actor has absence from one show', () => {
  const data = {
    'gatsby-2024': {
      currentCast: [],
      upcoming: [
        { type: 'arrival', name: 'Eric Anderson', role: 'Meyer', date: '2025-09-01' },
        { type: 'absence', name: 'Eric Anderson', role: 'Meyer', date: '2026-05-11', note: 'leave' },
      ],
    },
    'moulin-rouge-2020': {
      currentCast: [],
      upcoming: [
        { type: 'arrival', name: 'Eric Anderson', role: 'Zidler', date: '2026-05-19' },
      ],
    },
  };
  const out = detectCrossShowConflicts(data);
  assert.equal(out.length, 0);
});
