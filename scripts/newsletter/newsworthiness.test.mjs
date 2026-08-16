// Subject-line length cap for the weekly newsletter.
//
// Regression guard for the 2026-08-02 Sunday review catch: buildSubjectFromCandidates
// trimmed multi-candidate subjects down to 80 chars but its loop stopped at
// parts.length === 1, so a single long headline sailed past the cap. That made
// pre-send-check inject its red "PRE-SEND ISSUES" banner into the draft BODY —
// subscriber-visible if the owner hits Send without noticing.
//
// Per CLAUDE.md §15 these import the real functions; no logic is copied here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubjectFromCandidates, buildLedeSentences, trimToWordBoundary, scoreCandidates, formatClosingDay } from './newsworthiness.mjs';

const show = (id) => ({ id, slug: id, title: id });
const cand = (kind, headline, id = kind) => ({ kind, headline, show: show(id) });

test('single over-length headline is capped at 80 chars', () => {
  // The real 2026-07-27 Broadway subject: 83 chars from one candidate.
  const headline = 'Les Misérables: The Arena Concert Spectacular opens off-Broadway to strong reviews';
  const { subject } = buildSubjectFromCandidates([cand('opening', headline, 'les-mis-arena')]);
  assert.ok(subject.length <= 80, `expected <= 80, got ${subject.length}: ${subject}`);
  assert.ok(subject.startsWith('Les Misérables: The Arena Concert Spectacular'), subject);
  assert.ok(subject.endsWith('…'), subject);
});

test('short single headline is left untouched', () => {
  const { subject } = buildSubjectFromCandidates([cand('opening', 'Tao of Glass opens to strong reviews')]);
  assert.equal(subject, 'Tao of Glass opens to strong reviews.');
});

test('multi-candidate subjects still drop parts before truncating', () => {
  const long = (n) => `Show ${n} opens off-Broadway to strong reviews`;
  const { subject } = buildSubjectFromCandidates([
    cand('opening', long(1), 's1'),
    cand('closing', long(2), 's2'),
    cand('recoupment', long(3), 's3'),
  ]);
  assert.ok(subject.length <= 80, `expected <= 80, got ${subject.length}: ${subject}`);
  // Dropping whole candidates is preferred, so the surviving one stays intact
  // (no ellipsis) rather than being cut mid-phrase.
  assert.ok(!subject.endsWith('…'), subject);
});

test('showRefs only cover the candidates that survived trimming', () => {
  // Titles match their headline prefix, so "named in the subject" is checkable.
  const c = (kind, title) => ({
    kind,
    headline: `${title} opens off-Broadway to strong reviews`,
    show: { id: title, slug: title, title },
  });
  const { subject, showRefs } = buildSubjectFromCandidates([
    c('opening', 'Alpha'),
    c('closing', 'Beta'),
    c('recoupment', 'Gamma'),
  ]);
  // showRefs feeds the lede-⊆-body pre-send gate (card #482). NOTE: this
  // "every ref is named in the subject" property holds only when no truncation
  // happened — these titles are short enough that candidates are dropped whole
  // rather than trimmed. It is NOT a general invariant: a trimmed subject can
  // stop naming a show that showRefs still lists, which is safe because the
  // gate tests refs against the body, not the subject.
  assert.ok(showRefs.length >= 1);
  assert.ok(!subject.endsWith('…'), `expected no truncation in this fixture: ${subject}`);
  for (const r of showRefs) assert.ok(subject.includes(r.title), `${r.title} missing from: ${subject}`);
});

test('empty candidate list falls back to the generic subject', () => {
  const { subject, showRefs } = buildSubjectFromCandidates([]);
  assert.equal(subject, 'This week in NYC theatre.');
  assert.deepEqual(showRefs, []);
});

test('trimToWordBoundary cuts at a space and never exceeds the limit', () => {
  const out = trimToWordBoundary('the quick brown fox jumps over the lazy dog', 20);
  assert.ok(out.length <= 20, `${out.length}: ${out}`);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('  '));
  // Cut landed on a word boundary, so no partial word before the ellipsis.
  assert.ok('the quick brown fox jumps over the lazy dog'.startsWith(out.slice(0, -1)), out);
});

test('trimToWordBoundary hard-cuts an unbroken token', () => {
  const out = trimToWordBoundary('x'.repeat(200), 80);
  assert.ok(out.length <= 80, `${out.length}`);
  assert.ok(out.endsWith('…'));
});

test('trimToWordBoundary is a no-op under the limit', () => {
  assert.equal(trimToWordBoundary('short enough', 80), 'short enough');
});

