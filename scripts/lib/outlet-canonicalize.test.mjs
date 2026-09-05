// sameOutletUrlVariant — the alias-variant dedupe that stops a review we
// already hold from being counted as a coverage gap.
//
// Regression anchor (2026-08-03 newsletter): the-pass-off-broadway-2026 was
// reported as missing a one-minute-critic review it had held since ingest. The
// outlet moved to Substack, the SERP census surfaced the Substack URL, the file
// carried the .com URL, and the two paths share nothing — so no URL-level
// dedupe could see it. That phantom gap was one of two that made the newsletter
// gate delete the show from the issue.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { sameOutletUrlVariant } = require_('./outlet-canonicalize.js');
const { hostOf, classifyReviewUrl } = require_('./non-review-url-patterns.js');

// The real registry shape for one-minute-critic: domain 1minutecritic.com,
// domainAliases includes 1minutecritic.substack.com.
const MAP = {
  '1minutecritic.com': 'one-minute-critic',
  '1minutecritic.substack.com': 'one-minute-critic',
  'theguardian.com': 'guardian',
  'nytimes.com': 'nytimes',
};
const NONE = new Set();

const HELD_PASS = ['https://1minutecritic.com/the-pass-la-mama-review-2026/'];
const CANDIDATE_PASS = 'https://1minutecritic.substack.com/p/pass-la-mama-review-2026';

test('the real Pass pair dedupes — different hosts, different paths, one outlet', () => {
  const got = sameOutletUrlVariant({
    candidateUrl: CANDIDATE_PASS, heldUrls: HELD_PASS,
    domainToOutlet: MAP, ambiguous: NONE, hostOf,
  });
  assert.equal(got.dup, true);
  assert.equal(got.outletId, 'one-minute-critic');
  assert.equal(got.matchedUrl, HELD_PASS[0]);
});

test('paths are deliberately NOT compared — the real pair shares none', () => {
  // Guard against someone "simplifying" this to path equality: that rule would
  // not fire on the case the function exists for.
  const candPath = new URL(CANDIDATE_PASS).pathname;
  const heldPath = new URL(HELD_PASS[0]).pathname;
  assert.notEqual(candPath, heldPath, 'fixture must keep differing paths or the test proves nothing');
});

test('a genuine second review from the same outlet at the SAME host is not deduped', () => {
  // Same host means the ordinary exact/normalized-URL path already handled it;
  // this function must not start swallowing multi-critic outlets.
  const got = sameOutletUrlVariant({
    candidateUrl: 'https://1minutecritic.com/some-other-review-2026/',
    heldUrls: HELD_PASS,
    domainToOutlet: MAP, ambiguous: NONE, hostOf,
  });
  assert.equal(got.dup, false);
});

test('an unrelated host is never deduped, even at an identical path', () => {
  const got = sameOutletUrlVariant({
    candidateUrl: 'https://someblog.example/the-pass-la-mama-review-2026/',
    heldUrls: HELD_PASS,
    domainToOutlet: MAP, ambiguous: NONE, hostOf,
  });
  assert.equal(got.dup, false, 'path similarity must never be sufficient');
});

test('an AMBIGUOUS host (claimed by 2+ outlets) is never deduped', () => {
  // Codex adversarial finding: resolving a contested host to one arbitrary
  // outlet is fine for LABELLING a gap and unacceptable for HIDING one.
  const got = sameOutletUrlVariant({
    candidateUrl: CANDIDATE_PASS, heldUrls: HELD_PASS,
    domainToOutlet: MAP, ambiguous: new Set(['1minutecritic.substack.com']), hostOf,
  });
  assert.equal(got.dup, false);
});

test('an unregistered candidate host is never deduped', () => {
  const got = sameOutletUrlVariant({
    candidateUrl: 'https://brand-new-outlet.example/review', heldUrls: HELD_PASS,
    domainToOutlet: MAP, ambiguous: NONE, hostOf,
  });
  assert.equal(got.dup, false, 'an unknown outlet is a real gap, not a duplicate');
});

test('no held URLs at all means no dedupe', () => {
  const got = sameOutletUrlVariant({
    candidateUrl: CANDIDATE_PASS, heldUrls: [],
    domainToOutlet: MAP, ambiguous: NONE, hostOf,
  });
  assert.equal(got.dup, false);
});

