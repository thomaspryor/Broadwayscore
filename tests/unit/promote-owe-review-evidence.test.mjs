// BRO-4204 S8-T3 — the evidence-backed admin path of the Off-West End
// promoter (scripts/promote-owe-venue-candidates.js) and the --stage-file
// merge it feeds staging through (scripts/lib/owe-venue-staging.js
// mergeCandidates / writeStagingCandidates).
//
// A staged candidate may carry evidence: [{kind:'review-url'|'coverage-url',
// url}]. It is confirmed — the venue page is never consulted for it — when
// at least one evidence URL's host resolves to a registered outlet
// (review-normalization.js resolveOutletFromUrl over the REAL
// data/outlet-registry.json) AND the fetched page's text names the title.
// Fetch failures / unfetched URLs / a page that does not name the title
// HOLD; only "no registered outlet among the evidence" prunes. The S4-T6
// gates still refuse first. Tests the REAL exported functions (CLAUDE.md
// §15) — no logic copies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  decideOffWestEndVenuePromotion,
  decideByReviewEvidence,
  buildOffWestEndVenueShowEntry,
  loadStageFile,
  reviewEvidence,
  resolveEvidenceOutlet,
  foldText,
  pageTextContainsTitle,
  fetchEvidencePage,
  fetchEvidencePages,
  fetchVenueListings,
  evaluateCandidates: evaluateRaw,
  main: mainRaw,
  EVIDENCE_KINDS,
  AUDIT_EVIDENCE_SOURCE,
  DEFAULT_EVIDENCE_FETCH_LIMIT,
} = require('../../scripts/promote-owe-venue-candidates.js');
// Undated rows here sit at venues that now have BRO-4398 dated readers; these
// tests pin the evidence and link-page paths, so run with none configured.
const LINK_ONLY = { datedConfigs: [] };
const evaluateCandidates = (cs, ctx = {}) => evaluateRaw(cs, { ...LINK_ONLY, ...ctx });
const main = (argv, io = {}) => mainRaw(argv, { ...LINK_ONLY, ...io });
const { VENUE_LISTING_PAGES } = require('../../scripts/discover-new-shows.js');
const { candidateHash, loadStaging, writeStagingCandidates, mergeCandidates } = require('../../scripts/lib/owe-venue-staging.js');
const { buildVenueVocabulary } = require('../../scripts/lib/show-title-normalize.js');
const { loadOutletRegistry } = require('../../scripts/lib/review-normalization.js');

const NOW = new Date('2026-09-29T12:00:00Z');
const ALMEIDA = VENUE_LISTING_PAGES.find((p) => p.name === 'Almeida Theatre');
assert.ok(ALMEIDA, 'fixture venue must exist in VENUE_LISTING_PAGES');

// Real registry hosts: london-box-office (T3) and whatsonstage (T2) are
// review outlets; almeida.co.uk is a venue's own site registered as a
// defunct pseudo-outlet; example.org is nobody.
const LBO = 'https://www.londonboxoffice.co.uk/news/post/lost-atoms-lyric-hammersmith-review';
const LBO2 = 'https://www.londonboxoffice.co.uk/news/post/flush-arcola-review';
const WOS = 'https://www.whatsonstage.com/news/cable-street-musical-sets-london-return_1694279/';
const VENUE_SITE = 'https://almeida.co.uk/whats-on/american-psycho-2026/';
const NOBODY = 'https://example.org/reviews/lost-atoms';
const REGISTRY = loadOutletRegistry();
assert.equal(REGISTRY.outlets['almeidacouk'].accessModel, 'defunct', 'fixture assumption: almeida.co.uk is a defunct registry entry');

function candidate(title, venue, extra = {}) {
  const c = { title, venue, category: 'off-west-end', description: '', provisional: true, source: AUDIT_EVIDENCE_SOURCE, discoverySource: AUDIT_EVIDENCE_SOURCE, ...extra };
  c.candidateHash = candidateHash(c);
  return c;
}
const ev = (url, kind = 'review-url') => ({ kind, url });
// evidencePages as fetchEvidencePages() returns them: url → {text|null, error|null}
function pages(byUrl) {
  const m = new Map();
  for (const [url, v] of Object.entries(byUrl)) {
    m.set(url, typeof v === 'string' ? { url, text: v, error: null } : { url, text: null, error: v.error || 'boom' });
  }
  return m;
}
const reviewHtml = (title) => `<html><head><title>Review: ${title.toUpperCase()} at Somewhere</title><script>var x="${title}"</script></head><body><nav>Find a Show</nav><h1>Review: ${title}</h1><p>${title} continues at the venue until 28th February.</p><aside>Latest news: ${title}</aside></body></html>`;

