import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  extractPageMeta, evaluatePageMeta, applyMetaEvidence, isMetaEvidenceCandidate,
  evidenceNamesShow, starRunRating, venueConflicts, stampIsCurrent,
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

test('a common-word title inside another review is not the show (BRO-5794 dry run: Wildwood film vs The Heart)', () => {
  const html = page("'Wildwood' Review: A Technical Marvel with a Heart", "The film's many world-building details aren't mere whimsy, they give the story texture and weight.",
    '<meta property="article:published_time" content="2026-09-20T10:00:00Z">');
  assert.equal(evidenceNamesShow(show('The Heart'), "'Wildwood' Review: A Technical Marvel with a Heart", 'x', ''), false);
  assert.equal(judge(show('The Heart'), html).ok, false);
  // the title still counts when the headline opens with it or follows "review:"
  assert.equal(evidenceNamesShow(show('The Heart'), 'The Heart review: a tender new play', 'x', ''), true);
});

test('a ballet review of a same-titled work is not the play (BRO-5794 live run: Scottish Ballet Streetcar)', () => {
  const html = page('A Streetcar Named Desire, Scottish Ballet review', 'Tennessee Williams’s play gets a sultry, sweaty dance treatment with striking central performances.',
    '<meta property="article:published_time" content="2026-09-20T10:00:00Z">');
  assert.equal(judge(show('A Streetcar Named Desire'), html).reason, 'non-theatre-or-list');
  const ok = judge(show('Swan Lake Ballet'), page('Swan Lake Ballet review: a radiant revival', 'The company returns to the classic with a luminous new lead and a fresh staging.',
    '<meta property="article:published_time" content="2026-09-20T10:00:00Z">'));
  assert.equal(ok.ok, true);
});

test('a review-<show> path segment is a review signal for a plain-sentence headline (Bachtrack: Eugene Onegin, Così)', () => {
  const { reviewPathUrl } = require('./page-meta-evidence.js');
  assert.equal(reviewPathUrl('https://bachtrack.com/review-eugene-onegin-zangiev-metropolitan-opera-new-york-april-2026'), true);
  assert.equal(reviewPathUrl('https://example.com/theatre/review-roundup-spring-2026'), false);
  assert.equal(reviewPathUrl('https://example.com/news/review-of-the-year'), false);
  assert.equal(reviewPathUrl('https://example.com/features/eugene-onegin-profile'), false);
  const html = page('Asmik Grigorian strengthens the Met’s revival of Eugene Onegin', 'The Lithuanian soprano’s riveting performance as the central character in Tchaikovsky’s operatic masterpiece lights up Deborah Warner’s mostly bland production.',
    '<meta property="article:published_time" content="2026-09-20T10:00:00Z">');
  const s = show('Eugene Onegin', { venue: 'Metropolitan Opera' });
  assert.equal(judge(s, html, 'https://bachtrack.com/review-eugene-onegin-zangiev-metropolitan-opera-new-york-april-2026').ok, true);
  assert.equal(judge(s, html, 'https://bachtrack.com/features/eugene-onegin-guide').reason, 'no-review-signal');
});

test('a photo-caption description is boilerplate, not a standfirst (SFGate After Midnight)', () => {
  const html = page("Review: 'After Midnight' celebrates thrilling jazz", 'This undated photo released by O&M Co. shows, from left, Dulé Hill and Adriane Lenox in a scene from the musical.',
    '<meta property="article:published_time" content="2026-09-20T10:00:00Z">');
  assert.equal(judge(show('After Midnight'), html).reason, 'boilerplate');
});

test('a no-review-signal stamp from before rules v2 is stale; other reasons stay current', () => {
  const { stampIsCurrent, RULES_VERSION } = require('./page-meta-evidence.js');
  assert.equal(RULES_VERSION >= 2, true);
  assert.equal(stampIsCurrent({ metaEvidenceCheckResult: 'no-review-signal' }), false);
  assert.equal(stampIsCurrent({ metaEvidenceCheckResult: 'no-review-signal', metaEvidenceRulesVersion: RULES_VERSION }), true);
  assert.equal(stampIsCurrent({ metaEvidenceCheckResult: 'boilerplate' }), true);
  assert.equal(stampIsCurrent({ metaEvidenceCheckResult: 'unreachable' }), true);
});

