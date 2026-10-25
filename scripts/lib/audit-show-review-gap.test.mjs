import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { currentRunUncollected } = require('./audit-show-review-gap');
const { classifyGapCandidateUrl } = require('./non-review-url-patterns');
const { syndicatedReprintOf } = require('./syndicated-reprint-match');
const { gapDisclosureDecisions } = require('./newsletter-preflight');

const URL = 'https://www.theguardian.com/stage/2026/oct/05/de-profundis-review-oscar-wilde-coronet-theatre-london';
const row = (result) => ({ showId: 'rose-kingston', missing: [{ url: URL }], ingestResults: [result] });

test('a confirmed reroute is resolved for its source show even if the destination merge fails', () => {
  const result = { url: URL, ok: false, reason: '⚠️  Cross-market reroute: rose-kingston → southwark (same-title-sibling: publish-date)\n❌ Stale merge: fullText still holds a pre-existing value' };
  assert.equal(currentRunUncollected(row(result)), 0);
  assert.equal(currentRunUncollected({ ...row(result), showId: 'southwark' }), 1);
});

test('truncated, same-show and unconfirmed reroutes stay visible', () => {
  for (const reason of [
    'Cross-market reroute: rose-kingston',
    'Cross-market reroute: rose-kingston → rose-kingston (unchanged)',
    'Cross-market reroute failed: no sibling found',
  ]) assert.equal(currentRunUncollected(row({ url: URL, reason })), 1, reason);
});

test('legacy permanent reasons resolve without an expected flag', () => {
  for (const reason of [
    'Skipped: timeout-listing-capsule: not a full review',
    'timeout-listing-capsule',
    'unknown-outlet-aggregator-host (theatre.reviews)',
    'syndicated-reprint',
  ]) assert.equal(currentRunUncollected(row({ url: URL, ok: false, reason })), 0, reason);
});

test('structured expected reasons resolve and conflicts or unknown failures remain gaps', () => {
  assert.equal(currentRunUncollected(row({ url: URL, expectedReason: 'timeout-listing-capsule' })), 0);
  assert.equal(currentRunUncollected(row({ url: URL, expected: true })), 0);
  assert.equal(currentRunUncollected(row({ url: URL, ok: true })), 0);
  for (const result of [
    { reason: 'Fetch failed: All scraping methods failed' },
    { reason: 'some-future-reason', unclassified: true },
    { reason: 'unknown-outlet-no-host' },
    { conflict: true, conflictReason: 'cross-show-url-owned' },
    { conflict: true, conflictReason: 'aggregator-url-mismatch' },
  ]) assert.equal(currentRunUncollected(row({ url: URL, ...result })), 1);
});

test('the result must belong to the missing URL', () => {
  assert.equal(currentRunUncollected(row({ url: 'https://other.example/review', expected: true })), 1);
});

test('newsletter banner uses the filtered checkpoint count and preserves real gaps', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const source = row({ url: URL, reason: 'Cross-market reroute: rose-kingston → southwark (publish-date)' });
  const opening = { id: source.showId, title: 'Jane Eyre' };
  const checkpoint = r => ({ [opening.id]: { at: new Date(now).toISOString(), uncollected: currentRunUncollected(r) } });
  assert.deepEqual(gapDisclosureDecisions([opening], checkpoint(source), now).gapped, []);
  const stillMissing = { ...source, missing: [...source.missing, { url: 'https://real.example/review' }] };
  const disclosure = gapDisclosureDecisions([opening], checkpoint(stillMissing), now);
  assert.equal(disclosure.gapped[0].uncollected, 1);
  assert.match(disclosure.notes[0], /missing 1 review/);
});

test('listing and production sites are filtered while editorial reviews remain candidates', () => {
  for (const url of [
    'https://shouldgoto.com/theatre/berliner-ensemble-de-profundis-by-oscar-wilde',
    'https://www.berliner-ensemble.de/en/production/de-profundis',
    'https://theatre.reviews/reviews-roundup/whos-afraid-of-virginia-woolf-sohoplace-reviews/',
  ]) {
    assert.equal(classifyGapCandidateUrl(url).ok, false, url);
    assert.equal(currentRunUncollected({ missing: [{ url }] }), 0, url);
  }
  for (const url of [URL, 'https://www.londonboxoffice.co.uk/news/post/jane-eyre-review']) {
    assert.equal(classifyGapCandidateUrl(url).ok, true, url);
    assert.equal(currentRunUncollected({ missing: [{ url }] }), 1, url);
  }
});

