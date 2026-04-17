/**
 * Tests for validateBWWRoundupUrlMatchesShow.
 *
 * Root cause this guards against: on 2026-04-16 the opening night poller searched for
 * "Proof Broadway 2026" and Google SERP returned the Becky Shaw BWW roundup because
 * the Becky Shaw article mentions "Proof" (Pulitzer finalist context). The URL slug
 * clearly said BECKY-SHAW but there was no check. This function prevents that.
 *
 * Run: node scripts/test-bww-title-validation.js
 */

'use strict';

const { validateBWWRoundupUrlMatchesShow } = require('./lib/bww-roundup-validator');

let passed = 0;
let failed = 0;

function test(description, url, title, expected) {
  const result = validateBWWRoundupUrlMatchesShow(url, title);
  if (result === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${description}`);
    console.log(`      url:      ${url}`);
    console.log(`      title:    "${title}"`);
    console.log(`      expected: ${expected}, got: ${result}`);
    failed++;
  }
}

// ─── THE ACTUAL INCIDENT ───────────────────────────────────────────────────
console.log('\n── Actual incident (Proof vs Becky Shaw) ──');
test(
  'SERP returning Becky Shaw roundup for Proof query → REJECT',
  'https://www.broadwayworld.com/article/Review-Roundup-BECKY-SHAW-Opens-on-Broadway-Starring-Madeline-Brewer-Lauren-Patten-and-More-20260406',
  'Proof',
  false
);
test(
  'Correct Proof roundup URL → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-PROOF-Opens-on-Broadway-20260416',
  'Proof',
  true
);
test(
  'Year-only suffix Proof roundup → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-PROOF-2026',
  'Proof',
  true
);

// ─── SINGLE-WORD TITLES ────────────────────────────────────────────────────
console.log('\n── Single-word titles ──');
test(
  'Hamilton — correct roundup → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-HAMILTON-Opens-on-Broadway-20150806',
  'Hamilton',
  true
);
test(
  'Cats — correct roundup → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-CATS-Opens-on-Broadway-20221205',
  'Cats',
  true
);
test(
  'Wit — correct roundup → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-WIT-Opens-on-Broadway-20260101',
  'Wit',
  true
);
test(
  'Cats — must NOT match "broadcast" or partial substring → REJECT (broadcast has no "cats" segment)',
  'https://www.broadwayworld.com/article/Review-Roundup-BROADCAST-NEWS-Opens-on-Broadway-20260101',
  'Cats',
  false
);
test(
  'Wit — must NOT match a slug where "wit" is a prefix of another word (e.g. "without") → segment-safe',
  // "without" splits into segment "without", not "wit" — so this correctly rejects
  'https://www.broadwayworld.com/article/Review-Roundup-WITHOUT-A-NET-Opens-on-Broadway-20260101',
  'Wit',
  false
);
test(
  'Case-insensitive: lowercase slug → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-proof-opens-on-broadway-20260416',
  'Proof',
  true
);

// ─── TITLES WITH STOP WORDS ────────────────────────────────────────────────
console.log('\n── Titles with stop words ──');
test(
  '"The Notebook" — "the" stripped, "notebook" must be in slug → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-THE-NOTEBOOK-Opens-on-Broadway-20230302',
  'The Notebook',
  true
);
test(
  '"The Notebook" — wrong show slug → REJECT',
  'https://www.broadwayworld.com/article/Review-Roundup-BECKY-SHAW-Opens-on-Broadway-20230302',
  'The Notebook',
  false
);
test(
  '"A Strange Loop" — "a" stripped, "strange" + "loop" required → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-A-STRANGE-LOOP-Opens-on-Broadway-20220614',
  'A Strange Loop',
  true
);

// ─── MULTI-WORD TITLES ────────────────────────────────────────────────────
console.log('\n── Multi-word titles ──');
test(
  '"Into the Woods" — 3 words, "the" stripped → "into","woods" needed (80%) → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-INTO-THE-WOODS-Opens-on-Broadway-20221207',
  'Into the Woods',
  true
);
test(
  '"Becky Shaw" — correct own roundup → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-BECKY-SHAW-Opens-on-Broadway-Starring-Madeline-Brewer-20260406',
  'Becky Shaw',
  true
);
test(
  '"Merrily We Roll Along" — 80% rule: 3 of 4 words needed → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-MERRILY-WE-ROLL-ALONG-Opens-on-Broadway-20231121',
  'Merrily We Roll Along',
  true
);
test(
  '"Merrily We Roll Along" — wrong show → REJECT',
  'https://www.broadwayworld.com/article/Review-Roundup-SWEENEY-TODD-Opens-on-Broadway-20231121',
  'Merrily We Roll Along',
  false
);

// ─── NUMBERS IN TITLE ─────────────────────────────────────────────────────
console.log('\n── Numbers in titles ──');
test(
  '"1776" — number title → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-1776-Opens-on-Broadway-20221006',
  '1776',
  true
);
test(
  '"1776" — wrong show → REJECT',
  'https://www.broadwayworld.com/article/Review-Roundup-HAMILTON-Opens-on-Broadway-20221006',
  '1776',
  false
);
test(
  '"9 to 5 The Musical" — numbers + words → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-9-TO-5-THE-MUSICAL-Opens-on-Broadway-20090415',
  '9 to 5 The Musical',
  true
);

// ─── SUBSTRING COLLISION PREVENTION (segment matching, not slug.includes) ────
console.log('\n── Substring collision prevention ──');
test(
  '"Into the Woods": "into" must NOT match inside "introduction" — segment-safe',
  'https://www.broadwayworld.com/article/Review-Roundup-INTRODUCTION-DANCE-Opens-on-Broadway-20260101',
  'Into the Woods',
  false  // 'introduction' contains 'intro' but not segment 'into'; 'dance' ≠ 'woods' → REJECT
);
test(
  'Short word "is" must NOT match inside "christmas" — segment-safe',
  'https://www.broadwayworld.com/article/Review-Roundup-A-CHRISTMAS-CAROL-Opens-on-Broadway-20220101',
  'Is This A Room',  // titleWords: ['is', 'room'] — 2 words, 100% needed
  false  // 'christmas' contains substring 'is' but NOT exact segment; 'room' not present → REJECT
);
test(
  'Short word "all" must NOT match inside "falls" — segment-safe',
  'https://www.broadwayworld.com/article/Review-Roundup-NIAGARA-FALLS-Opens-on-Broadway-20260101',
  'All Quiet',  // titleWords: ['all', 'quiet']
  false  // 'falls' contains substring 'all' but NOT segment; 'quiet' absent → REJECT
);
test(
  '"Is This A Room" matches its own slug → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-IS-THIS-A-ROOM-Opens-on-Broadway-20211001',
  'Is This A Room',
  true  // segment 'is' ✓, segment 'room' ✓ (both exact)
);

// ─── APOSTROPHES / SPECIAL CHARS ─────────────────────────────────────────
console.log('\n── Special characters ──');
test(
  '"O\'Neill\'s House" — apostrophes stripped → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-ONEILLS-HOUSE-Opens-on-Broadway-20260101',
  "O'Neill's House",
  true
);
test(
  '"Fun Home" — no special chars → ACCEPT',
  'https://www.broadwayworld.com/article/Review-Roundup-FUN-HOME-Opens-on-Broadway-20150419',
  'Fun Home',
  true
);

// ─── WEST END FORMAT ─────────────────────────────────────────────────────
console.log('\n── West End URLs ──');
test(
  'West End format with london subpath → ACCEPT',
  'https://www.broadwayworld.com/london/article/Review-Roundup-HAMILTON-Opens-in-the-West-End-20171221',
  'Hamilton',
  true
);
test(
  'West End format — wrong show → REJECT',
  'https://www.broadwayworld.com/london/article/Review-Roundup-LES-MISERABLES-Opens-in-the-West-End-20231001',
  'Hamilton',
  false
);

// ─── EDGE CASES ──────────────────────────────────────────────────────────
console.log('\n── Edge cases ──');
test(
  'Null URL → ACCEPT (permissive, can\'t validate)',
  null,
  'Proof',
  true
);
test(
  'Empty URL → ACCEPT (permissive)',
  '',
  'Proof',
  true
);
test(
  'URL without Review-Roundup segment → ACCEPT (unexpected format, don\'t block)',
  'https://www.broadwayworld.com/article/PROOF-Broadway-Review-2026',
  'Proof',
  true
);
test(
  'Null title → ACCEPT (permissive)',
  'https://www.broadwayworld.com/article/Review-Roundup-PROOF-2026',
  null,
  true
);
test(
  'All-stop-words title "The" → ACCEPT (can\'t validate)',
  'https://www.broadwayworld.com/article/Review-Roundup-SOMETHING-ELSE-2026',
  'The',
  true
);

// ─── REAL SHOWS FROM SHOWS.JSON ──────────────────────────────────────────
console.log('\n── Real show regression cases ──');

// Load a few real shows to make sure no false positives on known-good data
try {
  const fs = require('fs');
  const path = require('path');
  // Support running from worktree (symlinks absent) or main repo
  const candidates = [
    path.join(__dirname, '..', 'data', 'shows.json'),
    path.join(process.cwd(), 'data', 'shows.json'),
  ];
  const showsPath = candidates.find(p => fs.existsSync(p));
  if (!showsPath) throw new Error('shows.json not found in any candidate path');
  const allShows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));

  // Shows with known bwwRoundupUrls stored in their review-text files
  const regressionCases = [
    { title: 'Hamilton', slug: 'HAMILTON-Opens-on-Broadway-20150806' },
    { title: 'The Book of Mormon', slug: 'THE-BOOK-OF-MORMON-Opens-on-Broadway-20110324' },
    { title: 'Sweeney Todd', slug: 'SWEENEY-TODD-Opens-on-Broadway-20231126' },
    { title: 'Merrily We Roll Along', slug: 'MERRILY-WE-ROLL-ALONG-Opens-on-Broadway-20231121' },
    { title: 'Becky Shaw', slug: 'BECKY-SHAW-Opens-on-Broadway-Starring-Madeline-Brewer-Lauren-Patten-and-More-20260406' },
  ];

  for (const { title, slug } of regressionCases) {
    const url = `https://www.broadwayworld.com/article/Review-Roundup-${slug}`;
    test(`Real show: "${title}" matches its own roundup URL → ACCEPT`, url, title, true);
  }

  // Cross-contamination: none of the above shows should accept another show's URL
  test(
    'Cross-contamination: "Hamilton" should NOT accept "Book of Mormon" URL',
    'https://www.broadwayworld.com/article/Review-Roundup-THE-BOOK-OF-MORMON-Opens-on-Broadway-20110324',
    'Hamilton',
    false
  );
  test(
    'Cross-contamination: "Sweeney Todd" should NOT accept "Merrily We Roll Along" URL',
    'https://www.broadwayworld.com/article/Review-Roundup-MERRILY-WE-ROLL-ALONG-Opens-on-Broadway-20231121',
    'Sweeney Todd',
    false
  );

} catch (e) {
  console.log(`  ⚠ Skipped real-show regression (shows.json not found or unreadable): ${e.message}`);
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n✗ ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n✓ All ${passed} tests passed`);
}