test('second-opinion regressions: "Review: The X" names the show; musical standfirst may mention ballet; hub URLs are not review slugs', () => {
  const { reviewPathUrl } = require('./page-meta-evidence.js');
  assert.equal(evidenceNamesShow(show('The Heart'), 'Review: The Heart, a tender new play', 'x', ''), true);
  assert.equal(evidenceNamesShow(show('The Heart'), "'The Heart' review: tender and strange", 'x', ''), true);
  assert.equal(evidenceNamesShow(show('The Heart'), "'Wildwood' Review: A Technical Marvel with a Heart", 'x', ''), false);
  const html = page('Billy Elliot review: a joyous revival', 'A miner’s son who dreams of ballet leaps onto the stage in a thrilling, heartfelt revival of the musical.',
    '<meta property="article:published_time" content="2026-09-20T10:00:00Z">');
  assert.equal(judge(show('Billy Elliot'), html).ok, true);
  assert.equal(reviewPathUrl('https://example.com/review-hub/hamlet'), false);
  assert.equal(reviewPathUrl('https://example.com/review-podcast-episode-12'), false);
  assert.equal(reviewPathUrl('https://example.com/review-hamlet-globe'), true);
});

// BRO-5794 ship-check: adversarial pages the first guard set accepted.
const DESC = 'A long enough standfirst to pass the minimum evidence length check for sure.';
const dated = '<meta property="article:published_time" content="2026-09-20T10:00:00Z">';
const verdict = (s, h, d, url, extra = dated, data = {}) => {
  const r = evaluatePageMeta({ data: { url: url || 'https://example.com/a', outletId: 'x', ...data }, show: s, meta: extractPageMeta(page(h, d, extra)), inWindow });
  return r.ok ? 'ACCEPTED' : r.reason;
};

test('another subject in the headline is not the show', () => {
  assert.equal(verdict(show('Glengarry Glen Ross'), 'Speed-the-Plow review: a sharp revival', 'Less savage than Glengarry Glen Ross, this Mamet revival still bites with real conviction.'), 'show-not-named');
  assert.equal(verdict(show('Macbeth'), "Hamlet review: Macbeth's director tries again", DESC), 'show-not-named');
  // same show named in the headline subject, standfirst-only naming with no other subject
  assert.equal(verdict(show('Glengarry Glen Ross'), 'Glengarry Glen Ross review: a sharp revival', DESC), 'ACCEPTED');
  assert.equal(verdict(show('Glengarry Glen Ross'), 'A savage, funny revival', 'Mamet’s Glengarry Glen Ross returns with a ferocious ensemble and a real sense of danger.'), 'no-review-signal');
});

test('news, roundups, reader reviews and non-professional productions are not reviews', () => {
  for (const h of ['Hamlet reviews: critics are divided on the new staging', 'Hamlet star responds to scathing review', 'Hamlet: reader reviews and ratings']) {
    assert.equal(verdict(show('Hamlet'), h, DESC), 'non-review-headline', h);
  }
  assert.equal(verdict(show('Hamlet'), 'Hamlet review: a school production with heart', DESC), 'non-review-headline');
});

test('London or West End in the headline of a non-UK show is a different production', () => {
  assert.equal(verdict(show('Hamlet', { category: 'broadway' }), 'Hamlet review: the London transfer still sings', DESC), 'other-city');
  assert.equal(verdict(show('Hamlet', { category: 'west-end', id: 'hamlet-west-end-2026' }), 'Hamlet review: the London transfer still sings', DESC), 'ACCEPTED');
});

test('only a stated rating is a rating: "5 stars who shaped the role" and "the 2 stars of Hamlet" are prose', () => {
  assert.equal(verdict(show('Hamlet'), 'Hamlet: 5 stars who shaped the role over a century', DESC), 'no-review-signal');
  assert.equal(verdict(show('Hamlet'), 'Hamlet feature', 'The 2 stars of Hamlet discuss the role, rehearsals and the long road to opening night.'), 'no-review-signal');
  assert.equal(starRunRating('Hamlet: 5 stars who shaped the role'), null);
  assert.equal(starRunRating('Hamlet review ★★★★'), 4);
  assert.equal(starRunRating('Hamlet review: 4 stars'), 4);
  assert.equal(starRunRating('Hamlet 3/5'), 3);
});

