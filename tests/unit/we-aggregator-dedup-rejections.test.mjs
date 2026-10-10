// BRO-4204 S4-T9 / S4-T10 — West End aggregator promoter batch safety:
//   - slug-derived titles no longer carry roundup ("review2", "review-round-
//     up") or venue-noise tokens (matchWestEndVenueFromSlug);
//   - the shared dedup falls back to a normalized-title match within the
//     London pool when the venue strings disagree (findExistingMatch);
//   - rejected candidates are remembered (lib/we-rejected-candidates.js) and
//     a throwing candidate is stepped over, so one bad candidate cannot block
//     the batch (evaluateCandidates);
//   - the workflow job summary names promoted / rejected / refused ids
//     (we-promotion-job-summary.js).
// Background (audit 2026-09-28): the promoter had "promoted" the same 9 ids
// daily for 4 days and none ever landed — dracula-noel-coward-review2 became
// "Dracula" @ "noel coward", never matched dracula-west-end-2025 (venue
// "Noël Coward Theatre"), minted a duplicate, and validate-data refused the
// whole batch behind a `set +e … exit 0` wrapper.
// Tests the REAL exported functions per CLAUDE.md §15 — no logic copies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { matchWestEndVenueFromSlug, fetchLboRecentRoundups } = require('../../scripts/lib/we-listing-discover.js');
const { findExistingMatch, findExistingMatchInLondonPool } = require('../../scripts/lib/candidate-dedup.js');
const {
  loadRejectedCandidates,
  priorRejection,
  recordRejection,
  writeRejectedCandidates,
  candidateHash,
  REJECTED_TTL_DAYS,
} = require('../../scripts/lib/we-rejected-candidates.js');
const { buildVenueVocabulary } = require('../../scripts/lib/show-title-normalize.js');
const { evaluateCandidates, decideWestEndAggregatorPromotion } = require('../../scripts/promote-we-aggregator-candidates.js');
const { buildJobSummary, validateErrorsFrom } = require('../../scripts/we-promotion-job-summary.js');

// TESTS-VS-DERIVED-DATA-EXEMPT: the fixture rows below are inlined literals (the file never reads data/shows.json); they pin the dedup DECISION for a known duplicate shape, not a fact about the live catalog.
// The live rows (data/shows.json, 2026-09-28) the promoter kept duplicating:
// venue strings the slug-derived candidate venue never matches.
const DRACULA_ROW = { id: 'dracula-west-end-2025', title: 'Dracula', venue: 'Noël Coward Theatre', category: 'west-end' };
const LONDON_POOL = [
  DRACULA_ROW,
  { id: 'pride-west-end-2026', title: 'Pride', venue: 'Dorfman Theatre', category: 'west-end' },
  { id: 'hamlet-off-west-end-2024', title: 'Hamlet', venue: 'Almeida Theatre', category: 'off-west-end' },
];

// --- lib/we-listing-discover.js: slug → clean title ---

test('matchWestEndVenueFromSlug: "dracula-noel-coward-review2" resolves to venue "noel coward" + title "Dracula"', () => {
  const m = matchWestEndVenueFromSlug('dracula-noel-coward-review2');
  assert.ok(m);
  assert.equal(m.venue, 'noel coward');
  assert.equal(m.remainder, 'dracula');
  assert.equal(m.title, 'Dracula');
});

test('matchWestEndVenueFromSlug: roundup tokens on either side of the venue, and venue-noise words, never reach the title', () => {
  // Every shape below leaked into a title in data/audit/we-promotion-log.jsonl.
  const cases = {
    'review-roundup-dracula-noel-coward-review': 'Dracula',
    'nine-night-review-trafalgar': 'Nine Night', // "review" BETWEEN title and venue
    'the-unbelievers-review-round-up-royal-court': 'The Unbelievers',
    'x-review-royal-court': 'X',
    'a-christmas-carol-at-the-old-vic-review': 'A Christmas Carol',
    'the-lehman-trilogy-gillian-lynne-theatre-london-review': 'The Lehman Trilogy',
    'pride-national-theatre-dorfman-review': 'Pride',
  };
  for (const [slug, title] of Object.entries(cases)) {
    const m = matchWestEndVenueFromSlug(slug);
    assert.ok(m, slug);
    assert.equal(m.title, title, slug);
  }
});