const LONDON_POOL = [
  { id: 'golden-boy-off-west-end-2026', title: 'Golden Boy', venue: 'Almeida Theatre', category: 'off-west-end' },
  { id: 'the-cherry-orchard-riverside-studios-off-west-end-2026', title: 'The Cherry Orchard', venue: 'Riverside Studios', category: 'off-west-end' },
];
function ctxFor(overrides = {}) {
  return {
    existingCandidates: LONDON_POOL.map((r) => ({ ...r })),
    existingIds: new Set(LONDON_POOL.map((r) => r.id)),
    venueVocabulary: buildVenueVocabulary(LONDON_POOL),
    venueListings: new Map(),
    evidencePages: new Map(),
    retiredEntries: [],
    log: () => {},
    logEntry: () => {},
    now: () => NOW,
    ...overrides,
  };
}

// --- reviewEvidence / resolveEvidenceOutlet / foldText / pageTextContainsTitle ---

test('reviewEvidence: keeps only {kind ∈ EVIDENCE_KINDS, url: http(s)} entries, in order', () => {
  assert.deepEqual([...EVIDENCE_KINDS], ['review-url', 'coverage-url']);
  const c = candidate('X', 'Arcola Theatre', { evidence: [
    ev(LBO), 'not-an-object', { kind: 'listing-url', url: WOS }, { kind: 'review-url', url: 'mailto:x@y' },
    { kind: 'coverage-url', url: WOS, outletId: 'whatsonstage' }, { kind: 'review-url' }, null,
  ] });
  assert.deepEqual(reviewEvidence(c), [
    { kind: 'review-url', url: LBO, outletId: null },
    { kind: 'coverage-url', url: WOS, outletId: 'whatsonstage' },
  ]);
  assert.deepEqual(reviewEvidence(candidate('X', 'Arcola Theatre')), []);
  assert.deepEqual(reviewEvidence(null), []);
});

test('resolveEvidenceOutlet: a registered outlet host resolves; an unregistered host and a defunct venue-site entry do not', () => {
  assert.deepEqual(resolveEvidenceOutlet(LBO, REGISTRY), { outletId: 'london-box-office', tier: 2, reason: null }); // T3 -> T2 registry sync (BRO-4930)
  assert.deepEqual(resolveEvidenceOutlet(WOS, REGISTRY), { outletId: 'whatsonstage', tier: 2, reason: null });
  const nobody = resolveEvidenceOutlet(NOBODY, REGISTRY);
  assert.equal(nobody.outletId, null);
  assert.match(nobody.reason, /not a registered outlet/);
  const venue = resolveEvidenceOutlet(VENUE_SITE, REGISTRY);
  assert.equal(venue.outletId, null);
  assert.match(venue.reason, /almeidacouk.*defunct.*venue's own site/);
  assert.equal(resolveEvidenceOutlet('not a url', REGISTRY).outletId, null);
});

test('foldText / pageTextContainsTitle: whole-phrase, folded on both sides, leading article and punctuation kept honest', () => {
  assert.equal(foldText("Les Misérables & Co. — The Musical!"), 'les miserables and co the musical');
  assert.equal(foldText("Daniel's Husband"), 'daniels husband');
  assert.ok(pageTextContainsTitle(reviewHtml('Lost Atoms'), 'Lost Atoms'));
  assert.ok(pageTextContainsTitle(reviewHtml("DANIEL'S HUSBAND"), "Daniel’s Husband"), 'apostrophe variants and case fold');
  assert.ok(pageTextContainsTitle(reviewHtml('Les Misérables'), 'Les Miserables'), 'diacritics fold');
  assert.ok(pageTextContainsTitle('<p>Guess How Much I Love You? runs until Saturday.</p>', 'Guess How Much I Love You?'));
  // Whole-word: "Miles" is not inside "smiles"; the leading "The" is NOT
  // stripped from the needle (normalizeTitle would turn "The Name" into
  // "name", which matches every English page).
  assert.equal(pageTextContainsTitle('<p>Everybody smiles here.</p>', 'Miles'), false);
  assert.equal(pageTextContainsTitle('<p>What is the name of the show?</p>', 'The Name'), true);
  assert.equal(pageTextContainsTitle('<p>Names are given.</p>', 'The Name'), false);
  // Script/style/aside text does not count as page text.
  assert.equal(pageTextContainsTitle('<script>var t="Lost Atoms"</script><aside>Lost Atoms</aside><p>Nothing here.</p>', 'Lost Atoms'), false);
  assert.equal(pageTextContainsTitle(reviewHtml('Lost Atoms'), ''), false);
  assert.equal(pageTextContainsTitle('', 'Lost Atoms'), false);
});

// --- decideOffWestEndVenuePromotion: the evidence branch ---

test('decide: an evidence-backed candidate at a venue OUTSIDE VENUE_LISTING_PAGES is confirmed by a registered outlet page that names it', () => {
  const c = candidate('Flush', 'Arcola Theatre', { evidence: [ev(LBO2)] });
  const r = decideOffWestEndVenuePromotion(c, { evidencePages: pages({ [LBO2]: reviewHtml('Flush') }) });
  assert.equal(r.confirmed, true);
  assert.equal(r.persistent, false);
  assert.equal(r.source, 'review-url');
  assert.equal(r.page, LBO2, 'page is the evidence URL string on this path');
  assert.equal(r.outletId, 'london-box-office');
  assert.match(r.reason, /review-url .* \(registered outlet london-box-office, T2\) names "Flush" on fetch/);
});

test('decide: a coverage-url (announced production) confirms the same way and says so', () => {
  const c = candidate('Cable Street', 'Marylebone Theatre', { evidence: [ev(WOS, 'coverage-url')] });
  const r = decideOffWestEndVenuePromotion(c, { evidencePages: pages({ [WOS]: '<p>Cable Street musical sets London return at Marylebone Theatre.</p>' }) });
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'coverage-url');
  assert.equal(r.outletId, 'whatsonstage');
  assert.match(r.reason, /^coverage-url /);
});