test('prior-run citations stay report-only and current citations without URLs stay gaps', () => {
  assert.equal(currentRunUncollected({
    missing: [{ url: URL, priorRun: true }, { url: 'https://timeout.com/newyork/theater/the-ask', priorRun: true }],
    citedNoUrl: [{ outlet: 'exeunt', priorRun: true }, { outlet: 'collectable' }],
  }), 1);
});

test('census holds, blocklists and successful ingests share the same count', () => {
  const r = {
    missing: [
      { url: URL, serpCensus: true }, { url: 'https://real.example/review' },
      { url: 'https://blocked.example/review' }, { url: 'https://held.example/review' },
    ],
    weIngestBlocked: [{ url: URL, reason: 'we-gate-off', censusGateOn: false }],
    ingestResults: [{ url: 'https://held.example/review', ok: true }],
  };
  const options = { isCollectable: m => !m.url.includes('blocked.example') };
  assert.equal(currentRunUncollected(r, options), 1);
  assert.equal(currentRunUncollected({ ...r, weIngestBlocked: [] }, options), 2);
  assert.equal(currentRunUncollected({ ...r, weIngestBlocked: [] }, { ...options, ignoreCensusTagged: true }), 1);
});

test('syndicated headline identity tolerates a moved Review label but requires held evidence', () => {
  const candidateUrl = 'https://www.aol.co.uk/articles/profundis-review-oscar-wilde-brought-122622000.html';
  const guardian = { url: URL, fullText: 'Review De Profundis: Oscar Wilde brought to life in a mesmerising performance' };
  const heldFiles = [guardian, ...Array.from({ length: 5 }, (_, i) => ({
    url: `https://outlet${i}.example/review`, fullText: 'De Profundis by Oscar Wilde at the Coronet Theatre. Another interpretation.',
  }))];
  const match = syndicatedReprintOf({ candidateUrl, heldFiles, showTitle: 'De Profundis' });
  assert.equal(match.dup, true);
  assert.equal(match.matchedUrl, URL);
  assert.equal(syndicatedReprintOf({ candidateUrl, heldFiles: heldFiles.slice(1), showTitle: 'De Profundis' }).dup, false);
  assert.equal(syndicatedReprintOf({ candidateUrl, heldFiles: [guardian], showTitle: 'De Profundis' }).dup, false);
  const reordered = { ...guardian, fullText: 'Review De Profundis Oscar Wilde. A different critic brought fresh ideas.' };
  assert.equal(syndicatedReprintOf({ candidateUrl, heldFiles: [reordered, ...heldFiles.slice(1)], showTitle: 'De Profundis' }).dup, false);
  // A second matching headline makes the relaxed match ambiguous.
  assert.equal(syndicatedReprintOf({ candidateUrl, heldFiles: [...heldFiles, { ...guardian, url: 'https://other.example/review' }], showTitle: 'De Profundis' }).dup, false);
});

// BRO-5627: the-ask-off-broadway-2026 (revival of a Sept 2024 run) ingested a
// dateless 2024 New Yorker capsule and a WSJ careers column matched on "ask".
const { earlierDatedCitation, gapIngestRequiresPublishDate } = require('./audit-show-review-gap');
const { classifyIngestSkip } = require('./ingest-skip-classify');
const { titleMatchesShow } = require('./rss-discovery');
const fs = require('node:fs');
const path = require('node:path');

const ASK = { id: 'the-ask-off-broadway-2026', title: 'The Ask', previewsStartDate: '2026-10-06', openingDate: '2026-10-13' };
const askRow = {
  showId: ASK.id,
  missing: [
    { url: 'https://www.theatrely.com/post/generations-collide-in-the-ask-review', priorRun: true, priorRunSource: 'pending-file-date:2024-09-21' },
    { url: 'https://www.newyorker.com/goings-on-about-town/the-ask' },
  ],
  flaggedMisses: [],
};