test('malformed input never throws', () => {
  for (const args of [
    { candidateUrl: null, heldUrls: HELD_PASS, domainToOutlet: MAP, hostOf },
    { candidateUrl: CANDIDATE_PASS, heldUrls: null, domainToOutlet: MAP, hostOf },
    { candidateUrl: CANDIDATE_PASS, heldUrls: ['not a url'], domainToOutlet: MAP, hostOf },
    { candidateUrl: CANDIDATE_PASS, heldUrls: HELD_PASS, domainToOutlet: null, hostOf },
    { candidateUrl: CANDIDATE_PASS, heldUrls: HELD_PASS, domainToOutlet: MAP },
  ]) {
    assert.doesNotThrow(() => sameOutletUrlVariant(args));
  }
});

// ── The other half of the false-gap pair: ticket sellers ─────────────────────
// disruption-off-broadway-2026 was blocked by ticketluck.com and etickets.com.
// The census kept its own host list separate from the write path's, so a host
// denied in one still counted as a missing review in the other.
test('the real Disruption ticket-seller hosts are rejected as review candidates', () => {
  for (const url of [
    'https://www.ticketluck.com/disruption-tickets/',
    'https://www.etickets.com/disruption-off-broadway',
  ]) {
    const v = classifyReviewUrl(url);
    assert.equal(v.ok, false, `${url} must not be a review candidate`);
    assert.equal(v.reason, 'ticketing-reseller');
  }
});

test('the census reads the WRITE PATH ticket list — one list, not two', () => {
  // Adding a seller to domain-filters.js must close it for discovery too.
  // Sample an entry that lives ONLY in TICKET_DOMAINS (never in this module's
  // own NON_REVIEW_HOST_PATTERNS) and assert the census rejects it.
  const { TICKET_DOMAINS } = require_('./domain-filters.js');
  assert.ok(TICKET_DOMAINS.has('vividseats.com'), 'fixture host must exist in the write-path list');
  const v = classifyReviewUrl('https://www.vividseats.com/some-show-tickets/');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'ticketing-reseller');
});

test('real review outlets are still accepted — the deny-list did not overreach', () => {
  for (const url of [
    'https://www.theguardian.com/stage/2026/aug/05/im-every-woman-review',
    'https://www.londontheatre.co.uk/reviews/romeo-and-juliet-review',
    'https://1minutecritic.com/the-pass-la-mama-review-2026/',
  ]) {
    assert.equal(classifyReviewUrl(url).ok, true, `${url} must stay a candidate`);
  }
});

// ---------------------------------------------------------------------------
// BRO-2776: cvStyle vocabulary reconciliation + loud unknown values.
//
// shouldDeferCvWrongShow() requires getCvStyle(outletId) === 'long-biographical'.
// Zero of the 1127 registered outlets carried a cvStyle key, so the guard could
// never fire. Worse, review-guards.js's S3-T6 comment documents the spelling
// 'biographical-lead', which VALID_CV_STYLES rejected — following the docs armed
// nothing and said nothing, because the fallback to 'standard' was silent.
//
// Fix shape (after review 2026-09-05): the canonical vocabulary is corrected at
// its source in review-guards.js, the wrong spelling is REJECTED rather than
// aliased, and audit-outlet-registry.js gates bad values at WRITE time via
// findInvalidCvStyles. resolveCvStyle's warning is the read-time backstop.
//
// These exercise the real exported functions, not getCvStyle, because
// data/outlet-registry.json is gitignored private core data and is absent from
// every worktree.
// ---------------------------------------------------------------------------
const { resolveCvStyle, _resetCvStyleWarnings, VALID_CV_STYLES, findInvalidCvStyles } = require_('./outlet-canonicalize.js');

test('BRO-2776: the OLD documented spelling is rejected, not silently accepted', () => {
  // review-guards.js used to document 'biographical-lead'. It is NOT canonical.
  // The first attempt at this fix aliased it; review rejected that as permanent
  // vocabulary debt bought for zero outlets. It must now be loudly invalid.
  _resetCvStyleWarnings();
  const seen = [];
  const orig = console.warn;
  console.warn = (m) => seen.push(m);
  try {
    assert.equal(resolveCvStyle('biographical-lead', 'vulture'), 'standard');
  } finally {
    console.warn = orig;
  }
  assert.equal(seen.length, 1, 'the non-canonical spelling must warn, not pass silently');
  assert.match(seen[0], /biographical-lead/);
});

