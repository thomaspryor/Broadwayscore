import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractPageMeta, evaluatePageMeta, applyMetaEvidence, isMetaEvidenceCandidate,
  evidenceNamesShow, starRunRating, venueConflicts,
} = require('./page-meta-evidence.js');
const { explainExclusion } = require('./review-guards.js');
const { hasExcerpt, EXCERPT_FIELDS } = require('./excerpt-fields.js');

const inWindow = (show, d) => d >= show.openingDate && d <= '2027-12-31';
const show = (title, extra = {}) => ({ id: 'x', title, openingDate: '2026-09-01', venue: 'Riverside Studios', ...extra });
const page = (headline, description, extra = '') =>
  `<html><head><title>${headline}</title><meta property="og:title" content="${headline}"><meta property="og:description" content="${description}">${extra}</head></html>`;
const judge = (s, html, url = 'https://example.com/a') =>
  evaluatePageMeta({ data: { url, outletId: 'x' }, show: s, meta: extractPageMeta(html), inWindow });

test('genuine review of the right show is accepted', () => {
  const r = judge(show('Ballad Lines'), page('Ballad Lines review: A muddled musical with moments of brilliance', 'A Jacobean vicar&#8217;s wife, a pregnant Presbyterian and a ghost walk into a folk song cycle.',
    '<meta property="article:published_time" content="2026-09-20T10:00:00Z">'));
  assert.equal(r.ok, true);
  assert.equal(r.publishDate, '2026-09-20');
});

test('star-run headline counts as a rating and tolerates a short standfirst', () => {
  assert.equal(starRunRating('The Last Ship - Theatre Royal Drury Lane ★★★★'), 4);
  assert.equal(starRunRating('Some Show: 3.5 stars'), 3.5);
  const r = judge(show('The Last Ship', { venue: 'Theatre Royal Drury Lane' }), page('The Last Ship - Theatre Royal Drury Lane ★★★★★', "Sting's political folk musical.", '<meta property="article:published_time" content="2026-09-20T10:00:00Z">'));
  assert.equal(r.ok, true);
  assert.deepEqual(r.rating, { value: 5, best: 5 });
});

test('boilerplate, non-review, non-theatre and unnamed shows are rejected', () => {
  assert.equal(judge(show('Midnight'), page('Midnight review', 'Buy tickets from £20 for Midnight at the venue, book now for dates.')).reason, 'boilerplate');
  assert.equal(judge(show('Midnight'), page('Interview: the star of Midnight', 'The star talks about the show, rehearsals and much more in this long chat.')).reason, 'non-review-headline');
  assert.equal(judge(show('Midnight'), page('Midnight video game review', 'A long review of the new game on PlayStation and Xbox this year.')).reason, 'non-theatre-or-list');
  assert.equal(judge(show('Eugene Onegin'), page('A different opera review', 'This review covers another production entirely, with a new cast and design.')).reason, 'show-not-named');
});

test('partial or market-word title matches do not name the show', () => {
  assert.equal(evidenceNamesShow(show('The Fear of 13'), "'Cape Fear' Review: Javier Bardem", 'A thriller', ''), false);
  assert.equal(evidenceNamesShow(show('End'), 'Review: West End transfer', 'A big night in the West End', ''), false);
  assert.equal(evidenceNamesShow(show('End'), 'Review: End, at Dorfman', '', ''), true);
  assert.equal(evidenceNamesShow(show('Stories'), 'Untold Stories: New Writing Festival', '', ''), false);
  assert.equal(evidenceNamesShow(show('The Other Place'), 'Alison Oliver is glorious - but The Other Place is frustrating', '', ''), true);
});

test('a different venue in the headline is a different production', () => {
  assert.equal(venueConflicts(show('A Christmas Carol', { venue: 'The Old Vic' }), 'Review: A Christmas Carol, The Royal Shakespeare Theatre'), true);
  assert.equal(venueConflicts(show('Hadestown', { venue: 'Olivier Theatre' }), 'Review: Hadestown, The National Theatre'), false);
});

test('outside the production window is rejected', () => {
  const r = judge(show('Ballad Lines'), page('Ballad Lines review: muddled', 'A long enough standfirst about the production and its cast and score.',
    '<meta property="article:published_time" content="2019-01-01T00:00:00Z">'));
  assert.equal(r.reason, 'outside-production-window');
});