test('matchWestEndVenueFromSlug: a title that STARTS with a noise word keeps it ("London Road", "The Story")', () => {
  assert.equal(matchWestEndVenueFromSlug('london-road-national-theatre-review').title, 'London Road');
  assert.equal(matchWestEndVenueFromSlug('the-story-olivier-national-theatre-review').title, 'The Story');
});

test('matchWestEndVenueFromSlug: accented or hand-typed (uppercase, colon) slugs still resolve to a clean title', () => {
  const m = matchWestEndVenueFromSlug('dracula-noël-coward-review');
  assert.ok(m);
  assert.equal(m.venue, 'noel coward');
  assert.equal(m.title, 'Dracula');
  // Live LBO sitemap slug (2026-09-28): the colon glued to "Review" defeated
  // the prefix strip and produced the title "Review: Hamlet".
  const h = matchWestEndVenueFromSlug('Review:-HAMLET-at-the-National-Theatre');
  assert.ok(h);
  assert.equal(h.venue, 'national');
  assert.equal(h.title, 'Hamlet');
});

test('fetchLboRecentRoundups: the sitemap path yields the same clean title as the matcher (one code path)', async () => {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><urlset><url><loc>https://www.londonboxoffice.co.uk/news/post/dracula-noel-coward-review2</loc><lastmod>2026-09-10</lastmod></url></urlset>';
  const [c] = await fetchLboRecentRoundups({ fetchPage: async () => ({ content: xml }), log: () => {} });
  assert.ok(c);
  assert.equal(c.title, 'Dracula');
  assert.equal(c.venue, 'noel coward');
});

// --- lib/candidate-dedup.js: London-pool title fallback ---

test('findExistingMatch: "Dracula" @ "noel coward" matches dracula-west-end-2025 despite the venue-string mismatch', () => {
  const m = findExistingMatch({ title: 'Dracula', venue: 'noel coward', category: 'west-end' }, LONDON_POOL);
  assert.ok(m);
  assert.equal(m.match.id, 'dracula-west-end-2025');
  assert.match(m.reason, /london-pool-title-equal/);
});

test('findExistingMatch: end to end — the slug-derived candidate is "existing", not a new row', () => {
  const slug = matchWestEndVenueFromSlug('dracula-noel-coward-review2');
  const m = findExistingMatch({ title: slug.title, venue: slug.venue, category: 'west-end' }, LONDON_POOL);
  assert.equal(m && m.match.id, 'dracula-west-end-2025');
});

test('findExistingMatch: a different venue string but a normalized-title match in the London pool is treated as existing', () => {
  // National Theatre slug venue vs the row's auditorium name.
  const m = findExistingMatch({ title: 'Pride', venue: 'national', category: 'west-end' }, LONDON_POOL);
  assert.equal(m && m.match.id, 'pride-west-end-2026');
  // A west-end candidate against an off-west-end row — same pool.
  const m2 = findExistingMatch({ title: 'Hamlet', venue: 'national', category: 'west-end' }, LONDON_POOL);
  assert.equal(m2 && m2.match.id, 'hamlet-off-west-end-2024');
  // Casing / diacritic variants normalize together (title-match.js).
  const m3 = findExistingMatch({ title: 'DRÁCULA', venue: 'apollo', category: 'west-end' }, LONDON_POOL);
  assert.equal(m3 && m3.match.id, 'dracula-west-end-2025');
});

