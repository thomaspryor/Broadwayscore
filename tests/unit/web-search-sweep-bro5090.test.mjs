// BRO-5090: second pass of the BRO-5081 web-search byline sweep (fetchPage
// over the rows curl could not read), its text-collection targets, and the
// collector's exact/forced REVIEW_FILTER targeting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeRecheck, alreadyTriedByFetchPage, unreadVerdict, judgeDate, parseArgs } = require('../../scripts/review-factcheck/sweep-web-search-bylines.js');
const { textTargets, FORCE_TEXT, planLedger, pageNamesShow } = require('../../scripts/review-factcheck/make-byline-fix-plans.js');
const { parseReviewFilter, matchesReviewFilter, isForcedRefetch, shouldRescoreForcedReplacement } = require('../../scripts/lib/review-filter.js');

// Real rows from data/audit/review-factcheck/web-search-bylines.json (first pass).
const wsj1776 = { showId: '1776-2022', file: 'wsj--charles-isherwood.json', verdict: 'unreachable', status: 401 };
const relSpeaking = { showId: 'relatively-speaking-2011', file: 'variety--charles-isherwood.json', verdict: 'match', status: 200 };

test('a limited recheck keeps the rows it did not fetch (curl pass dropped them)', () => {
  const other = { showId: 'hamilton-2015', file: 'nytimes--ben-brantley.json', verdict: 'unreachable', status: 403 };
  const prev = [wsj1776, relSpeaking, other];
  const fetched = [{ ...wsj1776, verdict: 'match', status: 200, fetchedVia: 'brightdata' }];
  const live = new Set(prev.map(r => `${r.showId}/${r.file}`));
  const out = mergeRecheck(prev, fetched, live, 'unreachable');
  assert.equal(out.length, 3);
  assert.equal(out[0].verdict, 'match');
  assert.deepEqual(out[1], relSpeaking);
  assert.equal(out[2].verdict, 'unreachable');
});

test('a rechecked row that no longer counts on the site stops reading as unreachable', () => {
  const live = new Set([`${relSpeaking.showId}/${relSpeaking.file}`]);
  const out = mergeRecheck([wsj1776, relSpeaking], [], live, 'unreachable');
  assert.equal(out[0].verdict, 'not-live');
  assert.equal(out[1].verdict, 'match');
});

test('text targets: read pages whose stored text is the invented summary or a thin tier, Liaisons forced first', () => {
  const rows = [
    { ...relSpeaking, textLen: 120, contentTier: 'excerpt' }, // invented one-sentence text
    { showId: 'a-2015', file: 'nypost--x.json', verdict: 'different', status: 200, textLen: 5200, contentTier: 'complete' }, // real text already
    { showId: 'b-2015', file: 'nytimes--y.json', verdict: 'unknown', status: 200, textLen: 900, contentTier: 'truncated' },
    { ...wsj1776, textLen: 50, contentTier: 'excerpt' }, // not read
    { showId: 'c-2015', file: 'thr--z.json', verdict: 'off-topic-page', status: 200, textLen: 10, contentTier: 'excerpt' }, // another article
    { showId: 'd-2015', file: 'ew--w.json', verdict: 'match', status: 200 }, // no text fields: undecidable
  ];
  const t = textTargets(rows);
  assert.deepEqual(t, [
    'force:les-liaisons-dangereuses-2016/nytimes--ben-brantley.json',
    'force:relatively-speaking-2011/variety--charles-isherwood.json',
    'force:b-2015/nytimes--y.json',
  ]);
  assert.ok(FORCE_TEXT.includes('les-liaisons-dangereuses-2016/nytimes--ben-brantley.json'));
});

test('REVIEW_FILTER showId/file targets one show only; bare names keep their old any-show meaning', () => {
  const f = parseReviewFilter('relatively-speaking-2011/variety--charles-isherwood.json, nytimes--unknown.json');
  assert.equal(f.size, 2);
  assert.equal(matchesReviewFilter(f, 'relatively-speaking-2011', 'variety--charles-isherwood.json'), true);
  assert.equal(matchesReviewFilter(f, 'talking-cure-2011', 'variety--charles-isherwood.json'), false);
  assert.equal(matchesReviewFilter(f, 'anything-2020', 'nytimes--unknown.json'), true);
  assert.equal(matchesReviewFilter(parseReviewFilter(''), 'x', 'y.json'), true);
});

test('force: entries refetch over existing text and the replacement is rescored (Liaisons NYT had the London review)', () => {
  const f = parseReviewFilter('force:les-liaisons-dangereuses-2016/nytimes--ben-brantley.json');
  assert.equal(matchesReviewFilter(f, 'les-liaisons-dangereuses-2016', 'nytimes--ben-brantley.json'), true);
  assert.equal(isForcedRefetch(f, 'les-liaisons-dangereuses-2016', 'nytimes--ben-brantley.json'), true);
  assert.equal(isForcedRefetch(f, 'les-liaisons-dangereuses-2016', 'variety--x.json'), false);
  const london = 'Donmar Warehouse. '.repeat(200);
  const broadway = 'Booth Theater, Janet McTeer and Liev Schreiber. '.repeat(60);
  assert.equal(shouldRescoreForcedReplacement({ _forceRefetch: true }, london, broadway), true);
  assert.equal(shouldRescoreForcedReplacement({ _forceRefetch: true }, london, london), false, 'same text again');
  assert.equal(shouldRescoreForcedReplacement({ _forceRefetch: false }, london, broadway), false, 'not forced');
  assert.equal(shouldRescoreForcedReplacement({ _forceRefetch: true }, london, 'short'), false, 'not a review-length page');
  assert.equal(shouldRescoreForcedReplacement({ _forceRefetch: true }, london, 'Paywalled Broadway review text. '.repeat(25)), true, 'a short real review still rescores');
});