test('titles with stop words name themselves (Death of a Salesman, Kiss Me, Kate)', () => {
  for (const [t, h] of [['Death of a Salesman', 'Death of a Salesman review: a shattering revival'],
    ['The Importance of Being Earnest', 'The Importance of Being Earnest review: sparkling'],
    ['Kiss Me, Kate', 'Kiss Me, Kate review: a joyous revival']]) {
    assert.equal(verdict(show(t), h, DESC), 'ACCEPTED', t);
  }
  assert.equal(verdict(show('Death of a Salesman'), 'Salesman review: a different show', DESC), 'show-not-named');
});

test('a JSON-LD rating with no bestRating and a value above 5 is not a /5 rating', () => {
  const ld = (v, best) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Review', reviewRating: { ratingValue: v, ...(best ? { bestRating: best } : {}) } })}</script>`;
  assert.equal(extractPageMeta(page('x', 'y', ld(8))).ratingValue, null);
  assert.equal(extractPageMeta(page('x', 'y', ld(4))).ratingValue, 4);
  assert.equal(extractPageMeta(page('x', 'y', ld(8, 10))).ratingBest, 10);
});

test('undated pages: a URL path year decides and a path year far from the stub date conflicts', () => {
  const noDate = '';
  assert.equal(verdict(show('Hamlet', { openingDate: '2025-01-15' }), 'Hamlet review: brilliant', DESC, 'https://example.com/2025/03/10/hamlet-review', noDate), 'ACCEPTED');
  assert.equal(verdict(show('Hamlet'), 'Hamlet review: brilliant', DESC, 'https://example.com/2019/hamlet-review', noDate), 'url-date-outside-window');
  assert.equal(verdict(show('Hamlet'), 'Hamlet review: brilliant', DESC, 'https://example.com/hamlet-review', noDate), 'no-date');
  assert.equal(verdict(show('Hamlet'), 'Hamlet review: brilliant', DESC, 'https://example.com/2019/05/hamlet-review', noDate, { publishDate: '2026-09-20' }), 'date-conflict');
});

test('rules version 3 rechecks show-not-named and undated rejections; other stamps stay current', () => {
  assert.equal(stampIsCurrent({ metaEvidenceCheckResult: 'show-not-named', metaEvidenceRulesVersion: 2 }), false);
  assert.equal(stampIsCurrent({ metaEvidenceCheckResult: 'no-date' }), false);
  assert.equal(stampIsCurrent({ metaEvidenceCheckResult: 'fetch-failed' }), true);
  assert.equal(stampIsCurrent({ metaEvidenceCheckResult: 'show-not-named', metaEvidenceRulesVersion: 3 }), true);
});

test('a same-titled production by an Australian company is another production (Victorian Opera Turn of the Screw)', () => {
  assert.equal(verdict(show('The Turn of the Screw', { venue: 'Hackney Empire', category: 'off-west-end' }), 'A spellbinding Turn of the Screw from Victorian Opera', 'Rachelle Durkin shines in a staging that brings Britten’s ghost story chillingly to life.', 'https://bachtrack.com/review-turn-of-the-screw-victorian-opera-2026'), 'other-city');
  assert.equal(verdict(show('The Turn of the Screw', { venue: 'Hackney Empire' }), 'The Turn of the Screw review: a spellbinding staging', 'Rachelle Durkin shines in a staging that brings Britten’s ghost story chillingly to life.'), 'ACCEPTED');
});

test('a thrown fetch is stamped fetch-failed (walled pages stop re-spending the paid chain weekly)', () => {
  const { missingHtmlStamp } = require('./page-meta-evidence.js');
  assert.equal(missingHtmlStamp(true), 'fetch-failed');
  assert.equal(missingHtmlStamp(false), 'unreachable');
});