test('findExistingMatch: an unrelated title is NOT matched by the London-pool fallback', () => {
  const unrelated = { title: 'Nine Night', venue: 'trafalgar', category: 'west-end' };
  assert.equal(findExistingMatch(unrelated, LONDON_POOL), null);
  assert.equal(findExistingMatchInLondonPool(unrelated, LONDON_POOL), null);
  assert.equal(findExistingMatch({ title: 'Dracula: A Comedy of Terrors', venue: 'apollo', category: 'west-end' }, LONDON_POOL), null);
});

test('findExistingMatch: the fallback is London-pool only — no London category on either side keeps venue-gated semantics', () => {
  // The OB promoter's shape: no category on candidate or rows
  // (promote-dedup-jaccard.test.mjs's "different venues" case must stay null).
  assert.equal(findExistingMatch({ title: 'Dracula', venue: 'noel coward' }, LONDON_POOL), null);
  assert.equal(findExistingMatch({ title: 'Dracula', venue: 'noel coward', category: 'broadway' }, LONDON_POOL), null);
  const noCategoryRows = LONDON_POOL.map(({ category, ...row }) => row);
  assert.equal(findExistingMatch({ title: 'Dracula', venue: 'noel coward', category: 'west-end' }, noCategoryRows), null);
  // Explicit opt-out.
  assert.equal(findExistingMatch({ title: 'Dracula', venue: 'noel coward', category: 'west-end' }, LONDON_POOL, { londonPoolFallback: false }), null);
  // The venue-gated pass still wins first when the venue DOES match.
  const same = findExistingMatch({ title: 'Dracula', venue: 'Noël Coward Theatre', category: 'west-end' }, LONDON_POOL);
  assert.equal(same && same.reason, 'normalized-equal');
});

// --- lib/we-rejected-candidates.js ---

function tmpStoreFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'we-rejected-')), 'we-rejected-candidates.json');
}
const DAY = 24 * 60 * 60 * 1000;

test('we-rejected-candidates: record → write → load → prior round-trips; a different venue is a different hash', () => {
  const file = tmpStoreFile();
  const t0 = new Date('2026-09-28T12:00:00Z');
  const cand = { title: 'Tartuffe (Remixed)', venue: 'Marylebone Theatre', source: 'wet-listing', sourceUrl: 'https://example.test/t' };
  const store = loadRejectedCandidates(file, { warn: () => {} }); // missing file = normal first run
  assert.deepEqual(store.rejected, {});
  recordRejection(store, cand, { kind: 'skip-unconfirmed', reason: 'venue is not canonical' }, t0);
  assert.equal(writeRejectedCandidates(store, file, t0), 1);

  const reloaded = loadRejectedCandidates(file, { warn: () => {} });
  const prior = priorRejection(reloaded, cand, new Date(t0.getTime() + DAY));
  assert.ok(prior);
  assert.equal(prior.hash, candidateHash(cand));
  assert.equal(prior.kind, 'skip-unconfirmed');
  assert.equal(prior.firstSeen, t0.toISOString());
  assert.equal(priorRejection(reloaded, { ...cand, venue: 'Old Vic' }, t0), null);
});

test('we-rejected-candidates: entries expire after REJECTED_TTL_DAYS (re-evaluated) and firstSeen anchors the window', () => {
  const t0 = new Date('2026-09-28T12:00:00Z');
  const cand = { title: 'Othello', venue: 'apollo', source: 'lbo-sitemap' };
  const store = loadRejectedCandidates(tmpStoreFile(), { warn: () => {} });
  const hash = recordRejection(store, cand, { kind: 'skip-unconfirmed', reason: 'stale' }, t0);
  // Re-sighting inside the window keeps firstSeen, bumps count.
  recordRejection(store, cand, { kind: 'skip-unconfirmed', reason: 'stale again' }, new Date(t0.getTime() + DAY));
  assert.equal(store.rejected[hash].count, 2);
  assert.equal(store.rejected[hash].firstSeen, t0.toISOString());
  assert.ok(priorRejection(store, cand, new Date(t0.getTime() + (REJECTED_TTL_DAYS - 1) * DAY)));
  const later = new Date(t0.getTime() + (REJECTED_TTL_DAYS + 1) * DAY);
  assert.equal(priorRejection(store, cand, later), null, 'past the TTL the candidate is re-evaluated');
  // Recording after expiry starts a fresh window; writing prunes expired entries.
  recordRejection(store, cand, { kind: 'skip-unconfirmed', reason: 'fresh' }, later);
  assert.equal(store.rejected[hash].count, 1);
  assert.equal(store.rejected[hash].firstSeen, later.toISOString());
  const file = tmpStoreFile();
  assert.equal(writeRejectedCandidates(store, file, new Date(later.getTime() + (REJECTED_TTL_DAYS + 1) * DAY)), 0);
  assert.deepEqual(loadRejectedCandidates(file, { warn: () => {} }).rejected, {});
});

