#!/usr/bin/env node
/**
 * Test suite for content-quality.js module
 *
 * Tests garbage detection against known samples from the codebase.
 * Run: node scripts/test-content-quality.js
 */

const {
  isGarbageContent,
  hasReviewContent,
  assessTextQuality,
  detectAdBlocker,
  detectPaywall,
  detectErrorPage,
  detectNavigationJunk,
} = require('./lib/content-quality.js');

// ============================================================================
// KNOWN GARBAGE SAMPLES (from actual scraping failures in the codebase)
// ============================================================================

const GARBAGE_SAMPLES = [
  {
    name: 'Ad blocker message (Observer)',
    text: `We noticed you're using an ad blocker.
			We get it: you like to have control of your own internet experience. But advertising revenue helps support our journalism. To read our full stories, please turn off your ad blocker.We'd really appreciate it.

Below are steps you can take in order to whitelist Observer.com on your browser:

Click the AdBlock button on your browser and select Don't run on pages on this domain.

Click the AdBlock Plus button on your browser and select Enabled on this site.

Click the AdBlock Plus button on your browser and select Disable on Observer.com.`,
    expectedReason: 'ad blocker',
  },
  {
    name: '404 Page (NY Sun)',
    text: `Page Not FoundWe're sorry. The Sun may have set on this page, but we have plenty more to illuminate your world!SearchGo to HomepageMeanwhile read our popular articlesPopular articlesWBZWhite CBS Anchorwoman Forced Out for 'Implicit Bias' Fires Back at Paramount's Move To Get Her Discrimination Lawsuit TossedBy BRADLEY CORTRIGHT|Jan 19, 2026|NationalKenta Harada/Getty ImagesSki Jumping Officials Tackle 'Penis-Gate' Scandal Ahead of Winter OlympicsBy JOSEPH CURL|Jan 19, 2026|ForeignVia XTop Justice Department Official Floats Ku Klux Klan Act as Possible Prosecution Vehicle for Fired CNN Journalist Don LemonBy MATTHEW RICE|Jan 19, 2026|NationalAPTrump's Plan for Iran Strike Was Halted After Urgent Calls From Netanyahu and Gulf LeadersBy HOLLIE McKAY|Jan 19, 2026|Foreign`,
    expectedReason: 'page not found',
  },
  {
    name: 'Wrong article (Insidious movie review mixed with Patriots)',
    text: `CHAPTER 2, a terrifying sequel to the acclaimed horror film, which follows the haunted Lambert family as they seek to uncover the mysterious childhood secret that has left them dangerously connected to the spirit world. Let's see what the critics had to say: Jeannette Catsoulis, New York Times A mess from start to finish - though, judging by the ending, this story won't be over any time soon - "Insidious: Chapter 2" is the kind of lazy, halfhearted product that gives scary movies a bad name.`,
    expectedReason: 'horror',
  },
  {
    name: 'Paywall prompt (generic)',
    text: `This article is for subscribers only. Subscribe to continue reading this premium content. Already a member? Log in to continue. Create a free account to access limited articles.`,
    expectedReason: 'paywall',
  },
  {
    name: 'Newsletter signup',
    text: `Thanks for subscribing! Enter your email address to get the latest news and updates delivered to your inbox. Sign up for our newsletter and never miss a story. Join our mailing list today.`,
    expectedReason: 'newsletter',
  },
  {
    name: 'Privacy policy page',
    text: `Privacy Policy

This Privacy Policy describes how we collect, use, and share information about you. By using our services, you agree to our terms. We collect personal information including your name, email address, and browsing history. All rights reserved.`,
    expectedReason: 'privacy',
  },
  {
    name: 'Terms of use page',
    text: `Terms of Use

These Terms of Use govern your access to and use of our website and services. By accessing or using our services, you agree to be bound by these terms. Copyright notice: All content is protected.`,
    expectedReason: 'terms',
  },
  {
    name: 'Empty content',
    text: '',
    expectedReason: 'empty content',
  },
  {
    name: 'Whitespace only',
    text: '   \n\n\t   \n  ',
    expectedReason: 'empty',
  },
  {
    name: 'Very short content',
    text: 'Click here to read more about the show.',
    expectedReason: 'too short',
  },
  {
    name: 'URL-only content',
    text: 'https://www.example.com/article/broadway-review-hamilton-is-great-musical-theater',
    expectedReason: 'short',  // Very short content triggers first
  },
  {
    name: 'Navigation menu junk',
    text: `Home
About
Contact
FAQ
Help
Support
Careers
Advertise
Skip to main content
Footer links
Header navigation
Search this site
Related articles
Popular stories
Latest news
Trending now
Read more >
See all articles
Previous article
Next article`,
    expectedReason: 'navigation',
  },
  {
    name: 'Sign in to continue',
    text: `You've reached your limit of free articles this month. Sign in to continue reading. Not a subscriber? Subscribe now for unlimited access to our award-winning journalism. Premium content requires membership.`,
    expectedReason: 'sign in',
  },
  {
    name: 'Article removed',
    text: `We're sorry, but the article you're looking for has been removed from our site. The page you are looking for doesn't exist. This content is no longer available. Please check our homepage for the latest stories.`,
    expectedReason: 'no longer available',  // The pattern that actually matches
  },
];

