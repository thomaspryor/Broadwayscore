// Tests for silent-exclusion-detectors.js — card #1188, two more instances of
// the #1147 silent-exclusion class (see scripts/lib/ingest-skip-classify.js
// for the sibling module this one follows).
//
// Regression anchors, both fixed by hand with no detector left behind:
//   (a) one-minute-critic moved to 1minutecritic.substack.com; the registry
//       only knew 1minutecritic.com, so every review on the new host hit
//       domain-mismatch and was dropped.
//   (b) rosie-odonnell-common-knowledge-off-broadway-2026's
//       nyt-theater--jonathan.json had fullText + a real byline + no
//       rejection flags + no contentTier, and stayed OUT of reviews.json
//       through a full scoring + rebuild run.
//
// Each `without the fix` test below re-derives what these predicates would
// have to look like for main to have caught the incident BEFORE this module
// existed — i.e. it proves the gap was real, not just that the new code
// works on contrived input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const {
  isMissingContentTierGap,
  scanMissingContentTier,
  normalizeHostSlug,
  normalizeOutletName,
  findProbableDomainMoves,
} = require_('./silent-exclusion-detectors.js');

const LONG_TEXT = 'This is a real, substantial review of the production. '.repeat(10); // > 200 chars

// ── (b) missing contentTier ─────────────────────────────────────────────

test('a scored, unflagged review with fullText + a real byline but NO contentTier is reported', () => {
  // Mirrors the real fixture: fullText present, real criticName, llmScore
  // set, no rejection flags, contentTier absent entirely.
  const data = {
    outlet: 'The New York Times',
    outletId: 'nytimes',
    criticName: 'Jonathan',
    fullText: LONG_TEXT,
    llmScore: { score: 78 },
  };
  assert.equal(isMissingContentTierGap(data), true, 'this is exactly the shape that silently dropped out of reviews.json');
});

test('BEFORE this module existed, nothing in the codebase flagged that shape — proving the gap was real', () => {
  // The only pre-existing signal in this shape is VALIDATOR_EXCLUSION_FLAGS,
  // and it is entirely about REJECTION flags — it has no concept of a
  // MISSING contentTier on an otherwise-clean file. A file with none of
  // those flags sails through validate-review-texts.js as "not skipped" and
  // still silently fails to reach reviews.json for a completely different
  // reason (rebuild's contentTier reclassification safety net only fires
  // when fullText changes) that no prior code named.
  const { VALIDATOR_EXCLUSION_FLAGS } = require_('./aggregator-url-latent.js');
  const data = {
    outlet: 'The New York Times',
    outletId: 'nytimes',
    criticName: 'Jonathan',
    fullText: LONG_TEXT,
    llmScore: { score: 78 },
  };
  const wouldHaveBeenSkippedByValidator = VALIDATOR_EXCLUSION_FLAGS.some((flag) => Boolean(data[flag]));
  assert.equal(wouldHaveBeenSkippedByValidator, false, 'no rejection flag explains the drop — that IS the silent gap');
});

test('delegates to the canonical isIncludableForRebuild, not a hand-rolled flag list (ship-check finding: memory feedback_includability_predicates_must_be_canonical.md)', () => {
  // isNonReview / fabricatedEntry / scoreStatus==='TO_BE_CALCULATED' are real
  // exclusion classes explainExclusion() recognizes that a flat
  // VALIDATOR_EXCLUSION_FLAGS-style list (9 rejection-flag fields) never
  // covered — a bespoke predicate would have false-flagged these as silent
  // gaps when they are deliberate, correct exclusions.
  const base = { criticName: 'Jonathan', fullText: LONG_TEXT };
  assert.equal(isMissingContentTierGap({ ...base, isNonReview: true }), false);
  assert.equal(isMissingContentTierGap({ ...base, fabricatedEntry: true }), false);
  assert.equal(isMissingContentTierGap({ ...base, scoreStatus: 'TO_BE_CALCULATED' }), false);
});