test('BRO-5627 an earlier-dated citation is evidence; a fresh show has none', () => {
  assert.equal(earlierDatedCitation(askRow, ASK), 'prior-run-citation:pending-file-date:2024-09-21');
  assert.equal(earlierDatedCitation({ missing: [{ url: 'https://x.example/r' }], flaggedMisses: [] }, ASK), null);
  assert.match(earlierDatedCitation({ priorRunArticles: [{ url: 'https://bww.example/rr', publishDate: '2024-09-16' }] }, ASK), /^prior-run-article:2024-09-16/);
  assert.equal(earlierDatedCitation({}, { ...ASK, priorRuns: [{ start: '2024-09-01', end: '2024-10-20' }] }), 'declared-prior-run');
  // A held review dated 180+ days before previews counts; a preview feature
  // weeks or months ahead (2026-07-01, 97 days) does not.
  assert.equal(earlierDatedCitation({}, ASK, { heldDates: ['2026-10-16', null, '2024-09-16'] }), 'held-review-dated:2024-09-16');
  assert.equal(earlierDatedCitation({}, ASK, { heldDates: ['2026-07-01', '2026-09-20', '2026-10-16', undefined] }), null);
  assert.equal(earlierDatedCitation({}, { id: 'x', title: 'X' }, { heldDates: ['2001-01-01'] }), null);
});

test('BRO-5627 a gap ingest must resolve a publish date under evidence or a dateless-only citation', () => {
  const evidence = earlierDatedCitation(askRow, ASK);
  assert.equal(gapIngestRequiresPublishDate(askRow.missing[1], evidence), true);
  assert.equal(gapIngestRequiresPublishDate({ url: 'https://x.example/r' }, null), false);
  // articleRunIdentity fail-open: cited only by an undated aggregator article.
  assert.equal(gapIngestRequiresPublishDate({ url: 'https://x.example/r', datelessCitationOnly: true }, null), true);
});

test('BRO-5627 the dateless refusal is an expected rejection that resolves the gap row', () => {
  const u = 'https://www.newyorker.com/goings-on-about-town/the-ask';
  const skip = classifyIngestSkip(`⚠️  Skipped: publish-date-unresolved — no publish date on the page and --require-publish-date is set — ${u}`);
  assert.deepEqual([skip.kind, skip.reason], ['expected', 'publish-date-unresolved']);
  const r = { showId: ASK.id, missing: [{ url: u }], ingestResults: [{ url: u, ok: false, noop: true, expected: true, expectedReason: skip.reason }] };
  assert.equal(currentRunUncollected(r), 0);
});

test('BRO-5627 the audit passes --require-publish-date and the ingest script emits the classified skip', () => {
  const root = path.join(path.dirname(require.resolve('./audit-show-review-gap')), '..');
  const ingest = fs.readFileSync(path.join(root, 'ingest-review-from-url.js'), 'utf8');
  const audit = fs.readFileSync(path.join(root, 'audit-show-review-gap.js'), 'utf8');
  assert.match(ingest, /hasFlag\('require-publish-date'\)/);
  assert.match(ingest, /Skipped: publish-date-unresolved/);
  assert.match(audit, /args\.push\('--require-publish-date'\)/);
  assert.match(audit, /iargs\.push\('--require-publish-date'\)/);
  assert.match(audit, /ingestMissingUrl\(r\.showId, m\.url, m\.knownOutletId, \{ requirePublishDate: gapIngestRequiresPublishDate\(m, earlierEvidence\), show: s \}\)/);
});

test('BRO-5627 an article + one-word title needs the whole title, a quote, or "review" beside it', () => {
  assert.equal(titleMatchesShow('How to Ask Colleagues to Agree to Your Requests', 'The Ask'), false);
  assert.equal(titleMatchesShow('Ask Ariely: Should I tip the barista?', 'The Ask'), false);
  for (const h of [
    'Review: ‘The Ask’ pits a liberal donor against an ACLU lawyer',
    'Generations collide in The Ask',
    'In “Ask,” a donor squirms',
    'Ask review: philanthropy satire at Theater 555',
  ]) assert.equal(titleMatchesShow(h, 'The Ask'), true, h);
  assert.equal(titleMatchesShow("Chita Rivera stars in Kander and Ebb's 'The Visit.'", 'The Visit'), true);
  // Untouched: bare one-word titles and titles whose other words are just short.
  assert.equal(titleMatchesShow('Wicked turns 20 on Broadway', 'Wicked'), true);
  assert.equal(titleMatchesShow("New 'King and I' is something wonderful", 'The King and I'), true);
});

test('BRO-5627: "The X" RSS gate keeps theatre-context headlines that drop the article', () => {
  const { titleMatchesShow } = require('./rss-discovery');
  assert.equal(titleMatchesShow('Outsiders musical wins best musical Tony', 'The Outsiders'), true);
  assert.equal(titleMatchesShow('Notebook musical opens on Broadway', 'The Notebook'), true);
  assert.equal(titleMatchesShow('How to Ask Colleagues for a Raise', 'The Ask'), false);
});