// ============================================================================
// KNOWN VALID REVIEW SAMPLES (from actual reviews in the codebase)
// ============================================================================

const VALID_SAMPLES = [
  {
    name: 'Hamilton AP review excerpt',
    text: `The hip-hop-based musical about Alexander Hamilton, the first treasury secretary of the United States, has gotten even more "scrappy and hungry" like its hero. This is a musical often stunning in its audaciousness. Perhaps Act 2 wanders a bit and the ending is a slight let-down. But there's no denying the show's sheer brashness and freshness. It is a revolution: A reclaiming of America's founding story by a multicultural cast using modern music and themes. The standout performances are Leslie Odom Jr. as a wary Aaron Burr, a cautious yin to Hamilton's impulsive yang. Odom throws down a career-defining marker here, graceful and cunning and haunted as both the narrator and the man who will kill Hamilton in 1804.`,
    showTitle: 'Hamilton',
  },
  {
    name: "Hell's Kitchen EW review",
    text: `Hell's Kitchen succeeds as both a jukebox musical and a coming-of-age story, thanks to Alicia Keys' infectious catalog and a powerhouse performance from Maleah Joi Moon. The production brings the streets of New York to life on the Broadway stage, with choreography that pulses with energy and a book that balances humor with genuine emotion. Director Michael Greif has crafted a theatrical experience that honors Keys' music while creating something entirely new.`,
    showTitle: "Hell's Kitchen",
  },
  {
    name: 'Stereophonic WaPo review',
    text: `This is a musical of rare ambition and accomplishment, a work that manages to be both intimate and epic in its exploration of the creative process and the toll it takes on those who pursue it. The cast delivers performances that feel startlingly real, and the music weaves through the narrative in ways that illuminate character and advance the story. Broadway has rarely seen anything quite like this production.`,
    showTitle: 'Stereophonic',
  },
  {
    name: 'Oh Mary! BWW excerpt',
    text: `Escola's splendidly nasty queer romp has hiked up its petticoats and staggered uptown from a sold-out run at the Lucille Lortel Theatre, goosing a sleepy Broadway summer. I'm happy to report that although director Sam Pinkleton leveled up the production values (particularly in the musical finale), Oh, Mary! remains the same vicious, dirty-minded, bad-taste farce that delighted camp aficionados last winter. In a theater scene squeezed between the Scylla of nonprofit precarity and Charybdis of commercial desperation, Escola and their team offer audacity, flair, and a homing instinct for the audience funny bone.`,
    showTitle: 'Oh, Mary!',
  },
  {
    name: 'Hadestown mixed review',
    text: `Proves to be smart and romantic but dramatically underwhelming. In Mitchell's hands, the sensitive Orpheus is too focused on playing the guitar to provide for Eurydice's real-world needs, so she independently ventures down to an industrialized underworld. The cast is excellent and songs are either gently touching or catchy, but 'Hadestown' does come off as slow, undercooked and choppy, more reminiscent of a concert than a theatrical work. The staging is inventive and the performances committed.`,
    showTitle: 'Hadestown',
  },
  {
    name: 'Wicked review excerpt',
    text: `The musical adaptation of Gregory Maguire's novel brings extraordinary visual spectacle to Broadway. Idina Menzel delivers a star-making performance as Elphaba, with vocal power that fills every corner of the Gershwin Theatre. The production's technical achievements are remarkable, from the dragon above the proscenium to the elaborate costume designs. Stephen Schwartz's score includes several songs that have become Broadway standards.`,
    showTitle: 'Wicked',
  },
  {
    name: 'Lion King review',
    text: `Julie Taymor's visionary staging of The Lion King remains one of the most inventive productions in Broadway history. The puppet work and mask designs create an African savanna that is both theatrical and magical. The ensemble work is breathtaking, with giraffes, elephants, and wildebeests brought to life through extraordinary stagecraft. This is a show that proves theatrical imagination has no limits.`,
    showTitle: 'The Lion King',
  },
  {
    name: 'MJ the Musical review',
    text: `Myles Frost gives a remarkable performance as Michael Jackson, capturing the King of Pop's signature moves and vocal style with uncanny precision. The musical takes a somewhat unconventional approach, framing Jackson's story through the lens of his Dangerous tour rehearsals. The choreography, supervised by Christopher Wheeldon, is spectacular, featuring the moonwalk and other iconic moves that made Jackson a legend.`,
    showTitle: 'MJ',
  },
  {
    name: 'Six the Musical review',
    text: `The six wives of Henry VIII take the stage in this pop concert musical that reimagines Tudor history through contemporary music. Each queen delivers a solo that showcases their individual style, from Aragon's Beyonce-inspired opener to Boleyn's punk-rock confession. The 80-minute show is a jolt of theatrical energy, with elaborate costumes and a backing band that brings arena-concert energy to the Brooks Atkinson Theatre.`,
    showTitle: 'SIX',
  },
  {
    name: 'Cabaret revival review',
    text: `Eddie Redmayne brings a dangerous edge to the Emcee in this stunning revival of Kander and Ebb's masterpiece. The Kit Kat Klub has been transformed into an immersive space that surrounds the audience with pre-war Berlin decadence. The production doesn't shy away from the political darkness at the story's heart, making this revival feel urgently contemporary. Gayle Rankin delivers a Sally Bowles for our times.`,
    showTitle: 'Cabaret',
  },
];

