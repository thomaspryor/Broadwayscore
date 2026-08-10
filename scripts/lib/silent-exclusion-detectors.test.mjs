/**
 * Tests for the two silent-exclusion detectors (task #1188).
 *
 * Both halves are anchored on the REAL incidents from 2026-08-09, reproduced as
 * fixtures in the exact shape the corpus holds:
 *
 *  (a) one-minute-critic publishing on 1minutecritic.substack.com while the
 *      registry knew only 1minutecritic.com. The registry fixture below is the
 *      PRE-FIX entry — the live one now carries the substack domainAlias that
 *      was added by hand, so the fixture is what main looked like when every
 *      review on the new host was being dropped.
 *
 *  (b) rosie-odonnell-common-knowledge-off-broadway-2026/nyt-theater--jonathan
 *      .json — llmScore 78, 744 words, exclusion flag manually cleared,
 *      contentTier deleted, and absent from reviews.json through a full scoring
 *      run + rebuild with no warning anywhere.
 *
 * Per CLAUDE.md §15 this require()s the real module — no logic is copied here,
 * so a change to the predicates fails these tests rather than passing a stale
 * duplicate.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MIN_FULLTEXT_CHARS,
  MIN_IDENTITY_SLUG_LEN,
  identitySlug,
  normalizeHost,
  evaluateMissingContentTier,
  missingTierKey,
  buildOutletIdentityIndex,
  detectOutletDomainMoves,
  domainMoveKey,
} = require('./silent-exclusion-detectors.js');

// ── shared fixture helpers ────────────────────────────────────────────────

const REVIEW_TEXT = 'x'.repeat(4200); // stands in for the 744-word Mandell review

/** A file in the exact state the Rosie O'Donnell review was left in. */
function tierlessReview(overrides = {}) {
  return {
    showId: 'rosie-odonnell-common-knowledge-off-broadway-2026',
    outletId: 'nyt-theater',
    outlet: 'New York Theater',
    criticName: 'Jonathan',
    url: 'https://newyorktheater.me/2026/06/13/rosie-odonnells-common-knowledge-coming-to-nyc/',
    fullText: REVIEW_TEXT,
    publishDate: '2026-06-14',
    assignedScore: 78,
    llmScore: { score: 78, confidence: 'high', bucket: 'Positive' },
    llmMetadata: { model: 'ensemble:claude-sonnet-4-6+gpt-4o+gemini-2.5-flash' },
    scoreSource: 'llm-v6',
    // contentTier deliberately absent — that is the defect under test.
    ...overrides,
  };
}

/** Registry as it stood BEFORE the hand-fix: no substack alias. */
const REGISTRY_PRE_FIX = {
  'one-minute-critic': {
    displayName: '1 Minute Critic',
    tier: 3,
    aliases: ['one-minute-critic', 'one minute critic', 'oneminutecritic', '1minutecritic', '1-minute-critic'],
    domain: '1minutecritic.com',
    domainAliases: ['oneminutecritic.com'],
    region: 'us',
  },
  guardian: {
    displayName: 'The Guardian',
    tier: 1,
    aliases: ['guardian', 'the guardian'],
    domain: 'theguardian.com',
  },
};

