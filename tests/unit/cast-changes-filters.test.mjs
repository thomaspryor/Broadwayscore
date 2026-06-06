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
  resolveClosureArrivalContradictions,
  detectCrossShowConflicts,
  applyPublicFilters,
  normalizeIdentifier,
  CLOSURE_NOTE_PHRASES,
  noteMatchesClosurePhrase,
  earliestAddedDate,
  mergePreservingAddedDate,
  findClosureDupe,
  dedupeClosures,
  reconcileClosureDateWithClosingDate,
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

test('resolveClosureArrivalContradictions: newer closure (early-close) drops stale arrival', () => {
  // chess-2025 real case: early-close announced 2026-05-27 (newest) beats a
  // planned-succession arrival added 2026-04-18.
  const events = [
    { type: 'arrival', name: 'Joanna Levesque', role: 'Florence', date: '2026-06-23', addedDate: '2026-04-18' },
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-21', addedDate: '2026-05-27' },
  ];
  const res = resolveClosureArrivalContradictions(events);
  assert.equal(res.droppedClosures, 0);
  assert.equal(res.droppedArrivals, 1);
  const types = res.events.map(e => e.type).sort();
  assert.deepEqual(types, ['closure']);
});

test('resolveClosureArrivalContradictions: newer arrival (extension) drops stale closure', () => {
  // Original Chess bug: a stale "closes June 14" loses to a later-added arrival
  // showing the run extended through September.
  const events = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-14', addedDate: '2026-04-01' },
    { type: 'arrival', name: 'JoJo', role: 'Florence', date: '2026-06-23', endDate: '2026-09-13', addedDate: '2026-05-02' },
  ];
  const res = resolveClosureArrivalContradictions(events);
  assert.equal(res.droppedClosures, 1);
  assert.equal(res.droppedArrivals, 0);
  const types = res.events.map(e => e.type).sort();
  assert.deepEqual(types, ['arrival']);
});

test('resolveClosureArrivalContradictions: missing/tied addedDate keeps the closure', () => {
  const events = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-14' },
    { type: 'arrival', name: 'JoJo', role: 'Florence', date: '2026-06-23' },
  ];
  const res = resolveClosureArrivalContradictions(events);
  assert.equal(res.droppedClosures, 0);
  assert.equal(res.droppedArrivals, 1);
  assert.deepEqual(res.events.map(e => e.type), ['closure']);
});

test('resolveClosureArrivalContradictions: closure missing addedDate keeps closure (one-sided metadata never unseats a closure)', () => {
  const events = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-21' },
    { type: 'arrival', name: 'JoJo', role: 'Florence', date: '2026-06-23', addedDate: '2026-04-18' },
  ];
  const res = resolveClosureArrivalContradictions(events);
  assert.equal(res.droppedClosures, 0);
  assert.equal(res.droppedArrivals, 1);
  assert.deepEqual(res.events.map(e => e.type), ['closure']);
});