test('candidate gate: only a text-less stub from a known outlet', () => {
  const ok = { url: 'https://a.com/x', outletId: 'city-am' };
  assert.equal(isMetaEvidenceCandidate(ok, 'noTextOrScoreSignal').ok, true);
  assert.equal(isMetaEvidenceCandidate(ok, 'wrongShow').ok, false);
  assert.equal(isMetaEvidenceCandidate({ ...ok, outletId: 'unknown' }, 'noTextOrScoreSignal').ok, false);
  assert.equal(isMetaEvidenceCandidate({ ...ok, fullText: 'x'.repeat(10) }, 'noTextOrScoreSignal').ok, false);
});

test('applyMetaEvidence gap-fills and never overwrites', () => {
  const data = { url: 'https://a.com/x', outletId: 'x', criticName: 'Real Person', publishDate: '2026-09-02', incompleteReason: 'url_content_mismatch' };
  const set = applyMetaEvidence(data, { ok: true, excerpt: 'Headline. Standfirst text here.', publishDate: '2026-09-20', criticName: 'Other Name', rating: { value: 4, best: 5 } });
  assert.equal(data.publishDate, '2026-09-02');
  assert.equal(data.criticName, 'Real Person');
  assert.equal(data.contentTier, 'excerpt');
  assert.equal(data.originalScore, '4/5 stars');
  assert.equal(data.incompleteReason, 'url_content_mismatch'); // left as is: it records that the page did not match the URL
  assert.ok(set.includes('metaExcerpt'));
});

test('rebuild treats metaExcerpt as text', () => {
  assert.ok(EXCERPT_FIELDS.includes('metaExcerpt'));
  assert.equal(hasExcerpt({ metaExcerpt: 'Headline. A standfirst that is long enough to count.' }), true);
  const stub = { url: 'https://a.com/x', outletId: 'city-am', criticName: 'A B', publishDate: '2026-09-20' };
  assert.equal(explainExclusion(stub, show('Ballad Lines'), 'x/city-am--a-b.json'), 'noTextOrScoreSignal');
  assert.notEqual(explainExclusion({ ...stub, metaExcerpt: 'Headline. A standfirst that is long enough to count.' }, show('Ballad Lines'), 'x/city-am--a-b.json'), 'noTextOrScoreSignal');
});

// Ship-check regressions (BRO-5794): each of these used to come back ok:true.
test('roundups, films, interviews, taglines, other cities and dateless pages are rejected', () => {
  const s = show('Hamlet');
  const d = '<meta property="article:published_time" content="2026-09-20T10:00:00Z">';
  const long = 'A lengthy description that runs well past the minimum evidence length for testing.';
  const cases = {
    roundup: [page('Theatre reviews: Hamlet, Macbeth and more', long, d)],
    film: [page('Hamlet (2026 film) review', long, d)],
    interview: [page('Hamlet review: Ian McKellen on Hamlet, the role he always wanted', 'In a lengthy chat about the role he always wanted to play on stage.', d)],
    tagline: [page('Hamlet', 'The Stage is the home of performing arts news, jobs, reviews and features for the industry.', d), 'https://example.com/reviews/hamlet'],
    city: [page('Hamlet review - Stratford', long, d)],
    dateless: [page('Hamlet review: a bold staging', long)],
  };
  for (const [name, [html, url]] of Object.entries(cases)) {
    assert.equal(judge(s, html, url || 'https://example.com/a').ok, false, name);
  }
});

test('headline star rating is labelled as page-meta-headline, not jsonld', () => {
  const r = judge(show('Ballad Lines'), page('Ballad Lines review ★★★★', 'A folk song cycle with moments of brilliance and a strong cast.',
    '<meta property="article:published_time" content="2026-09-20T10:00:00Z">'));
  assert.equal(r.ok, true);
  const rec = {}; applyMetaEvidence(rec, r);
  assert.equal(rec.originalScoreSource, 'page-meta-headline');
});

test('classifyContentTier and hasAggregatorExcerpt count metaExcerpt', () => {
  const { hasAggregatorExcerpt } = require('./review-guards.js');
  assert.equal(hasAggregatorExcerpt({ metaExcerpt: 'x'.repeat(60) }), true);
});