test('BRO-2776: the audit and the resolver share ONE vocabulary, not two copies', () => {
  // The whole bug was two drifted spellings. Assert the exported Set is the
  // single source of truth and still holds exactly the canonical values.
  assert.deepEqual([...VALID_CV_STYLES].sort(), ['long-biographical', 'standard']);
});

test('BRO-2776: canonical values pass through unchanged', () => {
  assert.equal(resolveCvStyle('long-biographical', 'x'), 'long-biographical');
  assert.equal(resolveCvStyle('standard', 'x'), 'standard');
});

test('BRO-2776: absent cvStyle defaults to standard and does NOT warn', () => {
  _resetCvStyleWarnings();
  const seen = [];
  const orig = console.warn;
  console.warn = (m) => seen.push(m);
  try {
    assert.equal(resolveCvStyle(undefined, 'no-style-outlet'), 'standard');
    assert.equal(resolveCvStyle(null, 'no-style-outlet'), 'standard');
  } finally {
    console.warn = orig;
  }
  // 1127 of 1127 outlets are in this state today. Warning here would print
  // 1127 lines per rebuild and train everyone to ignore the message.
  assert.deepEqual(seen, [], 'an absent cvStyle is normal and must stay silent');
});

test('BRO-2776: an unrecognised cvStyle is LOUD, warns once, and still falls back safely', () => {
  _resetCvStyleWarnings();
  const seen = [];
  const orig = console.warn;
  console.warn = (m) => seen.push(m);
  try {
    assert.equal(resolveCvStyle('bio-lead-typo', 'the-stage'), 'standard');
    // Same outlet + same bad value again: memoised, must not re-warn.
    assert.equal(resolveCvStyle('bio-lead-typo', 'the-stage'), 'standard');
    // A different bad value at the same outlet is a genuinely new problem.
    assert.equal(resolveCvStyle('another-typo', 'the-stage'), 'standard');
    assert.equal(seen.length, 2, 'warn once per (outlet, value), not per call');

    // Codex review 2026-09-05: the assertions above cannot tell a memo keyed by
    // (outlet, value) from one keyed by value alone — both give 2 warnings.
    // The SAME bad value at a DIFFERENT outlet must warn again, because it is a
    // second outlet silently not deferring.
    assert.equal(resolveCvStyle('bio-lead-typo', 'vulture'), 'standard');
    assert.equal(
      seen.length,
      3,
      'a value-only memo would swallow this: the same bad value at a second outlet must warn'
    );
    assert.match(seen[2], /vulture/);
  } finally {
    console.warn = orig;
  }
  assert.match(seen[0], /unrecognised/);
  assert.match(seen[0], /the-stage/);
  assert.match(seen[0], /bio-lead-typo/);
  // The message must name the guard that silently will not fire, otherwise the
  // warning does not tell the reader what it costs them.
  assert.match(seen[0], /shouldDeferCvWrongShow/);
});

test('BRO-2776: the write-time gate flags every invalid cvStyle and ignores absent ones', () => {
  // This is the registry shape audit-outlet-registry.js --strict now rejects.
  const found = findInvalidCvStyles({
    outlets: {
      'no-key': { displayName: 'No Key' },                       // 1127/1127 today
      'explicit-null': { cvStyle: null },
      'canonical-a': { cvStyle: 'standard' },
      'canonical-b': { cvStyle: 'long-biographical' },
      'old-spelling': { cvStyle: 'biographical-lead' },          // the BRO-2776 trap
      'typo': { cvStyle: 'long-biographic' },
      'empty-string': { cvStyle: '' },
      'wrong-type': { cvStyle: 3 },
    },
  });
  assert.deepEqual(
    found.map((f) => f.outletId).sort(),
    ['empty-string', 'old-spelling', 'typo', 'wrong-type']
  );
});

test('BRO-2776: the write-time gate is silent on a registry with no cvStyle keys at all', () => {
  // Today's real registry. The gate must not fail CI on the current data.
  assert.deepEqual(findInvalidCvStyles({ outlets: { a: {}, b: { displayName: 'B' } } }), []);
  assert.deepEqual(findInvalidCvStyles({}), []);
  assert.deepEqual(findInvalidCvStyles(null), []);
});