test('resolveClosureArrivalContradictions: no closure or no later arrival is a no-op', () => {
  const noClosure = [{ type: 'arrival', name: 'X', role: 'Y', date: '2026-06-23' }];
  assert.equal(resolveClosureArrivalContradictions(noClosure).events.length, 1);
  // Arrival BEFORE the closure is not a contradiction — keep both.
  const arrivalBefore = [
    { type: 'closure', name: 'Chess', role: 'Production', date: '2026-06-21', addedDate: '2026-05-27' },
    { type: 'arrival', name: 'JoJo', role: 'Florence', date: '2026-06-10', addedDate: '2026-04-18' },
  ];
  const res = resolveClosureArrivalContradictions(arrivalBefore);
  assert.equal(res.droppedClosures + res.droppedArrivals, 0);
  assert.equal(res.events.length, 2);
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

test('normalizeIdentifier preserves apostrophes in real names', () => {
  // Regression: the old regex treated lone apostrophes in real names as
  // quote delimiters, span-stripping characters between them.
  assert.equal(normalizeIdentifier("Sean O'Malley"), "sean o'malley");
  assert.equal(normalizeIdentifier("D'Angelo Brown"), "d'angelo brown");
  assert.equal(normalizeIdentifier("Mary-Kate O'Brien"), "mary-kate o'brien");
  // Real name + bracketed nickname: nickname strips, name keeps apostrophe
  assert.equal(normalizeIdentifier("Mary-Kate \"MK\" O'Brien"), "mary-kate o'brien");
  // Real name + lone-apostrophe-nickname must NOT swallow the real name
  // ("Sean O'Malley 'Slick' Jones" — only 'Slick' is a balanced nickname)
  assert.equal(normalizeIdentifier("Sean O'Malley 'Slick' Jones"), "sean o'malley jones");
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
  // Two arrivals with explicit endDates that overlap, no exit from either.
  // Realistic: same actor announced in two shows for the same week.
  const data = {
    'gatsby-2024': {
      currentCast: [],
      upcoming: [
        { type: 'arrival', name: 'Eric Anderson', role: 'Meyer', date: '2026-05-01', endDate: '2026-07-01' },
      ],
    },
    'moulin-rouge-2020': {
      currentCast: [],
      upcoming: [
        { type: 'arrival', name: 'Eric Anderson', role: 'Zidler', date: '2026-05-19', endDate: '2026-08-01' },
      ],
    },
  };
  const out = detectCrossShowConflicts(data);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'cross-show-overlap-without-exit');
  assert.equal(out[0].name, 'Eric Anderson');
});

test('detectCrossShowConflicts: missing endDate is capped at 30 days (no false positives for far-apart arrivals)', () => {
  // Two arrivals 8 months apart, no endDate on either. With the +365 day
  // default this would falsely flag; with +30 day cap it correctly does NOT.
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
  assert.equal(out.length, 0, 'two arrivals 8 months apart with no endDate must not flag as conflict');
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

// ---------------------------------------------------------------------------
// Closure phrase contract — guards against the audit ↔ runtime ↔ TS drift
// that shipped the DBH "Betsy Wolfe departs · final Jun 28" bug. CLOSURE_NOTE_PHRASES
// is the single source of truth; every consumer must build on top of it.
// ---------------------------------------------------------------------------

test('CLOSURE_NOTE_PHRASES is non-empty, frozen, and lower-case', () => {
  assert.ok(Array.isArray(CLOSURE_NOTE_PHRASES));
  assert.ok(CLOSURE_NOTE_PHRASES.length >= 4);
  assert.ok(Object.isFrozen(CLOSURE_NOTE_PHRASES));
  for (const p of CLOSURE_NOTE_PHRASES) {
    assert.equal(p, p.toLowerCase(), `phrase must be lower-case: ${p}`);
  }
});

test('noteMatchesClosurePhrase: every phrase matches itself', () => {
  for (const phrase of CLOSURE_NOTE_PHRASES) {
    assert.ok(noteMatchesClosurePhrase(phrase), `should match: ${phrase}`);
    assert.ok(noteMatchesClosurePhrase(phrase.toUpperCase()), `case-insensitive: ${phrase}`);
    assert.ok(noteMatchesClosurePhrase(`Final performance — ${phrase} on June 28`), `substring: ${phrase}`);
  }
  assert.equal(noteMatchesClosurePhrase('leaving for a film role'), false);
  assert.equal(noteMatchesClosurePhrase(null), false);
  assert.equal(noteMatchesClosurePhrase(''), false);
});

test('reconcileClosure suppresses departures for every CLOSURE_NOTE_PHRASES entry', () => {
  // Per-phrase: closure event + a same-date departure with that phrase in the
  // note. After reconcile, only the closure should remain.
  for (const phrase of CLOSURE_NOTE_PHRASES) {
    const events = [
      { type: 'closure', name: 'test-show', role: 'Production', date: '2026-06-28', note: 'Production closes' },
      { type: 'departure', name: 'Lead Actor', role: 'Star', date: '2026-06-28', note: `Final performance — ${phrase}` },
    ];
    const out = reconcileClosure(events);
    assert.equal(out.length, 1, `phrase did not suppress same-date departure: ${phrase}`);
    assert.equal(out[0].type, 'closure', `phrase left a departure standing: ${phrase}`);
  }
});

test('audit isClosureDeparture matches CLOSURE_NOTE_PHRASES (contract test)', async () => {
  // The audit script is CJS — load via dynamic import + createRequire so the
  // test can grep for symbol drift between the two callers. If audit ever
  // imports a sibling phrase list, this test fails loudly.
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const auditPath = require.resolve('../../scripts/audit-cast-changes.js');
  const src = (await import('node:fs')).readFileSync(auditPath, 'utf8');
  // Audit MUST import noteMatchesClosurePhrase rather than re-list phrases.
  assert.ok(
    /noteMatchesClosurePhrase/.test(src),
    'scripts/audit-cast-changes.js must import noteMatchesClosurePhrase from scripts/lib/cast-changes-filters.js',
  );
  // No inline phrase list (a stray "production closes" string-literal would
  // be the failure mode). Allow comments referencing the list.
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  for (const phrase of CLOSURE_NOTE_PHRASES) {
    assert.ok(
      !codeOnly.includes(`'${phrase}'`) && !codeOnly.includes(`"${phrase}"`),
      `audit-cast-changes.js still has inline phrase literal '${phrase}' — must use shared constant`,
    );
  }
});

test('audit reclassifier requires group size >= 2 (no singleton-promotion)', async () => {
  // Verify the audit logic doesn't promote a single matching departure into
  // a fabricated show-wide closure. We test the function in isolation by
  // requiring the module fresh (no global state).
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const src = (await import('node:fs')).readFileSync(
    require.resolve('../../scripts/audit-cast-changes.js'),
    'utf8',
  );
  // Extract reclassifyClosureDepartures + dependencies via Function eval
  // (the function is not exported; this mirrors the pre-existing pattern
  // used elsewhere in this repo for testing audit internals).
  const fn = `${src.match(/const MIN_RECLASS_GROUP_SIZE[\s\S]*?\nfunction reclassifyClosureDepartures[\s\S]*?\n\}\n/)[0]}\nreturn reclassifyClosureDepartures;`;
  const filters = require('../../scripts/lib/cast-changes-filters.js');
  const TODAY_STR = '2026-05-24';
  const isClosureDeparture = e => e.type === 'departure' && filters.noteMatchesClosurePhrase(e.note);
  const reclassify = new Function('isClosureDeparture', 'TODAY_STR', fn)(isClosureDeparture, TODAY_STR);

  // Singleton: a lone "actor X — show closes" departure should NOT become
  // a synthetic closure event.
  const singleton = [
    { type: 'departure', name: 'A', role: 'X', date: '2026-06-28', note: 'final performance as show closes' },
  ];
  const out1 = reclassify(singleton, 'test');
  assert.equal(out1.rewritten.filter(e => e.type === 'closure').length, 0, 'singleton promoted to closure');
  assert.equal(out1.rewritten.length, 1, 'singleton departure should be preserved');

  // Cluster (>=2): should reclassify.
  const cluster = [
    { type: 'departure', name: 'A', role: 'X', date: '2026-06-28', note: 'production closes' },
    { type: 'departure', name: 'B', role: 'Y', date: '2026-06-28', note: 'production closes' },
  ];
  const out2 = reclassify(cluster, 'test');
  assert.equal(out2.rewritten.filter(e => e.type === 'closure').length, 1, 'cluster did not reclassify');
});

// ==================== write-once addedDate + closure de-dup ====================

test('earliestAddedDate returns the earlier date (first-seen wins)', () => {
  assert.equal(earliestAddedDate('2026-05-27', '2026-05-19'), '2026-05-19');
  assert.equal(earliestAddedDate('2026-05-19', '2026-05-27'), '2026-05-19');
  assert.equal(earliestAddedDate(undefined, '2026-05-19'), '2026-05-19');
  assert.equal(earliestAddedDate('2026-05-19', null), '2026-05-19');
});

test('mergePreservingAddedDate keeps first-seen addedDate on a source upgrade', () => {
  // Simulates a higher-priority source re-discovering an existing closure:
  // every field upgrades EXCEPT addedDate, which stays pinned to first-seen.
  const existing = {
    type: 'closure', name: 'death-becomes-her-2024', role: 'Production',
    date: '2026-06-28', note: 'short', sourceType: 'official-site', addedDate: '2026-05-19',
  };
  const fresh = {
    type: 'closure', name: 'Death Becomes Her', role: 'Production',
    date: '2026-06-28', note: 'Final performance at the Lunt-Fontanne Theatre on June 28, 2026.',
    sourceType: 'playbill', addedDate: '2026-05-30',
  };
  mergePreservingAddedDate(existing, fresh);
  assert.equal(existing.addedDate, '2026-05-19', 'addedDate must not move forward');
  assert.equal(existing.note, fresh.note, 'richer fields upgrade');
  assert.equal(existing.sourceType, 'playbill');
});

test('findClosureDupe matches a closure by date even when name/role differ', () => {
  const upcoming = [
    { type: 'closure', name: 'death-becomes-her-2024', role: 'Production', date: '2026-06-28' },
    { type: 'departure', name: 'Megan Hilty', role: 'Madeline', date: '2026-06-28' },
  ];
  const dupe = findClosureDupe(upcoming, {
    type: 'closure', name: 'Death Becomes Her', role: 'Production', date: '2026-06-28',
  });
  assert.ok(dupe, 'should find existing closure on same date');
  assert.equal(dupe.name, 'death-becomes-her-2024');
  // Non-closure or different date → no match
  assert.equal(findClosureDupe(upcoming, { type: 'arrival', date: '2026-06-28' }), null);
  assert.equal(findClosureDupe(upcoming, { type: 'closure', date: '2026-07-01' }), null);
});

test('dedupeClosures collapses two closures on the same date, keeping richer note + earliest addedDate', () => {
  const events = [
    { type: 'closure', name: 'death-becomes-her-2024', role: 'Production', date: '2026-06-28', note: 'short', addedDate: '2026-05-19' },
    { type: 'closure', name: 'Death Becomes Her', role: 'Production', date: '2026-06-28', note: 'Final performance at the Lunt-Fontanne Theatre on June 28, 2026.', addedDate: '2026-05-27' },
    { type: 'departure', name: 'X', role: 'Y', date: '2026-06-28' },
  ];
  const out = dedupeClosures(events);
  const closures = out.filter(e => e.type === 'closure');
  assert.equal(closures.length, 1, 'one closure per date');
  assert.equal(closures[0].addedDate, '2026-05-19', 'earliest addedDate pinned');
  assert.match(closures[0].note, /Final performance/, 'richer note kept');
  assert.equal(out.filter(e => e.type === 'departure').length, 1, 'non-closures untouched');
});

test('dedupeClosures keeps distinct closing dates separate', () => {
  const events = [
    { type: 'closure', date: '2026-06-28', note: 'a', addedDate: '2026-05-19' },
    { type: 'closure', date: '2026-07-01', note: 'b', addedDate: '2026-05-20' },
  ];
  assert.equal(dedupeClosures(events).length, 2);
});

// ==================== closure date reconciliation vs shows.json ====================

test('reconcileClosureDateWithClosingDate corrects a stale closure date to canonical', () => {
  const events = [
    { type: 'closure', name: 'The Show', date: '2026-07-01', note: 'ends in July', sourceUrl: 'http://x', addedDate: '2026-02-05' },
    { type: 'departure', name: 'Actor', date: '2026-07-01' },
  ];
  const { events: out, repaired } = reconcileClosureDateWithClosingDate(events, '2026-08-30');
  assert.equal(repaired, 1);
  const c = out.find(e => e.type === 'closure');
  assert.equal(c.date, '2026-08-30', 'date corrected to canonical');
  assert.equal(c.addedDate, '2026-02-05', 'write-once addedDate preserved');
  assert.equal(c.sourceUrl, 'http://x', 'sourceUrl preserved');
  assert.match(c.note, /reconciled to broadway\.com/);
  assert.equal(out.find(e => e.type === 'departure').date, '2026-07-01', 'non-closures untouched');
});

test('reconcileClosureDateWithClosingDate is a no-op when already canonical', () => {
  const events = [{ type: 'closure', date: '2026-08-30', note: 'ok', addedDate: '2026-02-05' }];
  const { events: out, repaired } = reconcileClosureDateWithClosingDate(events, '2026-08-30');
  assert.equal(repaired, 0);
  assert.equal(out[0].note, 'ok', 'untouched when already correct');
});

test('reconcileClosureDateWithClosingDate no-ops on missing/invalid canonical date', () => {
  const events = [{ type: 'closure', date: '2026-07-01', addedDate: '2026-02-05' }];
  for (const bad of [null, undefined, '', '2026-08', 'garbage']) {
    const { repaired } = reconcileClosureDateWithClosingDate(events, bad);
    assert.equal(repaired, 0, `no-op for ${JSON.stringify(bad)}`);
  }
});