test('decide: the venue page is never consulted for an evidence-backed candidate (a roster venue whose page no longer lists it still confirms)', () => {
  const c = candidate('American Psycho', 'Almeida Theatre', { evidence: [ev(LBO)] });
  const venueListings = new Map([[ALMEIDA.name, { page: ALMEIDA, titles: new Set(['golden boy']), rowCount: 1, error: null }]]);
  const r = decideOffWestEndVenuePromotion(c, { venueListings, evidencePages: pages({ [LBO]: reviewHtml('American Psycho') }) });
  assert.equal(r.confirmed, true);
  assert.equal(r.source, 'review-url');
  // ...and without its evidence the same candidate would have been pruned by the venue page.
  const bare = decideOffWestEndVenuePromotion(candidate('American Psycho', 'Almeida Theatre'), { venueListings });
  assert.equal(bare.confirmed, false);
  assert.equal(bare.persistent, true);
});

test('decide: only "no evidence URL resolves to a registered outlet" is persistent; unfetched / failed / title-missing HOLD', () => {
  const nobody = decideOffWestEndVenuePromotion(candidate('Flush', 'Arcola Theatre', { evidence: [ev(NOBODY), ev(VENUE_SITE)] }), { evidencePages: pages({ [NOBODY]: reviewHtml('Flush'), [VENUE_SITE]: reviewHtml('Flush') }) });
  assert.equal(nobody.confirmed, false);
  assert.equal(nobody.persistent, true);
  assert.match(nobody.reason, /none of the 2 evidence URL\(s\) resolves to a registered outlet/);
  assert.match(nobody.reason, /defunct/);

  const unfetched = decideOffWestEndVenuePromotion(candidate('Flush', 'Arcola Theatre', { evidence: [ev(LBO2)] }), { evidencePages: new Map() });
  assert.equal(unfetched.confirmed, false);
  assert.equal(unfetched.persistent, false);
  assert.match(unfetched.reason, /not fetched this run/);

  const failed = decideOffWestEndVenuePromotion(candidate('Flush', 'Arcola Theatre', { evidence: [ev(LBO2)] }), { evidencePages: pages({ [LBO2]: { error: 'HTTP 403' } }) });
  assert.equal(failed.persistent, false);
  assert.match(failed.reason, /fetch failed \(HTTP 403\)/);

  const missing = decideOffWestEndVenuePromotion(candidate('Flush', 'Arcola Theatre', { evidence: [ev(LBO2)] }), { evidencePages: pages({ [LBO2]: '<p>Please subscribe to continue reading.</p>' }) });
  assert.equal(missing.confirmed, false);
  assert.equal(missing.persistent, false, 'a paywall/interstitial must never prune a hand-prepared row');
  assert.match(missing.reason, /does not name "Flush"/);
});