// ============================================================================
// TEST RUNNER
// ============================================================================

let passed = 0;
let failed = 0;
const failures = [];

function test(description, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${description}`);
  } catch (error) {
    failed++;
    failures.push({ description, error: error.message });
    console.log(`  ✗ ${description}`);
    console.log(`    Error: ${error.message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertFalse(condition, message) {
  if (condition) {
    throw new Error(message);
  }
}

function assertIncludes(haystack, needle, message) {
  if (typeof haystack === 'string') {
    if (!haystack.toLowerCase().includes(needle.toLowerCase())) {
      throw new Error(`${message}: "${needle}" not found in "${haystack.substring(0, 100)}..."`);
    }
  } else if (Array.isArray(haystack)) {
    if (!haystack.some(item => item.toLowerCase().includes(needle.toLowerCase()))) {
      throw new Error(`${message}: "${needle}" not found in array`);
    }
  }
}

// ============================================================================
// RUN TESTS
// ============================================================================

console.log('\n' + '═'.repeat(70));
console.log('  CONTENT QUALITY MODULE TEST SUITE');
console.log('═'.repeat(70) + '\n');

// Test garbage detection
console.log('GARBAGE CONTENT DETECTION:');
console.log('─'.repeat(70));

for (const sample of GARBAGE_SAMPLES) {
  test(`Detects garbage: ${sample.name}`, () => {
    const result = isGarbageContent(sample.text);
    assertTrue(result.isGarbage, `Expected garbage but got valid: ${result.reason}`);
    assertIncludes(result.reason.toLowerCase(), sample.expectedReason.toLowerCase(),
      `Reason should mention "${sample.expectedReason}"`);
  });
}

console.log('');

// Test valid content detection
console.log('VALID REVIEW DETECTION:');
console.log('─'.repeat(70));

for (const sample of VALID_SAMPLES) {
  test(`Accepts valid: ${sample.name}`, () => {
    const result = isGarbageContent(sample.text);
    assertFalse(result.isGarbage, `Expected valid but marked garbage: ${result.reason}`);
  });
}

console.log('');

// Test hasReviewContent function
console.log('THEATER KEYWORD DETECTION:');
console.log('─'.repeat(70));

test('Finds theater keywords in valid review', () => {
  const result = hasReviewContent(VALID_SAMPLES[0].text);
  assertTrue(result.hasReviewContent, 'Should find theater content');
  assertTrue(result.keywordsFound.length >= 2, `Should find multiple keywords, found: ${result.keywordsFound}`);
});

test('Returns false for garbage content without theater keywords', () => {
  // Use text that has no overlap with theater keywords (avoid substrings like "cast" in "forecast")
  const result = hasReviewContent('The weather report predicts rain tomorrow. Equity markets are rising well today.');
  assertFalse(result.hasReviewContent, 'Should not find theater content');
  assertEqual(result.keywordsFound.length, 0, 'Should find no keywords');
});

test('Handles empty input', () => {
  const result = hasReviewContent('');
  assertFalse(result.hasReviewContent, 'Empty should have no content');
  assertEqual(result.confidence, 'high', 'Empty should have high confidence');
});

console.log('');

// Test assessTextQuality function
console.log('COMPREHENSIVE QUALITY ASSESSMENT:');
console.log('─'.repeat(70));

test('Valid content with show title gets "valid" quality', () => {
  const result = assessTextQuality(VALID_SAMPLES[0].text, 'Hamilton');
  assertEqual(result.quality, 'valid', `Quality should be valid, got: ${result.quality}`);
});

test('Garbage content gets "garbage" quality', () => {
  const result = assessTextQuality(GARBAGE_SAMPLES[0].text, 'Test Show');
  assertEqual(result.quality, 'garbage', `Quality should be garbage, got: ${result.quality}`);
});

test('Short content without show mention is suspicious', () => {
  const result = assessTextQuality(
    'This was a great musical with amazing performances and excellent direction.',
    'Some Obscure Show Name 2024'
  );
  assertTrue(
    result.quality === 'suspicious' || result.issues.length > 0,
    'Short content without show title should raise issues'
  );
});

test('Assesses text with missing show title mention', () => {
  const result = assessTextQuality(
    'The Broadway production features stunning performances and beautiful music that captivates the audience from start to finish.',
    'Very Specific Show Title'
  );
  assertTrue(
    result.issues.some(i => i.includes('not mentioned') || i.includes('title')),
    'Should flag missing show title'
  );
});

console.log('');

// Test individual detectors
console.log('INDIVIDUAL DETECTOR FUNCTIONS:');
console.log('─'.repeat(70));

test('detectAdBlocker catches variations', () => {
  const tests = [
    "We noticed you're using an ad blocker",
    "Please disable your adblocker",
    "Turn off ad block to continue",
  ];
  for (const text of tests) {
    const result = detectAdBlocker(text);
    assertTrue(result.detected, `Should detect: "${text}"`);
  }
});

test('detectPaywall catches variations', () => {
  const tests = [
    "Subscribe to continue reading",
    "Sign in to access this content",
    "Members only article",
    "Premium content access required",
  ];
  for (const text of tests) {
    const result = detectPaywall(text);
    assertTrue(result.detected, `Should detect: "${text}"`);
  }
});

test('detectErrorPage catches variations', () => {
  const tests = [
    "Page not found",
    "404 error",
    "This article is no longer available",
    "Content has been removed",
  ];
  for (const text of tests) {
    const result = detectErrorPage(text);
    assertTrue(result.detected, `Should detect: "${text}"`);
  }
});

test('detectNavigationJunk handles menu-like content', () => {
  const menuContent = `Home
About
Contact
Support
FAQ
Popular articles
Related stories
Search this site
Skip to main content`;
  const result = detectNavigationJunk(menuContent);
  assertTrue(result.detected, 'Should detect navigation junk');
});

console.log('');

// Print summary
console.log('═'.repeat(70));
console.log('  RESULTS SUMMARY');
console.log('═'.repeat(70));
console.log(`  Total:  ${passed + failed}`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log('═'.repeat(70));

if (failures.length > 0) {
  console.log('\n  FAILURES:');
  for (const f of failures) {
    console.log(`  - ${f.description}`);
    console.log(`    ${f.error}`);
  }
}

console.log('');

// Exit with appropriate code
process.exit(failed > 0 ? 1 : 0);