test('we-rejected-candidates: a corrupt store file is treated as empty (never blocks a run) and reported once', () => {
  const file = tmpStoreFile();
  fs.writeFileSync(file, '{not json');
  const warnings = [];
  assert.deepEqual(loadRejectedCandidates(file, { warn: (m) => warnings.push(m) }).rejected, {});
  assert.equal(warnings.length, 1);
  fs.writeFileSync(file, JSON.stringify({ rejected: [] }));
  assert.deepEqual(loadRejectedCandidates(file, { warn: () => {} }).rejected, {});
});

// --- promote-we-aggregator-candidates.js: evaluateCandidates ---

const NOW = new Date('2026-09-28T18:00:00Z');
function lboCandidate(title, venue, slug) {
  return {
    title,
    venue,
    sourceUrl: `https://www.londonboxoffice.co.uk/news/post/${slug}`,
    articlePublishedAt: null,
    category: 'west-end',
    source: 'lbo-sitemap',
    discoveredAt: NOW.toISOString(),
  };
}
function ctxFor(overrides = {}) {
  return {
    existingCandidates: LONDON_POOL.map((r) => ({ ...r })),
    existingIds: new Set(LONDON_POOL.map((r) => r.id)),
    venueVocabulary: buildVenueVocabulary(LONDON_POOL),
    limit: 15,
    log: () => {},
    logEntry: () => {},
    now: () => NOW,
    ...overrides,
  };
}
const FRESH = '2026-09-20T10:00:00+01:00';

test('evaluateCandidates: a candidate that throws is recorded as rejected and the rest of the batch still promotes', async () => {
  const good1 = lboCandidate('Nine Night', 'trafalgar', 'nine-night-review-trafalgar');
  const bad = lboCandidate('Boom', 'apollo', 'boom-apollo-review');
  const good2 = lboCandidate('Tao of Glass', 'soho place', 'tao-of-glass-soho-place-review');
  const store = loadRejectedCandidates(tmpStoreFile(), { warn: () => {} });
  const ctx = ctxFor({
    rejectedStore: store,
    fetchLboArticleDate: async (url) => {
      if (url.includes('boom')) throw new Error('boom exploded');
      return { articlePublishedAt: FRESH };
    },
  });
  const { promoted, skipped, rejectedThisRun } = await evaluateCandidates([good1, bad, good2], ctx);
  assert.deepEqual(promoted.map((p) => p.entry.id).sort(), ['nine-night-west-end-2026', 'tao-of-glass-west-end-2026']);
  assert.equal(skipped.length, 1);
  assert.equal(rejectedThisRun.length, 1);
  assert.equal(rejectedThisRun[0].kind, 'candidate-error');
  assert.match(rejectedThisRun[0].reason, /boom exploded/);
  assert.ok(priorRejection(store, bad, NOW), 'the throwing candidate is remembered');
  // Promotions are visible to later dedup in the same run.
  assert.ok(ctx.existingIds.has('nine-night-west-end-2026'));
  assert.equal(ctx.existingCandidates.at(-1).category, 'west-end');
});