test('decide: evidence is walked in order — an unregistered or failed first URL does not stop a later one from confirming', () => {
  const c = candidate('Flush', 'Arcola Theatre', { evidence: [ev(NOBODY), ev(LBO), ev(LBO2)] });
  const r = decideOffWestEndVenuePromotion(c, { evidencePages: pages({ [NOBODY]: reviewHtml('Flush'), [LBO]: { error: 'timeout' }, [LBO2]: reviewHtml('Flush') }) });
  assert.equal(r.confirmed, true);
  assert.equal(r.page, LBO2);
  // decideByReviewEvidence is the same function decideOffWestEndVenuePromotion delegates to.
  const direct = decideByReviewEvidence(c, reviewEvidence(c), pages({ [LBO2]: reviewHtml('Flush') }), REGISTRY);
  assert.equal(direct.confirmed, true);
  assert.equal(direct.page, LBO2);
});

test('decide: the S4-T6 gates still refuse an evidence-backed candidate before any evidence is read', () => {
  const good = pages({ [LBO]: reviewHtml('Sylvia') + reviewHtml('The Karate Kid') + reviewHtml('Jazz Festival') });
  const cases = [
    [candidate('Sylvia', 'Royal Albert Hall', { evidence: [ev(LBO)] }), /NON_THEATRE_VENUE_RE/],
    [candidate('The Karate Kid', 'New Wimbledon Theatre', { evidence: [ev(LBO)] }), /receiving house/],
    [candidate('Jazz Festival', 'Arcola Theatre', { evidence: [ev(LBO)] }), /London ingest gate/],
    [candidate('?tab=dates', 'Arcola Theatre', { evidence: [ev(LBO)] }), /URL fragment/],
  ];
  for (const [c, re] of cases) {
    const r = decideOffWestEndVenuePromotion(c, { evidencePages: good });
    assert.equal(r.confirmed, false, c.title);
    assert.equal(r.persistent, true, c.title);
    assert.match(r.reason, re, c.title);
  }
});

// --- buildOffWestEndVenueShowEntry on the evidence path ---

test('build: an evidence-backed candidate is stamped audit-review-evidence + evidenceUrls, with its dates driving status/type and an explicit type honoured', () => {
  const vocab = buildVenueVocabulary(LONDON_POOL);
  const closed = buildOffWestEndVenueShowEntry(candidate('Ancient Grease', 'The Vaults Theatre', {
    evidence: [ev(LBO), ev(LBO), ev(WOS, 'coverage-url')],
    previewsStartDate: '2026-03-04', closingDate: '2026-05-30', type: 'musical',
  }), vocab, { now: NOW });
  assert.equal(closed.id, 'ancient-grease-off-west-end-2026');
  assert.equal(closed.discoverySource, AUDIT_EVIDENCE_SOURCE);
  assert.deepEqual(closed.evidenceUrls, [LBO, WOS], 'deduplicated, in order');
  assert.equal(closed.status, 'closed');
  assert.equal(closed.type, 'musical', 'explicit type wins over the title heuristic');
  assert.equal(closed.openingDate, null);
  assert.equal(closed.openingDateSource, null);
  assert.equal(closed.provisional, true);
  assert.equal(closed.category, 'off-west-end');
  assert.equal(closed.market, 'west-end');

  const opened = buildOffWestEndVenueShowEntry(candidate('Who Killed Marilyn?', 'Emerald Theatre', {
    evidence: [ev(LBO)], previewsStartDate: '2026-08-15', openingDate: '2026-08-21', closingDate: '2026-10-29',
  }), vocab, { now: NOW });
  assert.equal(opened.status, 'open');
  assert.equal(opened.type, 'play');
  assert.equal(opened.openingDateSource, AUDIT_EVIDENCE_SOURCE, 'dates are credited to the evidence path, not a venue page');

  const upcoming = buildOffWestEndVenueShowEntry(candidate('Peter Pan', 'Polka Theatre', {
    evidence: [ev(WOS, 'coverage-url')], previewsStartDate: '2026-11-14', closingDate: '2027-01-24', type: 'ballet',
  }), vocab, { now: NOW });
  assert.equal(upcoming.status, 'upcoming');
  assert.equal(upcoming.type, 'play', 'an unknown type falls back to the heuristic');

  const dateless = buildOffWestEndVenueShowEntry(candidate('Stick Man', 'Bloomsbury Theatre', { evidence: [ev(LBO)] }), vocab, { now: NOW });
  assert.equal(dateless.status, 'announced');
  assert.equal(dateless.type, null);
  assert.equal(dateless.discoverySource, AUDIT_EVIDENCE_SOURCE);

  // The venue-page path is unchanged: no evidence → no evidenceUrls, venue-page provenance.
  const venuePage = buildOffWestEndVenueShowEntry({ title: 'Triumph', venue: 'Almeida Theatre', category: 'off-west-end', source: 'venue-page:almeida-theatre', openingDate: '2026-09-10' }, vocab, { now: NOW });
  assert.equal(venuePage.discoverySource, 'venue-page:almeida-theatre');
  assert.equal(venuePage.openingDateSource, 'venue-page');
  assert.equal('evidenceUrls' in venuePage, false);
});