// ── closing-final headlines must name the day ────────────────────────────────
// Regression guard for the 2026-08-09 Sunday review catch. `closingsThisWeek`
// is the 7 days AFTER the issue window (it was repointed there on 2026-07-12 to
// match the body's "Closing this Week" card), but the headline still read a
// bare "X plays final performance" — so the Broadway lede announced Ragtime's
// final performance on Aug 9 when the actual last show was Aug 16.
test('closing-final headline names the closing day', () => {
  const [c] = scoreCandidates({
    closingsThisWeek: [{ id: 'ragtime-2025', slug: 'ragtime', title: 'Ragtime', closingDate: '2026-08-16' }],
  }).filter(x => x.kind === 'closing-final');
  assert.ok(c, 'expected a closing-final candidate');
  assert.equal(c.headline, 'Ragtime plays its final performance Sun Aug 16');
  // The undated phrasing is the bug — it reads as "happening now".
  assert.notEqual(c.headline, 'Ragtime plays final performance');
});

test('closing-final headline degrades cleanly when the date is missing', () => {
  const [c] = scoreCandidates({
    closingsThisWeek: [{ id: 'x', slug: 'x', title: 'Some Show', closingDate: null }],
  }).filter(x => x.kind === 'closing-final');
  assert.equal(c.headline, 'Some Show plays its final performance');
  assert.ok(!/undefined|null|NaN|Invalid/.test(c.headline), c.headline);
});

test('formatClosingDay renders the NY-local day, not the UTC-midnight one', () => {
  // Bare YYYY-MM-DD parses as UTC midnight, which is the PREVIOUS evening in
  // New York — "Sun Aug 16" would render "Sat Aug 15" without the noon anchor.
  assert.equal(formatClosingDay('2026-08-16'), 'Sun Aug 16');
  assert.equal(formatClosingDay('2026-08-15'), 'Sat Aug 15');
  assert.equal(formatClosingDay('2026-08-16T00:00:00Z'), 'Sun Aug 16');
});

test('formatClosingDay returns empty string for unusable input', () => {
  for (const bad of [null, undefined, '', 'soon', 12345, {}]) {
    assert.equal(formatClosingDay(bad), '', `input: ${JSON.stringify(bad)}`);
  }
});

// ── two distinct shows opening the same week must both survive dedupe ───────
// Regression guard for 2026-08-16: two WE openings (Death Note 74/"decent",
// How the Other Half Loves 79/"strong") tied on weight, so dedupeByKind's
// per-KIND (not per-show) key kept only the most-reviewed one and dropped the
// better-reviewed show entirely — the lede's second sentence fell through to
// an unrelated closing instead of naming the second opening. Opens must
// outrank closes when both are candidates.
test('two same-kind openings for different shows both survive dedupe, ahead of a closing', () => {
  const candidates = scoreCandidates({
    edition: 'west-end',
    weGoldOpenings: [
      { show: { id: 'death-note', slug: 'death-note', title: 'Death Note: The Musical' } },
      { show: { id: 'how-the-other-half-loves', slug: 'how-the-other-half-loves', title: 'How the Other Half Loves' } },
    ],
    closingsThisWeek: [{ id: 'enormous-crocodile', slug: 'enormous-crocodile', title: 'The Enormous Crocodile', closingDate: '2026-08-22' }],
  });
  const { sentences, kinds } = buildLedeSentences(candidates, 3);
  assert.deepEqual(kinds, ['we-gold-opening', 'we-gold-opening', 'closing-final'], kinds.join(', '));
  assert.ok(sentences.some(s => s.includes('Death Note')), sentences.join(' '));
  assert.ok(sentences.some(s => s.includes('How the Other Half Loves')), sentences.join(' '));
});

test('a single recurring kind (recoupment) still dedupes to one — no per-show explosion', () => {
  const candidates = scoreCandidates({
    recoupments: [
      { show: { id: 'a', slug: 'a', title: 'Show A' }, weeksToRecoup: 10 },
      { show: { id: 'b', slug: 'b', title: 'Show B' }, weeksToRecoup: 20 },
    ],
  });
  const { kinds } = buildLedeSentences(candidates, 3);
  assert.deepEqual(kinds, ['recoupment']);
});

// ── Delacorte Theater is Free Shakespeare in the Park, not off-Broadway ─────
// Regression guard for 2026-08-16: the OB opening headline unconditionally
// said "opens off-Broadway", which misdescribes an outdoor, seasonal Public
// Theater production at the Delacorte as a commercial off-Broadway house.
test('Delacorte Theater openings say Shakespeare in the Park, not off-Broadway', () => {
  const [c] = scoreCandidates({
    obOpenings: [{ show: { id: 'winters-tale', slug: 'winters-tale', title: "The Winter's Tale", venue: 'Delacorte Theater' } }],
  });
  assert.equal(c.headline, "The Winter's Tale opens at Free Shakespeare in the Park");
  assert.ok(!/off-Broadway/.test(c.headline), c.headline);
});

test('other off-Broadway venues are unaffected by the Delacorte special-case', () => {
  const [c] = scoreCandidates({
    obOpenings: [{ show: { id: 'x', slug: 'x', title: 'Some Show', venue: 'Lucille Lortel Theatre' } }],
  });
  assert.equal(c.headline, 'Some Show opens off-Broadway');
});