test('a review WITH a contentTier is not reported', () => {
  assert.equal(isMissingContentTierGap({ criticName: 'Jonathan', fullText: LONG_TEXT, contentTier: 'complete' }), false);
});

test('a freshly manually-ingested review (manualContentTier set, contentTier not yet backfilled) is NOT reported — ship-check finding, /ingest-manual-review.js sets manualContentTier but not contentTier itself, and classifyContentTier resolves it on the next rebuild', () => {
  assert.equal(
    isMissingContentTierGap({ criticName: 'Jonathan', fullText: LONG_TEXT, manualContentTier: 'complete' }),
    false,
  );
});

test('a review with a rejection flag set is not reported — it is a deliberate tombstone, not a silent drop', () => {
  assert.equal(isMissingContentTierGap({ criticName: 'Jonathan', fullText: LONG_TEXT, wrongProduction: true }), false);
  assert.equal(isMissingContentTierGap({ criticName: 'Jonathan', fullText: LONG_TEXT, duplicateOf: 'other.json' }), false);
  assert.equal(isMissingContentTierGap({ criticName: 'Jonathan', fullText: LONG_TEXT, rejectionReason: 'not_a_review' }), false);
});

test('a byline-less (Unknown critic) review is not reported — those route through a different path', () => {
  assert.equal(isMissingContentTierGap({ criticName: 'Unknown', fullText: LONG_TEXT }), false);
  assert.equal(isMissingContentTierGap({ fullText: LONG_TEXT }), false);
});

test('a stub with no real fullText is not reported — there is nothing to tier', () => {
  assert.equal(isMissingContentTierGap({ criticName: 'Jonathan', fullText: 'too short' }), false);
  assert.equal(isMissingContentTierGap({ criticName: 'Jonathan' }), false);
});

test('null/non-object input does not throw', () => {
  assert.equal(isMissingContentTierGap(null), false);
  assert.equal(isMissingContentTierGap(undefined), false);
});