// --- fetchEvidencePage(s) + the venue-fetch skip ---

test('fetchEvidencePage: reduces the fetched page to text through fetchPage(); a throw or empty body is reported, never thrown', async () => {
  const ok = await fetchEvidencePage(LBO, { fetchPage: async (url, opts) => { assert.equal(url, LBO); assert.equal(opts.renderJs, false); return { content: reviewHtml('Lost Atoms') }; }, log: () => {} });
  assert.equal(ok.error, null);
  assert.match(ok.text, /Lost Atoms continues at the venue/);
  assert.doesNotMatch(ok.text, /<p>|var x=/, 'tags and scripts stripped');
  const threw = await fetchEvidencePage(LBO, { fetchPage: async () => { throw new Error('All scraping methods failed'); }, log: () => {} });
  assert.equal(threw.text, null);
  assert.match(threw.error, /All scraping methods failed/);
  const empty = await fetchEvidencePage(LBO, { fetchPage: async () => ({ content: '' }), log: () => {} });
  assert.equal(empty.error, 'empty response');
});

test('fetchEvidencePages: one fetch per distinct registered-outlet URL, none for unregistered/defunct hosts, bounded by --evidence-limit', async () => {
  const fetched = [];
  const fetchPage = async (url) => { fetched.push(url); return { content: reviewHtml('x') }; };
  const cands = [
    candidate('A', 'Arcola Theatre', { evidence: [ev(LBO), ev(NOBODY)] }),
    candidate('B', 'Arcola Theatre', { evidence: [ev(LBO), ev(VENUE_SITE), ev(WOS, 'coverage-url')] }),
    candidate('C', 'Almeida Theatre'),
    candidate('D', 'Arcola Theatre', { evidence: [ev(LBO2)] }),
  ];
  const all = await fetchEvidencePages(cands, { fetchPage, log: () => {} });
  assert.deepEqual(fetched, [LBO, WOS, LBO2]);
  assert.deepEqual([...all.keys()], [LBO, WOS, LBO2]);
  fetched.length = 0;
  const capped = await fetchEvidencePages(cands, { fetchPage, limit: 2, log: () => {} });
  assert.deepEqual(fetched, [LBO, WOS]);
  assert.ok(!capped.has(LBO2), 'the third URL is left unfetched → its candidate is held, not pruned');
  assert.equal(DEFAULT_EVIDENCE_FETCH_LIMIT, 60);
});

test('fetchVenueListings: an evidence-backed candidate at a roster venue costs no venue-page fetch', async () => {
  const fetched = [];
  const fetchPage = async (url) => { fetched.push(url); return { content: '<html><body>' + 'x'.repeat(1300) + '</body></html>' }; };
  await fetchVenueListings([candidate('American Psycho', 'Almeida Theatre', { evidence: [ev(LBO)] })], { fetchPage, log: () => {} });
  assert.deepEqual(fetched, []);
  await fetchVenueListings([candidate('Triumph', 'Almeida Theatre')], { fetchPage, log: () => {} });
  assert.deepEqual(fetched, [ALMEIDA.url]);
});

// --- evaluateCandidates ---