test('evaluateCandidates: a remembered rejection is skipped BEFORE the LBO date fetch (budget preserved)', async () => {
  const remembered = lboCandidate('Othello', 'apollo', 'othello-apollo-review');
  const store = loadRejectedCandidates(tmpStoreFile(), { warn: () => {} });
  recordRejection(store, remembered, { kind: 'skip-unconfirmed', reason: 'stale' }, new Date(NOW.getTime() - 5 * DAY));
  const fresh = lboCandidate('Giselle', 'london coliseum', 'giselle-london-coliseum-review');
  let fetches = 0;
  const entries = [];
  const ctx = ctxFor({
    rejectedStore: store,
    limit: 1, // exactly ONE date fetch this run — the remembered candidate must not take it
    logEntry: (e) => entries.push(e),
    fetchLboArticleDate: async () => { fetches++; return { articlePublishedAt: FRESH }; },
  });
  const { promoted, skipped } = await evaluateCandidates([remembered, fresh], ctx);
  assert.equal(fetches, 1);
  assert.deepEqual(promoted.map((p) => p.entry.id), ['giselle-west-end-2026']);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /previously rejected/);
  assert.ok(entries.some((e) => e.kind === 'skip-prior-rejection'));
});

test('evaluateCandidates: dedup runs before the memory — a remembered candidate that now exists logs as the duplicate it is', async () => {
  const store = loadRejectedCandidates(tmpStoreFile(), { warn: () => {} });
  const dracula = lboCandidate('Dracula', 'noel coward', 'dracula-noel-coward-review2');
  recordRejection(store, dracula, { kind: 'skip-id-collision', reason: 'id dracula-west-end-2026 already exists' }, new Date(NOW.getTime() - DAY));
  const entries = [];
  const ctx = ctxFor({ rejectedStore: store, logEntry: (e) => entries.push(e), fetchLboArticleDate: async () => { throw new Error('must not fetch'); } });
  const { promoted, skipped } = await evaluateCandidates([dracula], ctx);
  assert.equal(promoted.length, 0);
  assert.match(skipped[0].reason, /already in shows\.json as dracula-west-end-2025/);
  assert.equal(entries[0].kind, 'skip-duplicate');
});

test('evaluateCandidates: persistent refusals are remembered; fetch-dependent ones (missing date) are not', async () => {
  const store = loadRejectedCandidates(tmpStoreFile(), { warn: () => {} });
  const staleArticle = lboCandidate('Clarkston', 'trafalgar', 'clarkston-trafalgar-review');
  const noDate = lboCandidate('Krapps Last Tape', 'royal court', 'krapps-last-tape-royal-court-review');
  const notCanonical = { ...lboCandidate('Death Note', 'Barbican Theatre', 'death-note'), source: 'wet-listing', articlePublishedAt: FRESH };
  const ctx = ctxFor({
    rejectedStore: store,
    fetchLboArticleDate: async (url) => ({ articlePublishedAt: url.includes('clarkston') ? '2024-01-01T10:00:00Z' : null }),
  });
  const { promoted, skipped, rejectedThisRun } = await evaluateCandidates([staleArticle, noDate, notCanonical], ctx);
  assert.equal(promoted.length, 0);
  assert.equal(skipped.length, 3);
  assert.deepEqual(rejectedThisRun.map((r) => r.title).sort(), ['Clarkston', 'Death Note']);
  assert.ok(priorRejection(store, staleArticle, NOW));
  assert.ok(priorRejection(store, notCanonical, NOW));
  assert.equal(priorRejection(store, noDate, NOW), null, 'a missing date is a fetch failure — retried next run, never remembered');
});

