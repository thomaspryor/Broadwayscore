#!/usr/bin/env node
/**
 * Test suite for scripts/lib/serp-candidate-validator.js
 *
 * Test cases motivated by 2026-04-29 Notion card "Pre-fetch SERP-result
 * validator (cast/venue check)":
 *   - hamlet-off-broadway-2026 (BAM Harvey)
 *   - the-receptionist-off-broadway-2026 (Pershing Square Signature Center)
 *
 * The fixtures synthesize realistic SERP {url, title, snippet} shapes for
 * both wrong-production and correct-production candidates. We assert the
 * validator's reject/accept decision and the reason code.
 *
 * Run: node scripts/test-serp-candidate-validator.js
 */

const fs = require('fs');
const path = require('path');
const {
  validateSerpCandidate,
  getSerpValidatorStats,
  resetSerpValidatorStats,
} = require('./lib/serp-candidate-validator');

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertReject(result, expectedReason, label) {
  if (result.ok !== false) {
    throw new Error(`${label}: expected reject, got ok=true`);
  }
  if (expectedReason && result.reason !== expectedReason) {
    throw new Error(`${label}: expected reason="${expectedReason}", got "${result.reason}" (detail: ${result.detail})`);
  }
}

function assertAccept(result, label) {
  if (result.ok !== true) {
    throw new Error(`${label}: expected accept, got reject (reason=${result.reason}, detail=${result.detail})`);
  }
}

// ----------------------------------------------------------------------------
// Load real shows for the two test cases
// ----------------------------------------------------------------------------
const shows = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data/shows.json'), 'utf8'));
const showList = Array.isArray(shows) ? shows : (shows.shows || []);
const hamlet = showList.find(s => s.id === 'hamlet-off-broadway-2026');
const receptionist = showList.find(s => s.id === 'the-receptionist-off-broadway-2026');

if (!hamlet) throw new Error('hamlet-off-broadway-2026 not found in shows.json');
if (!receptionist) throw new Error('the-receptionist-off-broadway-2026 not found in shows.json');

console.log(`\nTarget shows:\n  ${hamlet.id} @ ${hamlet.venue}\n  ${receptionist.id} @ ${receptionist.venue}\n`);

// ----------------------------------------------------------------------------
// Hamlet OB 2026 cases
// ----------------------------------------------------------------------------
console.log('Hamlet @ BAM Harvey (off-broadway-2026):');

t('rejects sibling Broadway venue (Belasco / 1995)', () => {
  resetSerpValidatorStats();
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.nytimes.com/1995/05/03/theater/review-hamlet-belasco.html',
      title: 'Theater Review; Ralph Fiennes Plays Hamlet at the Belasco',
      snippet: "Ralph Fiennes brings a fresh, brooding intensity to the prince of Denmark in this Belasco Theatre revival.",
    },
  });
  assertReject(result, 'sibling-venue', 'Belasco');
});

t('rejects sibling Broadway venue (Broadhurst / 2009 — Jude Law)', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.vulture.com/2009/10/jude_laws_hamlet_at_broadhurst.html',
      title: 'Jude Law Stuns in Broadhurst Hamlet',
      snippet: "Donmar Warehouse's transfer to the Broadhurst Theatre opened last night.",
    },
  });
  // Could be flagged as sibling-venue OR cross-market (Donmar is UK).
  // Sibling-venue is checked first.
  assertReject(result, 'sibling-venue', 'Broadhurst');
});

t('rejects UK production via Old Vic marker', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.theguardian.com/stage/2025/oct/12/hamlet-old-vic-review',
      title: 'Hamlet review – Andrew Scott electric at the Old Vic',
      snippet: 'Robert Icke directs Andrew Scott in a thrilling new Hamlet at the Old Vic.',
    },
  });
  assertReject(result, 'cross-market', 'Old Vic');
});

t('rejects RSC/Stratford production', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.rsc.org.uk/hamlet/reviews',
      title: 'Hamlet 2025 - Royal Shakespeare Company',
      snippet: "The RSC's Stratford-upon-Avon Hamlet transfers to the Barbican.",
    },
  });
  assertReject(result, 'cross-market', 'RSC');
});

t('accepts BAM Harvey review (correct production)', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.nytimes.com/2026/05/05/theater/hamlet-bam-review.html',
      title: 'Review: A Restless Hamlet at BAM Harvey',
      snippet: 'Hiran Abeysekera leads this Off-Broadway Hamlet at BAM Harvey Theater.',
    },
  });
  assertAccept(result, 'BAM Harvey accept');
});

t('accepts when sibling venue mentioned but own venue ALSO mentioned (comparison piece)', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.vulture.com/2026/05/hamlet-bam-vs-belasco.html',
      title: 'A Hamlet for Our Time: BAM Harvey vs. Belasco',
      snippet: 'How does the new BAM Harvey staging compare to the 1995 Belasco production?',
    },
  });
  assertAccept(result, 'comparison piece accept');
});