test('evaluateCandidates: evidence-backed candidates are promoted with the evidence URL as sourceUrl; dedup and gates still apply', async () => {
  const cands = [
    candidate('The Cherry Orchard', 'Riverside Studios', { evidence: [ev(LBO)] }),   // already in shows.json → pruned as duplicate, no evidence needed
    candidate('Flush', 'Arcola Theatre', { evidence: [ev(LBO2)], previewsStartDate: '2026-05-06', openingDate: '2026-05-08', closingDate: '2026-06-06' }),
    candidate('Lost Atoms', 'Lyric Hammersmith', { evidence: [ev(LBO)] }),           // fetch failed → held
    candidate('Sylvia', 'Royal Albert Hall', { evidence: [ev(LBO2)] }),              // gate → pruned
    candidate('Nobody Home', 'Arcola Theatre', { evidence: [ev(NOBODY)] }),          // unregistered → pruned
  ];
  const entries = [];
  const ctx = ctxFor({ evidencePages: pages({ [LBO2]: reviewHtml('Flush') + reviewHtml('Sylvia'), [LBO]: { error: 'HTTP 503' } }), logEntry: (e) => entries.push(e) });
  const { promoted, held, pruned } = await evaluateCandidates(cands, ctx);
  assert.deepEqual(promoted.map((p) => p.entry.id), ['flush-off-west-end-2026']);
  assert.equal(promoted[0].sourceUrl, LBO2);
  assert.equal(promoted[0].entry.status, 'closed');
  assert.equal(promoted[0].entry.discoverySource, AUDIT_EVIDENCE_SOURCE);
  assert.deepEqual(promoted[0].entry.evidenceUrls, [LBO2]);
  assert.ok(ctx.existingIds.has('flush-off-west-end-2026'));
  const kinds = Object.fromEntries(pruned.map((p) => [p.candidate.title, p.kind]));
  assert.deepEqual(kinds, { 'The Cherry Orchard': 'skip-duplicate', Flush: 'promote', Sylvia: 'skip-unconfirmed', 'Nobody Home': 'skip-unconfirmed' });
  assert.deepEqual(held.map((h) => [h.candidate.title, h.kind]), [['Lost Atoms', 'skip-unconfirmed']]);
  assert.match(held[0].reason, /HTTP 503/);
  assert.ok(!entries.some((e) => e.kind === 'promote'), 'the promote audit line is deferred to main()');
});

// --- loadStageFile / mergeCandidates ---

function scratchDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'owe-evidence-')); }

test('loadStageFile: normalises valid rows (category, source defaults, trimmed strings) and refuses a file with any bad row, naming it', () => {
  const dir = scratchDir();
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify([
    { title: ' Flush ', venue: 'Arcola Theatre ', previewsStartDate: '2026-05-06', closingDate: '2026-06-06', evidence: [ev(LBO2)] },
    { title: 'Triumph', venue: 'Almeida Theatre', source: 'venue-page:almeida-theatre', openingDate: null },
  ]));
  const rows = loadStageFile(good);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Flush');
  assert.equal(rows[0].venue, 'Arcola Theatre');
  assert.equal(rows[0].category, 'off-west-end');
  assert.equal(rows[0].source, AUDIT_EVIDENCE_SOURCE);
  assert.equal(rows[0].discoverySource, AUDIT_EVIDENCE_SOURCE);
  assert.equal(rows[0].provisional, true);
  assert.equal(rows[1].source, 'venue-page:almeida-theatre', 'an explicit source is kept');

  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify([
    { title: 'Flush', venue: 'Arcola Theatre', evidence: [ev(LBO2)] },
    { title: '', venue: 'Arcola Theatre' },
    { title: 'Nope', venue: 'Arcola Theatre', category: 'west-end', openingDate: '2026-13-40', type: 'ballet', evidence: [{ kind: 'listing-url', url: 'ftp://x' }] },
    'junk',
  ]));
  assert.throws(() => loadStageFile(bad), (e) => {
    assert.match(e.message, /7 problem\(s\), nothing merged/);
    assert.match(e.message, /row 1: missing title/);
    assert.match(e.message, /row 2 \("Nope"\): category must be off-west-end/);
    assert.match(e.message, /row 2 \("Nope"\): openingDate must be YYYY-MM-DD/);
    assert.match(e.message, /row 2 \("Nope"\): type must be one of/);
    assert.match(e.message, /evidence\[0\]\.kind must be one of review-url\|coverage-url/);
    assert.match(e.message, /evidence\[0\]\.url must be an http\(s\) URL/);
    assert.match(e.message, /row 3: not an object/);
    return true;
  });
  fs.writeFileSync(path.join(dir, 'obj.json'), '{"title":"x"}');
  assert.throws(() => loadStageFile(path.join(dir, 'obj.json')), /expected a JSON array/);
  assert.throws(() => loadStageFile(path.join(dir, 'missing.json')), /--stage-file .*missing\.json/);
});