test('evaluateCandidates: without a rejectedStore nothing is remembered, but a throw still does not abort the batch', async () => {
  const bad = lboCandidate('Boom', 'apollo', 'boom-apollo-review');
  const good = lboCandidate('Giselle', 'london coliseum', 'giselle-london-coliseum-review');
  const ctx = ctxFor({ fetchLboArticleDate: async (url) => { if (url.includes('boom')) throw new Error('x'); return { articlePublishedAt: FRESH }; } });
  const { promoted, rejectedThisRun } = await evaluateCandidates([bad, good], ctx);
  assert.deepEqual(promoted.map((p) => p.entry.id), ['giselle-west-end-2026']);
  assert.deepEqual(rejectedThisRun, []);
});

test('decideWestEndAggregatorPromotion: `persistent` separates candidate-property refusals from fetch-dependent ones', () => {
  const base = { title: 'A', venue: 'Old Vic', category: 'west-end', discoveredAt: NOW.toISOString(), source: 'lbo-sitemap' };
  assert.equal(decideWestEndAggregatorPromotion({ ...base, venue: null }).persistent, false);
  assert.equal(decideWestEndAggregatorPromotion({ ...base, articlePublishedAt: null }).persistent, false);
  assert.equal(decideWestEndAggregatorPromotion({ ...base, venue: 'RSC Stratford', articlePublishedAt: FRESH }).persistent, true);
  assert.equal(decideWestEndAggregatorPromotion({ ...base, articlePublishedAt: '2024-01-01T10:00:00Z' }).persistent, true);
  assert.equal(decideWestEndAggregatorPromotion({ ...base, category: 'off-west-end', articlePublishedAt: FRESH }).persistent, true);
  assert.equal(decideWestEndAggregatorPromotion({ ...base, articlePublishedAt: FRESH }).confirmed, true);
});

// --- scripts/we-promotion-job-summary.js (S4-T10) ---

test('buildJobSummary: names promoted ids, rejected candidates, and the ids validate-data refused', () => {
  const lastPromotion = {
    generatedAt: '2026-09-28T14:31:00.000Z',
    promoted: [{ id: 'giselle-west-end-2026', source: 'lbo-sitemap' }, { id: 'dracula-west-end-2026', source: 'lbo-sitemap' }],
    rejected: [{ title: 'Tartuffe (Remixed)', venue: 'Marylebone | Theatre', source: 'wet-listing', kind: 'skip-unconfirmed', reason: 'not canonical' }],
  };
  const log = 'Checking for duplicate shows...\n❌ ERROR: Duplicate show detected: dracula-west-end-2026 vs dracula-west-end-2025\n\n❌ FAILED: 1 error(s) found\n';
  const md = buildJobSummary({ lastPromotion, validateLog: log });
  assert.match(md, /\*\*Promoted this run:\*\* 2 — `giselle-west-end-2026`, `dracula-west-end-2026`/);
  assert.match(md, /Rejected this run \(remembered 90d/);
  assert.match(md, /\| Tartuffe \(Remixed\) \| Marylebone \\\| Theatre \| wet-listing \| skip-unconfirmed \| not canonical \|/);
  assert.match(md, /validate-data:\*\* ❌ refused \(1 error\(s\)\)/);
  assert.match(md, /the 2 promoted id\(s\) above did NOT land/);
  assert.match(md, /Duplicate show detected: dracula-west-end-2026 vs dracula-west-end-2025/);
  assert.deepEqual(validateErrorsFrom(log), ['Duplicate show detected: dracula-west-end-2026 vs dracula-west-end-2025']);
});

test('buildJobSummary: a clean validate-data log reads as passed; no log / no state file are stated, not crashed on', () => {
  const clean = buildJobSummary({ lastPromotion: { generatedAt: 't', promoted: [], rejected: [] }, validateLog: 'All checks passed\n' });
  assert.match(clean, /\*\*Promoted this run:\*\* 0\n/);
  assert.match(clean, /validate-data:\*\* ✅ passed/);
  const none = buildJobSummary({ lastPromotion: null, validateLog: null });
  assert.match(none, /No data\/audit\/we-last-promotion-ids\.json/);
  assert.match(none, /validate-data:\*\* _no log/);
  assert.equal(validateErrorsFrom(null), null);
});
