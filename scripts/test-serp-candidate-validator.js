#!/usr/bin/env node
/**
 * Test suite for scripts/lib/serp-candidate-validator.js (v3).
 *
 * Test cases motivated by 2026-04-29 Notion card "Pre-fetch SERP-result
 * validator (cast/venue check)":
 *   - hamlet-off-broadway-2026 (BAM Harvey)
 *   - the-receptionist-off-broadway-2026 (Pershing Square Signature Center)
 *
 * v3 design (after corpus-probe iteration in same session):
 *   - Single check: cross-market hard markers, gated on URL DOMAIN
 *   - Transfer-aware exemption: shows.json same-title sibling in opposite market
 *   - SERP_PREFETCH_VALIDATOR=off env gate for rollback
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
// Hamlet OB 2026 — primary motivating case
// ----------------------------------------------------------------------------
console.log('Hamlet @ BAM Harvey (off-broadway-2026):');

t('rejects UK-domain Old Vic review', () => {
  resetSerpValidatorStats();
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.theguardian.com/stage/2025/oct/12/hamlet-old-vic-review',
      title: 'Hamlet review – Andrew Scott electric at the Old Vic',
      snippet: 'Robert Icke directs Andrew Scott in a thrilling new Hamlet at the Old Vic.',
    },
  });
  assertReject(result, 'cross-market', 'Old Vic on Guardian');
});

t('rejects UK-domain RSC/Stratford review', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.thestage.co.uk/reviews/hamlet-rsc-stratford',
      title: 'Hamlet — Royal Shakespeare Company',
      snippet: "The RSC's Stratford-upon-Avon Hamlet transfers to the Barbican.",
    },
  });
  assertReject(result, 'cross-market', 'RSC on The Stage');
});

t('does NOT reject "Old Vic" mention on US domain (transfer history in NYT review)', () => {
  // Critical false-positive guard: NYT/Vulture reviews of NYC productions
  // routinely mention the originating Old Vic / Donmar / Royal Court run.
  // Validator must accept these — only UK-domain hits are real wrong-production.
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.nytimes.com/2026/05/05/theater/hamlet-bam-review.html',
      title: 'A Restless Hamlet at BAM',
      snippet: 'After originating at the Old Vic last season, Robert Icke’s production opens at BAM Harvey.',
    },
  });
  assertAccept(result, 'NYT review mentioning Old Vic transfer');
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

t('accepts non-marker snippet on neutral domain', () => {
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
// Receptionist OB 2026 — second motivating case
// ----------------------------------------------------------------------------
console.log('\nThe Receptionist @ Signature Center (off-broadway-2026):');

t('rejects UK-domain Royal Court review', () => {
  const result = validateSerpCandidate({
    show: receptionist,
    candidate: {
      url: 'https://www.theguardian.com/stage/2024/the-receptionist-royal-court',
      title: 'The Receptionist — Royal Court Theatre',
      snippet: "Bock's bleak comedy lands at the Royal Court Theatre this autumn.",
    },
  });
  assertReject(result, 'cross-market', 'Royal Court on Guardian');
});

t('does NOT reject regional/tour mention (regional-tour check removed in v2)', () => {
  // v1 rejected on "Goodman Theatre" / "in chicago" + title co-occurrence.
  // Removed in v2 after corpus probe showed this pattern dominates legit
  // transfer-history references.
  const result = validateSerpCandidate({
    show: receptionist,
    candidate: {
      url: 'https://www.chicagotribune.com/theater/the-receptionist-goodman',
      title: 'The Receptionist at Goodman Theatre',
      snippet: 'Adam Bock’s The Receptionist arrives at the Goodman Theatre in Chicago.',
    },
  });
  assertAccept(result, 'regional/tour now passes');
});

t('does NOT reject 2007 MTC original on US domain (no cross-market trigger)', () => {
  const result = validateSerpCandidate({
    show: receptionist,
    candidate: {
      url: 'https://www.nytimes.com/2007/10/30/theater/reviews/30recep.html',
      title: 'A Banal Office Job in The Receptionist',
      snippet: "Adam Bock's play opened at Manhattan Theatre Club's Stage I last night.",
    },
  });
  // MTC is a US marker; target is OB (NYC pool). No cross-market fires.
  // Date-window upstream is what catches the 2007 production.
  assertAccept(result, 'MTC mention on NYT URL — same market, validator passes');
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

// ----------------------------------------------------------------------------
// Transfer-aware cross-market exemption
// ----------------------------------------------------------------------------
console.log('\nTransfer-aware exemption:');

t('cross-market exempted when transfer sibling exists in opposite market', () => {
  // John Proctor Is the Villain: Broadway 2025 + West End 2026.
  const johnProctor = showList.find(s => s.id === 'john-proctor-is-the-villain-2025');
  const johnProctorWE = showList.find(s => s.id === 'john-proctor-is-the-villain-west-end-2026');
  if (!johnProctor || !johnProctorWE) {
    console.log('    ⊙ skipped (transfer pair not in shows.json)');
    return;
  }
  // Even on a UK domain, the Donmar mention is exempted because the transfer
  // sibling exists. (This is the conservative direction: better to fetch +
  // verify than wrong-reject a transfer-relationship review.)
  const result = validateSerpCandidate({
    show: johnProctor,
    candidate: {
      url: 'https://www.theguardian.com/stage/john-proctor-donmar',
      title: 'John Proctor at the Donmar Warehouse',
      snippet: 'After its run at the Donmar Warehouse last season, the production opens.',
    },
  });
  assertAccept(result, 'cross-market suppressed by transfer sibling');
});

// ----------------------------------------------------------------------------
// URL-domain gating
// ----------------------------------------------------------------------------
console.log('\nURL-domain gating:');

t('UK marker on neutral/unknown domain is NOT rejected', () => {
  // The validator only fires when URL is on a known opposing-market domain.
  // Unknown domains pass through.
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://www.somerandomblog.example/hamlet-old-vic',
      title: 'Hamlet at the Old Vic',
      snippet: 'Andrew Scott Old Vic',
    },
  });
  assertAccept(result, 'unknown domain — no reject');
});

t('UK marker on .co.uk subdomain rejected (suffix match)', () => {
  const result = validateSerpCandidate({
    show: hamlet,
    candidate: {
      url: 'https://reviews.somecouk.co.uk/hamlet',
      title: 'Hamlet review',
      snippet: 'A new Hamlet at the Old Vic in London.',
    },
  });
  assertReject(result, 'cross-market', '.co.uk suffix triggers UK-domain detection');
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
    candidate: { url: 'https://nytimes.com/x', title: 'BAM Harvey', snippet: '' },
  });
  validateSerpCandidate({
    show: hamlet,
    candidate: { url: 'https://theguardian.com/y', title: 'Old Vic Hamlet', snippet: 'Old Vic' },
  });
  const stats = getSerpValidatorStats();
  assertEq(stats.total, 2, 'total');
  assertEq(stats.ok, 1, 'ok');
  assertEq(stats.rejected, 1, 'rejected');
  assertEq(stats.byReason['cross-market'], 1, 'cross-market count');
});

t('SERP_PREFETCH_VALIDATOR=off env gate disables all checks (source check)', () => {
  if (String(process.env.SERP_PREFETCH_VALIDATOR || '').toLowerCase() === 'off') {
    console.log('    ⊙ skipped (env already set to off)');
    return;
  }
  const moduleSrc = require('fs').readFileSync(
    require('path').join(process.cwd(), 'scripts/lib/serp-candidate-validator.js'),
    'utf8'
  );
  if (!moduleSrc.includes('process.env.SERP_PREFETCH_VALIDATOR')) {
    throw new Error('env gate not present in module source');
  }
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