test('mergeCandidates: pure upsert by candidateHash — replaces a same-hash entry, appends new ones, never mutates the input', () => {
  const existing = [{ ...candidate('Golden Boy', 'Almeida Theatre', { source: 'venue-page:almeida-theatre', discoveredAt: '2026-09-01T00:00:00.000Z' }) }];
  const snapshot = JSON.stringify(existing);
  const merged = mergeCandidates(existing, [
    { title: 'Golden Boy', venue: 'Almeida Theatre', evidence: [ev(LBO)], source: AUDIT_EVIDENCE_SOURCE },
    { title: 'Flush', venue: 'Arcola Theatre', evidence: [ev(LBO2)] },
  ], { now: NOW });
  assert.equal(JSON.stringify(existing), snapshot, 'input untouched');
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].evidence, [ev(LBO)], 'same-hash entry replaced (evidence refreshed)');
  assert.equal(merged[0].candidateHash, candidateHash({ title: 'Golden Boy', venue: 'Almeida Theatre' }));
  assert.equal(merged[1].title, 'Flush');
  assert.equal(merged[1].candidateHash, candidateHash({ title: 'Flush', venue: 'Arcola Theatre' }));
  assert.equal(merged[1].discoveredAt, NOW.toISOString());
  assert.equal(merged[1].source, null, 'mergeCandidates does not invent a source; loadStageFile sets it for stage-file rows');
});

// --- main(): --stage-file / --stage-only end to end on scratch files ---

function scratchRepo() {
  const dir = scratchDir();
  const showsPath = path.join(dir, 'shows.json');
  const stagingPath = path.join(dir, 'owe-venue-candidates.json');
  const lastPromotionFile = path.join(dir, 'owe-last-promotion-ids.json');
  const stageFile = path.join(dir, 'additions.json');
  const shows = { _meta: { totalShows: LONDON_POOL.length }, shows: LONDON_POOL.map((r) => ({ ...r, slug: r.id.replace(/-\d{4}$/, ''), status: 'open', market: 'west-end' })) };
  fs.writeFileSync(showsPath, JSON.stringify(shows, null, 2) + '\n');
  writeStagingCandidates([candidate('Stuffed', 'Kiln Theatre', { source: 'venue-page:kiln-theatre', discoverySource: 'venue-page:kiln-theatre' })], stagingPath);
  fs.writeFileSync(stageFile, JSON.stringify([
    { title: 'Flush', venue: 'Arcola Theatre', previewsStartDate: '2026-05-06', openingDate: '2026-05-08', closingDate: '2026-06-06', evidence: [ev(LBO2)] },
    { title: 'Lost Atoms', venue: 'Lyric Hammersmith', previewsStartDate: '2026-01-29', closingDate: '2026-02-28', evidence: [ev(LBO)] },
    { title: 'The Cherry Orchard', venue: 'Riverside Studios', evidence: [ev(LBO)] },
  ], null, 2));
  return { dir, showsPath, stagingPath, lastPromotionFile, stageFile };
}
const scratchIo = (paths, extra = {}) => ({
  showsPath: paths.showsPath, stagingPath: paths.stagingPath, lastPromotionFile: paths.lastPromotionFile,
  retiredEntries: [],
  log: () => {},
  logEntry: () => {},
  now: () => NOW,
  fetchPage: async (url) => {
    if (url === LBO2) return { content: reviewHtml('Flush') };
    throw new Error('HTTP 403');
  },
  ...extra,
});

test('main --dry-run --stage-file: merges in memory, evaluates the union, writes NOTHING (staging, shows.json, state file untouched)', async () => {
  const paths = scratchRepo();
  const before = { shows: fs.readFileSync(paths.showsPath, 'utf8'), staging: fs.readFileSync(paths.stagingPath, 'utf8') };
  const res = await main(['--dry-run', `--stage-file=${paths.stageFile}`], scratchIo(paths));
  assert.equal(res.dryRun, true);
  assert.deepEqual(res.promoted.map((p) => p.entry.id), ['flush-off-west-end-2026']);
  assert.equal(res.promoted[0].sourceUrl, LBO2);
  assert.deepEqual(res.held.map((h) => h.candidate.title).sort(), ['Lost Atoms', 'Stuffed'], 'evidence fetch failure and the unfetched venue page both hold');
  assert.deepEqual(res.pruned.filter((p) => p.kind === 'skip-duplicate').map((p) => p.candidate.title), ['The Cherry Orchard']);
  assert.equal(fs.readFileSync(paths.showsPath, 'utf8'), before.shows);
  assert.equal(fs.readFileSync(paths.stagingPath, 'utf8'), before.staging, 'the in-memory merge never reached the staging file');
  assert.ok(!fs.existsSync(paths.lastPromotionFile));
});