test('rows a fetchPage pass already tried are not re-fetched first (curl-pass rows are)', () => {
  assert.equal(alreadyTriedByFetchPage(wsj1776), false, 'first curl pass (no fetchedVia)');
  assert.equal(alreadyTriedByFetchPage({ ...wsj1776, fetchedVia: 'curl' }), false);
  assert.equal(alreadyTriedByFetchPage({ ...wsj1776, fetchedVia: 'fetchPage-failed' }), true);
  assert.equal(alreadyTriedByFetchPage({ ...wsj1776, fetchedVia: 'fetchPage-challenge' }), true);
  assert.equal(alreadyTriedByFetchPage({ ...wsj1776, verdict: 'unknown', fetchedVia: 'brightdata' }), true, 'read but still undecided');
});

test('date-fix plans can re-label a provisional dateSource (executor allowlist)', () => {
  const { REVIEW_TEXT_EDITABLE_FIELDS } = require('../../scripts/lib/review-field-edit.js');
  assert.ok(REVIEW_TEXT_EDITABLE_FIELDS.includes('dateSource'));
});

test('plans never repeat BRO-5081 actions or overwrite an applied plan; stale pending plans are replaced', () => {
  const act = (file, newValue) => ({ type: 'review-field-edit', file, field: 'criticName', oldValue: 'X', newValue });
  const existing = [
    { name: 'bro-5081-02.json', plan: { status: 'partial', plan: { actions: [act('arcadia-2011/newsday--linda-winer.json', 'Matt Windman')] } } },
    { name: 'bro-5090-01.json', plan: { status: 'applied', plan: { actions: [act('1776-2022/wsj--charles-isherwood.json', 'Terry Teachout')] } } },
    { name: 'bro-5090-02.json', plan: { status: 'pending', plan: { actions: [act('b/x.json', 'Y Z')] } } },
    { name: '1234.json', plan: { status: 'pending', plan: { actions: [act('c/y.json', 'Q R')] } } },
  ];
  const l = planLedger(existing, 'bro-5090');
  assert.ok(l.seen.has('arcadia-2011/newsday--linda-winer.json|criticName|"Matt Windman"'));
  assert.ok(l.seen.has('1776-2022/wsj--charles-isherwood.json|criticName|"Terry Teachout"'));
  assert.ok(!l.seen.has('b/x.json|criticName|"Y Z"'), 'pending plan of this issue is regenerated, not a ledger entry');
  assert.ok(!l.seen.has('c/y.json|criticName|"Q R"'), 'unrelated plans ignored');
  assert.deepEqual(l.stalePending, ['bro-5090-02.json']);
  assert.equal(l.nextIndex, 2);
  // Symmetric: a bro-5081 run sees bro-5090's plans too.
  const l81 = planLedger(existing, 'bro-5081');
  assert.ok(l81.seen.has('1776-2022/wsj--charles-isherwood.json|criticName|"Terry Teachout"'));
  assert.ok(l81.seen.has('b/x.json|criticName|"Y Z"'), 'another issue\'s pending plan is a ledger entry');
});

test('a url the site answers 404/410 is a dead url, not an unreachable page (invented WaPo urls)', () => {
  assert.equal(unreadVerdict(404), 'dead-url');
  assert.equal(unreadVerdict(410), 'dead-url');
  assert.equal(unreadVerdict(401), 'unreachable', 'WSJ paywall');
  assert.equal(unreadVerdict(403), 'unreachable');
  assert.equal(unreadVerdict(0), 'unreachable', 'timeout / network');
  assert.equal(judgeDate('2006-10-06', null, '2006-10-05', 'dead-url'), 'n/a');
});

test('plans only use rows whose page title names the show (first-pass rows carried no title)', () => {
  // Real first-pass row: Variety's legacy page metadata says Robert Koehler.
  const mermaid = { showId: 'the-little-mermaid-2008', file: 'variety--david-rooney.json', verdict: 'different', bylines: ['Robert Koehler'], url: 'https://variety.com/2008/legit/reviews/the-little-mermaid-1200472087/' };
  assert.equal(pageNamesShow(mermaid), false, 'no page title, no show title: cannot tell');
  assert.equal(pageNamesShow({ ...mermaid, showTitle: 'The Little Mermaid', pageTitle: '' }), false);
  assert.equal(pageNamesShow({ ...mermaid, showTitle: 'Cats', pageTitle: 'Review: Does ‘Cats’ Have Nine Lives on Broadway? Two, Certainly - The New York Times' }), true);
  assert.equal(pageNamesShow({ ...mermaid, showTitle: 'American Buffalo', pageTitle: 'Met Gala 2022: best looks' }), false);
});

test('a bare --retry-fetched flag is true (retry run 38245561879 fetched 0 rows)', () => {
  assert.deepEqual(parseArgs(['--fetcher=fetchpage', '--retry-fetched', '--recheck=unreachable', '--limit=0']),
    { fetcher: 'fetchpage', 'retry-fetched': true, recheck: 'unreachable', limit: '0' });
});