/** The row audit-show-review-gap.js writes for an unrecognised host. */
function unknownHostRow(host, overrides = {}) {
  return {
    host,
    provisionalOutletId: null,
    occurrences: 3,
    sampleUrls: [`https://${host}/2026/08/some-review/`],
    shows: ['the-pass-off-broadway-2026'],
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// (b) A review with fullText + a real byline + no rejection flags + no tier
// ══════════════════════════════════════════════════════════════════════════

test('(b) the Rosie O\'Donnell file — scored, unflagged, tier deleted — is reported', () => {
  const finding = evaluateMissingContentTier(tierlessReview());
  assert.ok(finding, 'a scored, unflagged, text-bearing review with no contentTier must be reported');
  assert.equal(finding.criticName, 'Jonathan');
  assert.equal(finding.outletId, 'nyt-theater');
  assert.equal(finding.hasScore, true);
  assert.equal(finding.chars, REVIEW_TEXT.length);
});

test('(b) restoring contentTier clears the finding', () => {
  // The hand-fix that was actually applied: classifyContentTier() returned
  // 'complete' at 744 words, and the file was written back with it.
  assert.equal(evaluateMissingContentTier(tierlessReview({ contentTier: 'complete' })), null);
});

test('(b) any non-empty tier counts as classified, including unfavourable ones', () => {
  // The invariant is "some writer made the call", not "the call was favourable".
  for (const tier of ['complete', 'truncated', 'excerpt', 'stub', 'invalid']) {
    assert.equal(
      evaluateMissingContentTier(tierlessReview({ contentTier: tier })),
      null,
      `contentTier=${tier} is classified and must not be reported`,
    );
  }
});

test('(b) NEGATIVE CONTROL: a tier-less file carrying a rejection flag is NOT reported', () => {
  // 54 of the 115 tier-less files in the live corpus are exactly this. They are
  // SUPPOSED to be absent from the corpus, so reporting them would bury the
  // real signal under a backlog of correct exclusions.
  const flagged = tierlessReview({
    wrongProduction: true,
    wrongProductionReason: 'Review of the 2025 Edinburgh run, not this production',
  });
  assert.equal(evaluateMissingContentTier(flagged), null);
});

test('(b) NEGATIVE CONTROL: a tier-less file with no meaningful text is NOT reported', () => {
  // Star-only / aggregator-excerpt entries legitimately carry no fullText.
  assert.equal(evaluateMissingContentTier(tierlessReview({ fullText: '' })), null);
  assert.equal(evaluateMissingContentTier(tierlessReview({ fullText: undefined })), null);
  assert.equal(
    evaluateMissingContentTier(tierlessReview({ fullText: 'y'.repeat(MIN_FULLTEXT_CHARS - 1) })),
    null,
    'below the meaningful-text floor',
  );
  assert.ok(
    evaluateMissingContentTier(tierlessReview({ fullText: 'y'.repeat(MIN_FULLTEXT_CHARS) })),
    'exactly at the floor is meaningful',
  );
});

test('(b) NEGATIVE CONTROL: a tier-less file with no real byline is NOT reported', () => {
  for (const name of ['', '   ', 'Unknown', 'unknown', 'Staff', 'Anonymous', 'Editorial', 'N/A']) {
    assert.equal(
      evaluateMissingContentTier(tierlessReview({ criticName: name })),
      null,
      `criticName=${JSON.stringify(name)} is not a person`,
    );
  }
});

test('(b) survives junk input instead of throwing', () => {
  for (const junk of [null, undefined, 'a string', 42, []]) {
    assert.equal(evaluateMissingContentTier(junk), null);
  }
});

test('(b) baseline key includes the byline so a re-derived file re-alerts', () => {
  const a = { showId: 's', file: 'f.json', criticName: 'Jonathan' };
  const b = { showId: 's', file: 'f.json', criticName: 'Jonathan Mandell' };
  assert.notEqual(missingTierKey(a), missingTierKey(b));
});

// ══════════════════════════════════════════════════════════════════════════
// (a) An outlet whose registry entry lists only its old host
// ══════════════════════════════════════════════════════════════════════════

test('(a) the one-minute-critic move to Substack is reported against the pre-fix registry', () => {
  const { findings } = detectOutletDomainMoves({
    outlets: REGISTRY_PRE_FIX,
    unknownHosts: [unknownHostRow('1minutecritic.substack.com', {
      provisionalOutletId: '1minutecritic',
      occurrences: 7,
      sampleUrls: ['https://1minutecritic.substack.com/p/the-pass'],
      shows: ['the-pass-off-broadway-2026'],
    })],
  });

  assert.equal(findings.length, 1, 'the moved host must be reported exactly once');
  assert.equal(findings[0].host, '1minutecritic.substack.com');
  assert.equal(findings[0].outletId, 'one-minute-critic');
  assert.equal(findings[0].registeredDomain, '1minutecritic.com', 'names the stale host so the fix is obvious');
  assert.equal(findings[0].occurrences, 7);
});

test('(a) the same host is silent once the domainAlias is added — the fix resolves the alert', () => {
  const fixed = JSON.parse(JSON.stringify(REGISTRY_PRE_FIX));
  fixed['one-minute-critic'].domainAliases.push('1minutecritic.substack.com');

  const { findings } = detectOutletDomainMoves({
    outlets: fixed,
    unknownHosts: [unknownHostRow('1minutecritic.substack.com', { provisionalOutletId: '1minutecritic' })],
  });
  assert.deepEqual(findings, [], 'a registered host is not a move');
});

test('(a) a TLD move is reported (the reviewsgate.co.uk / .com live case)', () => {
  const { findings } = detectOutletDomainMoves({
    outlets: { reviewsgate: { displayName: 'ReviewsGate', aliases: ['reviewsgate'], domain: 'reviewsgate.com' } },
    unknownHosts: [unknownHostRow('reviewsgate.co.uk', { provisionalOutletId: 'reviewsgate' })],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].outletId, 'reviewsgate');
  assert.equal(findings[0].registeredDomain, 'reviewsgate.com');
});

test('(a) derives the identity itself when the audit file predates provisionalOutletId', () => {
  // Older/hand-built rows have no provisionalOutletId — the canonical helper
  // must still recover "1minutecritic" from the Substack subdomain.
  const { findings } = detectOutletDomainMoves({
    outlets: REGISTRY_PRE_FIX,
    unknownHosts: [unknownHostRow('1minutecritic.substack.com', { provisionalOutletId: undefined })],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].outletId, 'one-minute-critic');
});

test('(a) NEGATIVE CONTROL: a domainless outlet is NOT reported as a move', () => {
  // 40 of the 44 raw slug matches in the live file are this class, which
  // domainless-outlet-guard.test.mjs already owns. Folding them in would bury
  // the real moves.
  const { findings, domainlessMatches } = detectOutletDomainMoves({
    outlets: {
      cleveland: { displayName: 'Cleveland.com', aliases: ['cleveland'] }, // no `domain`
      'the-jewish-news': { displayName: 'The Jewish News', aliases: ['thejewishnews'], domain: '' },
    },
    unknownHosts: [
      unknownHostRow('cleveland.com', { provisionalOutletId: 'cleveland' }),
      unknownHostRow('thejewishnews.com', { provisionalOutletId: 'thejewishnews' }),
    ],
  });
  assert.deepEqual(findings, [], 'no registered domain means there is no move to detect');
  assert.equal(domainlessMatches, 2, 'but the class is counted, not silently swallowed');
});

test('(a) NEGATIVE CONTROL: an unrelated host matching no outlet is NOT reported', () => {
  const { findings } = detectOutletDomainMoves({
    outlets: REGISTRY_PRE_FIX,
    unknownHosts: [unknownHostRow('some-random-blog.com', { provisionalOutletId: 'some-random-blog' })],
  });
  assert.deepEqual(findings, []);
});

test('(a) NEGATIVE CONTROL: short generic slugs never match', () => {
  // "arts.com" must not claim an outlet aliased "arts".
  const { findings } = detectOutletDomainMoves({
    outlets: { 'arts-desk': { displayName: 'The Arts Desk', aliases: ['arts'], domain: 'theartsdesk.com' } },
    unknownHosts: [unknownHostRow('arts.com', { provisionalOutletId: 'arts' })],
  });
  assert.deepEqual(findings, [], `slugs under ${MIN_IDENTITY_SLUG_LEN} chars are too generic to match`);
});

test('(a) aggregator hosts are vetoed by the canonical helper, not matched', () => {
  // provisionalOutletIdFromHost returns null for aggregator domains, which is
  // why show-score.com never reaches the matcher even though a "show-score"
  // outlet is registered.
  const { findings } = detectOutletDomainMoves({
    outlets: { 'show-score': { displayName: 'Show Score', aliases: ['showscore'], domain: 'showscore.com' } },
    unknownHosts: [unknownHostRow('show-score.com', { provisionalOutletId: null })],
  });
  assert.deepEqual(findings, []);
});

test('(a) tolerates junk rows and an empty registry without throwing', () => {
  const { findings, scanned } = detectOutletDomainMoves({
    outlets: {},
    unknownHosts: [null, {}, { host: '' }, unknownHostRow('example.com')],
  });
  assert.deepEqual(findings, []);
  assert.equal(scanned, 1, 'only the well-formed row counts as scanned');
  assert.deepEqual(detectOutletDomainMoves({}).findings, []);
});

test('(a) baseline key is host+outlet so a NEW host for the same outlet re-alerts', () => {
  const first = { host: '1minutecritic.substack.com', outletId: 'one-minute-critic' };
  const second = { host: '1minutecritic.ghost.io', outletId: 'one-minute-critic' };
  assert.notEqual(domainMoveKey(first), domainMoveKey(second));
});

test('(a) baselined findings are withheld but counted', () => {
  const args = {
    outlets: REGISTRY_PRE_FIX,
    unknownHosts: [unknownHostRow('1minutecritic.substack.com', { provisionalOutletId: '1minutecritic' })],
  };
  const { findings } = detectOutletDomainMoves(args);
  const result = detectOutletDomainMoves({ ...args, baselineKeys: [domainMoveKey(findings[0])] });
  assert.deepEqual(result.findings, []);
  assert.equal(result.baselinedCount, 1);
});

// ── shared helpers ────────────────────────────────────────────────────────

test('identitySlug and normalizeHost normalise both sides of the comparison', () => {
  assert.equal(identitySlug('one-minute-critic'), 'oneminutecritic');
  assert.equal(identitySlug('1 Minute Critic'), '1minutecritic');
  assert.equal(identitySlug(null), '');
  assert.equal(normalizeHost('WWW.Example.COM'), 'example.com');
  assert.equal(normalizeHost('  example.com  '), 'example.com');
});

test('buildOutletIdentityIndex collects every host and every identity', () => {
  const { knownHosts, identityIndex } = buildOutletIdentityIndex(REGISTRY_PRE_FIX);
  assert.ok(knownHosts.has('1minutecritic.com'));
  assert.ok(knownHosts.has('oneminutecritic.com'), 'domainAliases count as known hosts');
  assert.ok(knownHosts.has('theguardian.com'));
  assert.deepEqual(identityIndex.get('1minutecritic'), ['one-minute-critic']);
  assert.deepEqual(identityIndex.get('oneminutecritic'), ['one-minute-critic']);
});
