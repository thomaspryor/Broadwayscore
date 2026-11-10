// BRO-7291 class 8: the weekly dual-model city-hub audit's decisions, replayed on real scorecard flags
// (2026-11-10 dry run of scripts/city-hub-weekly-audit.js over the five launched hubs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const W = require('./city-hub-weekly.js');

const IRMA = { kind: 'show', id: 'the-mystery-of-irma-vep-regional-2026', label: 'The Mystery of Irma Vep', model: 'local', code: 'review-text-later-closing', detail: 'ours 2026-06-21 / review text "through 2026-06-28"', fix: { field: 'closingDate', value: '2026-06-28', sourceField: 'closingDateSource', source: 'review-text:sleeplesscritic.com' } };
const OCTET = { kind: 'show', id: 'octet-regional-2026', label: 'Octet', model: 'local', code: 'venue-contradicted', detail: 'ours Goodman Theatre / 7 outlets name Raven Theatre', fix: { field: 'venue', value: 'Raven Theatre' } };
const RELENTLESS = { kind: 'show', id: 'relentless-regional-2022', label: 'Relentless', model: 'local', code: 'venue-contradicted', detail: 'ours Goodman Theatre / 5 outlets name Timeline Theatre', fix: { field: 'venue', value: 'Timeline Theatre' } };
// Both model families on the same item + code: believable without a local check.
const CLOWN = ['gemini', 'openai'].map((model) => ({ kind: 'show', id: 'clown-sh-t-regional-2026', label: 'Clown Sh*t!', model, code: 'opening-date', detail: 'ours 2026-07-21 / page 2026-01-23' }));
// One model alone: not a finding (the models disagree too often to act on one).
const LONE = { kind: 'show', id: 'x-regional-2026', label: 'X', model: 'gemini', code: 'opening-date', detail: 'ours 2026-03-01 / page 2026-02-01' };
// Not one of the six classes.
const OTHER = { kind: 'show', id: 'x-regional-2026', label: 'X', model: 'local', code: 'image-missing', detail: '' };

test('findings: local checks and both-model agreement count; a lone model and other codes do not', () => {
  const f = W.findingsFromFlags([IRMA, OCTET, ...CLOWN, LONE, OTHER]);
  assert.deepEqual(f.map((x) => x.key).sort(), ['show:clown-sh-t-regional-2026:opening-date', 'show:octet-regional-2026:venue-contradicted', 'show:the-mystery-of-irma-vep-regional-2026:review-text-later-closing']);
  assert.deepEqual(f.find((x) => x.id.startsWith('clown')).models, ['gemini', 'openai']);
  assert.equal(f.find((x) => x.id.startsWith('irma') || x.id.includes('irma')).cls, 1);
  assert.equal(f.find((x) => x.id.startsWith('octet')).cls, 3);
});

test('new findings: last week\'s keys and settled triage are excluded; a per-check verdict beats the item verdict', () => {
  const f = W.findingsFromFlags([IRMA, OCTET, RELENTLESS, ...CLOWN]);
  const triage = { items: {
    // real LA triage: the show's closing was confirmed + fixed, the opening-date lead is another run (false positive)
    'show:clown-sh-t-regional-2026': { verdict: 'confirmed', status: 'fixed' },
    // real Chicago triage: outlets name the company, not the venue
    'show:relentless-regional-2022:venue-contradicted': { verdict: 'false-positive' },
    // confirmed but not yet fixed stays new
    'show:octet-regional-2026': { verdict: 'confirmed', status: 'remaining' },
  } };
  const fresh = W.newFindings(f, ['show:the-mystery-of-irma-vep-regional-2026:review-text-later-closing'], triage);
  assert.deepEqual(fresh.map((x) => x.id), ['octet-regional-2026']);
  // the 2026-11-10 bug: the item verdict was confirmed with no status, so the opening-date lead came back as new
  const item = { items: { 'show:clown-sh-t-regional-2026': { verdict: 'confirmed', status: '' } } };
  assert.equal(W.newFindings(W.findingsFromFlags(CLOWN), [], item).length, 1);
  const perCheck = { items: { ...item.items, 'show:clown-sh-t-regional-2026:opening-date': { verdict: 'false-positive' } } };
  assert.equal(W.newFindings(W.findingsFromFlags(CLOWN), [], perCheck).length, 0);
});

test('plan actions: only local show findings with an exact fix, with the source field alongside', () => {
  const a = W.planActions(W.findingsFromFlags([IRMA, OCTET, ...CLOWN]));
  assert.deepEqual(a.map((x) => `${x.showId}.${x.field}=${x.newValue}`), [
    'the-mystery-of-irma-vep-regional-2026.closingDate=2026-06-28',
    'the-mystery-of-irma-vep-regional-2026.closingDateSource=review-text:sleeplesscritic.com',
    'octet-regional-2026.venue=Raven Theatre',
  ]);
  for (const x of a) { assert.equal(x.type, 'data-edit'); assert.equal(x.file, 'shows.json'); assert.ok(!('oldValue' in x)); }
});

test('iso week: one card per city per week', () => {
  assert.equal(W.isoWeek('2026-11-10'), '2026-W46');
  assert.equal(W.isoWeek('2027-01-01'), '2026-W53');
  assert.equal(W.isoWeek('2026-01-01'), '2026-W01');
});

test('card: null when nothing is new; otherwise one card naming the plan and a VERIFY line', () => {
  assert.equal(W.cardFor('san-diego-ca', '2026-W46', [], { provenance: { unprovenanced: 0 } }), null);
  const fresh = W.findingsFromFlags([IRMA, OCTET]);
  const c = W.cardFor('chicago-il', '2026-W46', fresh, { planId: 'bro-7291-chicago-il-2026-w46', provenance: { unprovenanced: 2 } });
  assert.equal(c.title, 'City hub audit chicago-il 2026-W46: 3 new finding(s)');
  assert.match(c.body, /### Class 1: stale closing date \(1\)/);
  assert.match(c.body, /### Class 5: unprovenanced hand-entered row \(2\)/);
  assert.match(c.body, /bro-7291-chicago-il-2026-w46/);
  assert.match(c.body, /^VERIFY: node scripts\/city-hub-weekly-audit\.js --city=chicago-il --no-llm --dry-run --open$/m);
});