test('scanMissingContentTier walks a review-texts tree and finds only the gap fixture', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-exclusion-rt-'));
  try {
    const showDir = path.join(tmp, 'rosie-odonnell-common-knowledge-off-broadway-2026');
    fs.mkdirSync(showDir, { recursive: true });
    fs.writeFileSync(
      path.join(showDir, 'nyt-theater--jonathan.json'),
      JSON.stringify({ outletId: 'nytimes', criticName: 'Jonathan', fullText: LONG_TEXT, llmScore: { score: 78 } }),
    );
    // A healthy sibling — has a contentTier, must not be reported.
    fs.writeFileSync(
      path.join(showDir, 'variety--adam.json'),
      JSON.stringify({ outletId: 'variety', criticName: 'Adam', fullText: LONG_TEXT, contentTier: 'complete' }),
    );
    // A flagged sibling — wrongProduction, must not be reported.
    fs.writeFileSync(
      path.join(showDir, 'wsj--pat.json'),
      JSON.stringify({ outletId: 'wsj', criticName: 'Pat', fullText: LONG_TEXT, wrongProduction: true }),
    );
    const results = scanMissingContentTier(tmp);
    assert.equal(results.length, 1);
    assert.equal(results[0].showId, 'rosie-odonnell-common-knowledge-off-broadway-2026');
    assert.equal(results[0].file, 'nyt-theater--jonathan.json');
    assert.equal(results[0].criticName, 'Jonathan');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanMissingContentTier tolerates a dangling symlink show dir (listShowDirs contract)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'silent-exclusion-rt-symlink-'));
  try {
    fs.symlinkSync(path.join(tmp, 'does-not-exist'), path.join(tmp, 'broken-link'));
    assert.doesNotThrow(() => scanMissingContentTier(tmp));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── (a) outlet domain moves ─────────────────────────────────────────────

test('normalizeHostSlug strips www, a hosting platform suffix, and the TLD', () => {
  assert.equal(normalizeHostSlug('1minutecritic.substack.com'), '1minutecritic');
  assert.equal(normalizeHostSlug('www.theatre-weekly.co.uk'), 'theatreweekly');
  assert.equal(normalizeHostSlug('example.com'), 'example');
  assert.equal(normalizeHostSlug(''), '');
  assert.equal(normalizeHostSlug(null), '');
});

test('normalizeHostSlug takes the LAST remaining segment on a 3+-label host — not the subdomain prefix (ship-check finding, confirmed by direct execution)', () => {
  // Before the fix, the generic single-label-TLD strip ran UNCONDITIONALLY
  // after the platform-suffix/two-label-TLD strip already removed a suffix,
  // eating the real identity label instead: 'theater.jerryportwood.substack.com'
  // came back 'theater' (wrong) instead of 'jerryportwood'.
  assert.equal(normalizeHostSlug('theater.jerryportwood.substack.com'), 'jerryportwood');
  assert.equal(normalizeHostSlug('news.dancemagazine.co.uk'), 'dancemagazine');
});

test('normalizeOutletName strips punctuation/case for comparison', () => {
  assert.equal(normalizeOutletName('one-minute-critic'), 'oneminutecritic');
  assert.equal(normalizeOutletName('1 Minute Critic'), '1minutecritic');
});

test('a host matching a registered outlet name, not yet in domainAliases, is reported (the real 1minutecritic incident, replayed pre-fix)', () => {
  // Registry state AS IT WAS before the by-hand fix: domain 1minutecritic.com,
  // domainAliases only has the earlier oneminutecritic.com typo-domain — the
  // real .substack.com host is absent.
  const outlets = {
    'one-minute-critic': {
      displayName: '1 Minute Critic',
      aliases: ['one-minute-critic', '1minutecritic', '1-minute-critic'],
      domain: '1minutecritic.com',
      domainAliases: ['oneminutecritic.com'],
    },
  };
  const unknownHosts = [
    { host: '1minutecritic.substack.com', occurrences: 3, sampleUrls: ['https://1minutecritic.substack.com/p/the-pass'] },
  ];
  const moves = findProbableDomainMoves(outlets, unknownHosts);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].host, '1minutecritic.substack.com');
  assert.equal(moves[0].outletId, 'one-minute-critic');
  assert.equal(moves[0].occurrences, 3);
});

test('WITHOUT this module, nothing in the registry pipeline flags a moved domain — proving the gap was real', () => {
  // The registry itself has no "did any unregistered host slug-match a known
  // outlet" check anywhere; domain-mismatch is detected only per-URL, at
  // ingest time, as a routine skip line — never aggregated or compared
  // against the census of unregistered hosts. Demonstrated here by showing
  // the registry's own alias index has no entry for the new host at all.
  const outlets = {
    'one-minute-critic': {
      displayName: '1 Minute Critic',
      aliases: ['one-minute-critic', '1minutecritic'],
      domain: '1minutecritic.com',
      domainAliases: ['oneminutecritic.com'],
    },
  };
  const allKnownHosts = new Set(
    Object.values(outlets).flatMap((o) => [o.domain, ...(o.domainAliases || [])]),
  );
  assert.equal(allKnownHosts.has('1minutecritic.substack.com'), false, 'the new host was nowhere in the registry — a plain lookup could never have found it');
});

test('a host already in domainAliases is NOT reported — it is a known mirror, not a move', () => {
  const outlets = {
    'one-minute-critic': {
      displayName: '1 Minute Critic',
      aliases: ['one-minute-critic'],
      domain: '1minutecritic.com',
      domainAliases: ['1minutecritic.substack.com'],
    },
  };
  const unknownHosts = [{ host: '1minutecritic.substack.com', occurrences: 1 }];
  assert.deepEqual(findProbableDomainMoves(outlets, unknownHosts), []);
});