test('main --stage-file --stage-only: merges through the locked upsert and exits without fetching; --stage-only alone is refused', async () => {
  const paths = scratchRepo();
  let fetches = 0;
  const res = await main([`--stage-file=${paths.stageFile}`, '--stage-only'], scratchIo(paths, { fetchPage: async () => { fetches++; throw new Error('should not fetch'); } }));
  assert.equal(res.stageOnly, true);
  assert.equal(fetches, 0);
  assert.equal(res.staged, 4);
  const staged = loadStaging(paths.stagingPath);
  assert.deepEqual(staged.map((c) => c.title), ['Stuffed', 'Flush', 'Lost Atoms', 'The Cherry Orchard']);
  const flush = staged.find((c) => c.title === 'Flush');
  assert.equal(flush.candidateHash, candidateHash({ title: 'Flush', venue: 'Arcola Theatre' }));
  assert.equal(flush.source, AUDIT_EVIDENCE_SOURCE);
  assert.deepEqual(flush.evidence, [ev(LBO2)]);
  assert.ok(!fs.existsSync(`${paths.stagingPath}.lock`), 'staging lock released');
  assert.ok(!fs.existsSync(paths.lastPromotionFile), 'no evaluation → no state file');
  // Idempotent: a second merge of the same file changes nothing but discoveredAt.
  await main([`--stage-file=${paths.stageFile}`, '--stage-only'], scratchIo(paths));
  assert.equal(loadStaging(paths.stagingPath).length, 4);
  await assert.rejects(() => main(['--stage-only'], scratchIo(paths)), /--stage-only requires --stage-file/);
  // A bad file merges nothing.
  fs.writeFileSync(paths.stageFile, JSON.stringify([{ title: 'Nope', venue: '' }]));
  await assert.rejects(() => main([`--stage-file=${paths.stageFile}`, '--stage-only'], scratchIo(paths)), /row 0 \("Nope"\): missing venue/);
  assert.equal(loadStaging(paths.stagingPath).length, 4);
});

test('main --stage-file (real run): the merged evidence row lands via the write guard, promoted + duplicate leave staging, the held rows stay', async () => {
  const paths = scratchRepo();
  const entries = [];
  const res = await main([`--stage-file=${paths.stageFile}`], scratchIo(paths, { logEntry: (e) => entries.push(e) }));
  assert.deepEqual(res.promoted.map((p) => p.entry.id), ['flush-off-west-end-2026']);
  const shows = JSON.parse(fs.readFileSync(paths.showsPath, 'utf8'));
  const row = shows.shows.find((s) => s.id === 'flush-off-west-end-2026');
  assert.ok(row, 'promoted row written');
  assert.equal(row.status, 'closed');
  assert.equal(row.type, 'play');
  assert.equal(row.discoverySource, AUDIT_EVIDENCE_SOURCE);
  assert.equal(row.openingDate, '2026-05-08');
  assert.equal(row.openingDateSource, AUDIT_EVIDENCE_SOURCE);
  assert.deepEqual(row.evidenceUrls, [LBO2]);
  assert.equal(row.provisional, true);
  assert.equal(shows._meta.totalShows, LONDON_POOL.length + 1, 'written through shows-write-guard');
  assert.deepEqual(loadStaging(paths.stagingPath).map((c) => c.title).sort(), ['Lost Atoms', 'Stuffed'], 'promoted + duplicate pruned; held rows remain');
  const state = JSON.parse(fs.readFileSync(paths.lastPromotionFile, 'utf8'));
  assert.deepEqual(state.promoted, [{ id: 'flush-off-west-end-2026', source: AUDIT_EVIDENCE_SOURCE, sourceUrl: LBO2 }]);
  assert.ok(entries.some((e) => e.kind === 'promote' && e.id === 'flush-off-west-end-2026' && e.sourceUrl === LBO2));
});