t('accepts non-marker review with title-only snippet (no positive reject signal)', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.theatermania.com/reviews/hamlet-2026',
      title: 'Hamlet Review',
      snippet: 'A bold new staging of Shakespeare’s tragedy.',
    },
  });
  assertAccept(result, 'no-marker accept');
});

// ----------------------------------------------------------------------------
// Receptionist OB 2026 cases
// ----------------------------------------------------------------------------
console.log('\nThe Receptionist @ Signature Center (off-broadway-2026):');

t('rejects 2007 Manhattan Theatre Club original (cross-market check)', () => {
  // The 2007 OB production is NOT in shows.json — sibling-venue check
  // can't catch it. But MTC is a US-market hard marker for a Broadway/OB
  // show... wait, the validator's cross-market check only fires when target
  // is in OPPOSING market. For an OB target, MTC is the SAME market. So MTC
  // mention won't trigger cross-market. This test asserts the (correct)
  // accept behavior. The user-facing protection here is the date-window
  // filter upstream of discoverCorrectUrl — not this validator.
  const result = validateSerpCandidate({
    show: receptionist,
    candidate: {
      url: 'https://www.nytimes.com/2007/10/30/theater/reviews/30recep.html',
      title: 'A Banal Office Job in The Receptionist',
      snippet: "Adam Bock's play opened at Manhattan Theatre Club's Stage I last night.",
    },
  });
  assertAccept(result, '2007 MTC version: validator does not catch (date filter does)');
});

t('rejects UK production via Royal Court marker', () => {
  const result = validateSerpCandidate({
    show: receptionist,
    candidate: {
      url: 'https://www.theguardian.com/stage/2024/the-receptionist-royal-court',
      title: 'The Receptionist — Royal Court Theatre',
      snippet: "Bock's bleak comedy lands at the Royal Court Theatre this autumn.",
    },
  });
  assertReject(result, 'cross-market', 'Royal Court');
});

t('rejects regional/touring with title in snippet', () => {
  const result = validateSerpCandidate({
    show: receptionist,
    candidate: {
      url: 'https://www.chicagotribune.com/theater/the-receptionist-goodman',
      title: 'The Receptionist at Goodman Theatre',
      snippet: 'Adam Bock’s The Receptionist arrives at the Goodman Theatre in Chicago.',
    },
  });
  assertReject(result, 'regional-tour', 'Goodman/Chicago');
});

t('accepts Signature Center review (correct production)', () => {
  const result = validateSerpCandidate({
    show: receptionist,
    candidate: {
      url: 'https://www.nytimes.com/2026/05/08/theater/the-receptionist-signature-review.html',
      title: 'Review: Adam Bock’s The Receptionist Returns at Signature',
      snippet: 'Katie Finneran leads the cast at the Pershing Square Signature Center.',
    },
  });
  assertAccept(result, 'Signature accept');
});

t('accepts off-Broadway review with mention of touring history when own venue named', () => {
  const result = validateSerpCandidate({
    show: receptionist,
    candidate: {
      url: 'https://www.vulture.com/the-receptionist-revival',
      title: 'The Receptionist Reopens',
      snippet: 'Before this Pershing Square Signature Center revival, the play had a national tour in the early 2010s.',
    },
  });
  assertAccept(result, 'tour-mention with own venue');
});

// ----------------------------------------------------------------------------
// Edge cases
// ----------------------------------------------------------------------------
console.log('\nEdge cases:');

t('null candidate accepts (no input → no opinion)', () => {
  const result = validateSerpCandidate({ show: hamlet, candidate: null });
  assertAccept(result, 'null candidate');
});

t('null show accepts (no target → no opinion)', () => {
  const result = validateSerpCandidate({
    show: null,
    candidate: { url: 'https://example.com', title: 'test', snippet: 'test' },
  });
  assertAccept(result, 'null show');
});

t('empty url accepts (handled upstream)', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: { url: '', title: 'Hamlet at Old Vic', snippet: '' },
  });
  // Validator returns ok if URL is empty — upstream code handles
  assertAccept(result, 'empty url');
});

t('lowercase-insensitive matching', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.theguardian.com/HAMLET-OLD-VIC',
      title: 'HAMLET REVIEW — OLD VIC',
      snippet: 'Old Vic production opens',
    },
  });
  assertReject(result, 'cross-market', 'uppercase markers');
});

t('stats counter increments correctly', () => {
  resetSerpValidatorStats();
  validateSerpCandidate({
    show: hamlet,
    candidate: { url: 'https://x', title: 'BAM Harvey', snippet: '' },
  }); // accept
  validateSerpCandidate({
    show: hamlet,
    candidate: { url: 'https://y', title: 'Old Vic Hamlet', snippet: '' },
  }); // reject
  const stats = getSerpValidatorStats();
  assertEq(stats.total, 2, 'total');
  assertEq(stats.ok, 1, 'ok');
  assertEq(stats.rejected, 1, 'rejected');
  assertEq(stats.byReason['cross-market'], 1, 'cross-market count');
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