test('an outlet with NO domain on file is never matched — a name coincidence is not a "move" (the cleveland.com false-positive class)', () => {
  // Real corpus case: outletId 'cleveland', displayName 'Cleveland', no
  // `domain` field at all. Before the domain-required guard, this matched
  // 44/218 real census hosts purely by display-name coincidence.
  const outlets = {
    cleveland: { displayName: 'Cleveland', aliases: ['clevelandcom'] },
  };
  const unknownHosts = [{ host: 'cleveland.com', occurrences: 6 }];
  assert.deepEqual(findProbableDomainMoves(outlets, unknownHosts), []);
});

test('a short-named real outlet (vox/cnn/gq/lbc-class) IS matched via exact outletId, even though every alias/displayName normalizes under MIN_SLUG_LENGTH', () => {
  // ship-check finding: a blanket MIN_SLUG_LENGTH=4 floor on ALL candidate
  // names made short-brand outlets permanently unmatchable — every name
  // variant they have is under 4 chars. outletId (curated, not freeform) is
  // checked at a lower floor instead.
  const outlets = { vox: { displayName: 'Vox', domain: 'vox.com' } };
  const unknownHosts = [{ host: 'vox.substack.com', occurrences: 2 }];
  const moves = findProbableDomainMoves(outlets, unknownHosts);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].outletId, 'vox');
});

test('a short freeform ALIAS (not the outletId) is still ignored — the loosened floor only applies to outletId', () => {
  // Real corpus case: outletId 'ap' (Associated Press) carries a stray
  // 3-char alias typo "app" in its aliases array. Loosening the floor for
  // aliases too would match app.com (an unrelated NJ news site) by pure
  // accident — outletId-only exemption avoids that.
  const outlets = { ap: { displayName: 'Associated Press', aliases: ['app'], domain: 'apnews.com' } };
  const unknownHosts = [{ host: 'app.com', occurrences: 1 }];
  assert.deepEqual(findProbableDomainMoves(outlets, unknownHosts), []);
});

test('a short/generic normalized slug is not matched — avoids over-broad false positives', () => {
  const outlets = { amny: { displayName: 'amNY', domain: 'amny.com' } };
  const unknownHosts = [{ host: 'amy.org', occurrences: 1 }]; // 'amy' normalizes to len 3, below MIN_SLUG_LENGTH
  assert.deepEqual(findProbableDomainMoves(outlets, unknownHosts), []);
});

test('empty/malformed input does not throw', () => {
  assert.deepEqual(findProbableDomainMoves({}, []), []);
  assert.deepEqual(findProbableDomainMoves(null, []), []);
  assert.deepEqual(findProbableDomainMoves({}, null), []);
  assert.deepEqual(findProbableDomainMoves({ x: { domain: 'x.com' } }, [{ host: null }]), []);
});

// ── real-corpus sanity (skips gracefully when data isn't checked out) ────

test('findProbableDomainMoves against the REAL registry + census stays under a sane false-positive bound', () => {
  const registryPath = path.join(__dirname, '..', '..', 'data', 'outlet-registry.json');
  const censusPath = path.join(__dirname, '..', '..', 'data', 'audit', 'unknown-aggregator-outlets.json');
  if (!fs.existsSync(registryPath) || !fs.existsSync(censusPath)) return; // private/data-only files, skip if absent
  const outlets = JSON.parse(fs.readFileSync(registryPath, 'utf8')).outlets;
  const census = JSON.parse(fs.readFileSync(censusPath, 'utf8')).outlets;
  const moves = findProbableDomainMoves(outlets, census);
  // Advisory detector, not a hard gate — just prove it doesn't degrade into
  // "flags almost everything" on the real corpus (would have been 44/218
  // before the domain-required guard).
  assert.ok(moves.length < census.length * 0.25, `expected a small advisory list, got ${moves.length}/${census.length}`);
});
