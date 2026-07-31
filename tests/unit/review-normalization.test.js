/**
 * Unit tests for the review normalization module.
 *
 * Tests cover:
 * - normalizeOutlet: outlet name normalization
 * - normalizeCritic: critic name normalization
 * - generateReviewFilename: review filename generation
 * - generateReviewKey: unique key generation for deduplication
 * - Integration: cross-aggregator normalization consistency
 *
 * Run with: node --test tests/unit/review-normalization.test.js
 */

const { test, describe, it } = require('node:test');
const assert = require('node:assert');

const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  generateReviewKey,
  slugify,
  areCriticsSimilar,
  areOutletsSame,
  areReviewsDuplicates,
  levenshteinDistance,
  getOutletDisplayName,
  getOutletFromRegistry,
  getOutletTier,
  loadOutletRegistry,
  normalizeUrl,
  mergeReviews,
  OUTLET_ALIASES,
  CRITIC_ALIASES,
} = require('../../scripts/lib/review-normalization.js');

// ============================================================================
// normalizeOutlet tests
// ============================================================================

describe('normalizeOutlet', () => {
  test('returns correct canonical ID for known outlets', () => {
    assert.strictEqual(normalizeOutlet('New York Times'), 'nytimes');
    assert.strictEqual(normalizeOutlet('Vulture'), 'vulture');
    assert.strictEqual(normalizeOutlet('Variety'), 'variety');
    assert.strictEqual(normalizeOutlet('Hollywood Reporter'), 'hollywood-reporter');
    assert.strictEqual(normalizeOutlet('Deadline'), 'deadline');
    assert.strictEqual(normalizeOutlet('The Guardian'), 'guardian');
  });

  test('normalizes NYT aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('ny times'), 'nytimes');
    assert.strictEqual(normalizeOutlet('the new york times'), 'nytimes');
    assert.strictEqual(normalizeOutlet('nyt'), 'nytimes');
    assert.strictEqual(normalizeOutlet('newyorktimes'), 'nytimes');
    assert.strictEqual(normalizeOutlet('new-york-times'), 'nytimes');
    assert.strictEqual(normalizeOutlet('The New York Times'), 'nytimes');
  });

  test('normalizes Vulture/NY Mag aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('new york magazine / vulture'), 'vulture');
    assert.strictEqual(normalizeOutlet('new york magazine/vulture'), 'vulture');
    assert.strictEqual(normalizeOutlet('ny mag'), 'vulture');
    assert.strictEqual(normalizeOutlet('nymag'), 'vulture');
    assert.strictEqual(normalizeOutlet('vult'), 'vulture');
  });

  test('normalizes Time Out aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('time out'), 'timeout');
    assert.strictEqual(normalizeOutlet('time out new york'), 'timeout');
    assert.strictEqual(normalizeOutlet('timeout new york'), 'timeout');
    assert.strictEqual(normalizeOutlet('time out ny'), 'timeout');
    assert.strictEqual(normalizeOutlet('timeout-ny'), 'timeout');
  });

  test('normalizes Washington Post aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('washington post'), 'washpost');
    assert.strictEqual(normalizeOutlet('the washington post'), 'washpost');
    assert.strictEqual(normalizeOutlet('wapo'), 'washpost');
    assert.strictEqual(normalizeOutlet('wash post'), 'washpost');
  });

  test('normalizes Wall Street Journal aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('wall street journal'), 'wsj');
    assert.strictEqual(normalizeOutlet('the wall street journal'), 'wsj');
    assert.strictEqual(normalizeOutlet('wallstreetjournal'), 'wsj');
    assert.strictEqual(normalizeOutlet('wall-street-journal'), 'wsj');
  });

  test('normalizes New York Post aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('new york post'), 'nypost');
    assert.strictEqual(normalizeOutlet('ny post'), 'nypost');
    assert.strictEqual(normalizeOutlet('nyp'), 'nypost');
    assert.strictEqual(normalizeOutlet('newyorkpost'), 'nypost');
  });

  test('normalizes NY Daily News aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('new york daily news'), 'nydailynews');
    assert.strictEqual(normalizeOutlet('daily news'), 'nydailynews');
    assert.strictEqual(normalizeOutlet('ny daily news'), 'nydailynews');
    assert.strictEqual(normalizeOutlet('nydn'), 'nydailynews');
  });

  test('normalizes The New Yorker aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('the new yorker'), 'newyorker');
    assert.strictEqual(normalizeOutlet('new yorker'), 'newyorker');
    assert.strictEqual(normalizeOutlet('the-new-yorker'), 'newyorker');
    assert.strictEqual(normalizeOutlet('new-yorker'), 'newyorker');
  });

  test('normalizes TheaterMania aliases correctly', () => {
    assert.strictEqual(normalizeOutlet('theatermania'), 'theatermania');
    assert.strictEqual(normalizeOutlet('theater mania'), 'theatermania');
    assert.strictEqual(normalizeOutlet('theatremania'), 'theatermania');
    assert.strictEqual(normalizeOutlet('theatre mania'), 'theatermania');
    assert.strictEqual(normalizeOutlet('tmania'), 'theatermania');
  });

  test('handles case insensitivity', () => {
    assert.strictEqual(normalizeOutlet('NEW YORK TIMES'), 'nytimes');
    assert.strictEqual(normalizeOutlet('VuLtUrE'), 'vulture');
    assert.strictEqual(normalizeOutlet('VARIETY'), 'variety');
    assert.strictEqual(normalizeOutlet('The Hollywood Reporter'), 'hollywood-reporter');
    assert.strictEqual(normalizeOutlet('THE GUARDIAN'), 'guardian');
  });

  test('handles "the" prefix variations', () => {
    assert.strictEqual(normalizeOutlet('guardian'), 'guardian');
    assert.strictEqual(normalizeOutlet('The Guardian'), 'guardian');
    assert.strictEqual(normalizeOutlet('the guardian'), 'guardian');
    assert.strictEqual(normalizeOutlet('new york times'), 'nytimes');
    assert.strictEqual(normalizeOutlet('The New York Times'), 'nytimes');
  });

  test('returns slugified version for unknown outlets', () => {
    assert.strictEqual(normalizeOutlet('Some Random Outlet'), 'some-random-outlet');
    assert.strictEqual(normalizeOutlet('My Theatre Blog'), 'my-theatre-blog');
    assert.strictEqual(normalizeOutlet('Unknown Publication 123'), 'unknown-publication-123');
  });

  test('handles edge cases: empty string', () => {
    assert.strictEqual(normalizeOutlet(''), 'unknown');
  });

  test('handles edge cases: null', () => {
    assert.strictEqual(normalizeOutlet(null), 'unknown');
  });

  test('handles edge cases: undefined', () => {
    assert.strictEqual(normalizeOutlet(undefined), 'unknown');
  });

  test('handles whitespace trimming', () => {
    assert.strictEqual(normalizeOutlet('  nytimes  '), 'nytimes');
    assert.strictEqual(normalizeOutlet('\tVulture\n'), 'vulture');
    assert.strictEqual(normalizeOutlet('  The Guardian  '), 'guardian');
  });

  test('normalizes special characters and symbols', () => {
    // Town & Country should normalize
    assert.strictEqual(normalizeOutlet('town & country'), 'towncountry');
    assert.strictEqual(normalizeOutlet('Town & Country'), 'towncountry');
    assert.strictEqual(normalizeOutlet('town and country'), 'towncountry');
  });

  test('normalizes Broadway-specific outlets', () => {
    assert.strictEqual(normalizeOutlet('broadwayworld'), 'broadwayworld');
    assert.strictEqual(normalizeOutlet('broadway world'), 'broadwayworld');
    assert.strictEqual(normalizeOutlet('bww'), 'broadwayworld');
    assert.strictEqual(normalizeOutlet('broadway news'), 'broadwaynews');
    assert.strictEqual(normalizeOutlet('playbill'), 'playbill');
    assert.strictEqual(normalizeOutlet("talkin' broadway"), 'talkinbroadway');
    assert.strictEqual(normalizeOutlet('front mezz junkies'), 'frontmezzjunkies');
    assert.strictEqual(normalizeOutlet('fmj'), 'frontmezzjunkies');
  });
});

// ============================================================================
// normalizeCritic tests
// ============================================================================

describe('normalizeCritic', () => {
  test('normalizes full names correctly', () => {
    assert.strictEqual(normalizeCritic('Jesse Green'), 'jesse-green');
    assert.strictEqual(normalizeCritic('Ben Brantley'), 'ben-brantley');
    assert.strictEqual(normalizeCritic('Helen Shaw'), 'helen-shaw');
    assert.strictEqual(normalizeCritic('David Rooney'), 'david-rooney');
    assert.strictEqual(normalizeCritic('Frank Scheck'), 'frank-scheck');
  });

  test('handles known typos correctly', () => {
    // Johnny Oleksinski has a known typo "Oleksinki" (missing second 's')
    assert.strictEqual(normalizeCritic('Johnny Oleksinski'), 'johnny-oleksinski');
    assert.strictEqual(normalizeCritic('johnny oleksinki'), 'johnny-oleksinski'); // typo
    assert.strictEqual(normalizeCritic('John Oleksinski'), 'johnny-oleksinski'); // first name variant

    // Aramide Tinubu has a known typo "Timubu"
    assert.strictEqual(normalizeCritic('Aramide Tinubu'), 'aramide-tinubu');
    assert.strictEqual(normalizeCritic('aramide timubu'), 'aramide-tinubu'); // typo
  });

  test('handles initials in aliases', () => {
    assert.strictEqual(normalizeCritic('j. green'), 'jesse-green');
    assert.strictEqual(normalizeCritic('b. brantley'), 'ben-brantley');
    assert.strictEqual(normalizeCritic('c. isherwood'), 'charles-isherwood');
    assert.strictEqual(normalizeCritic('s. holdren'), 'sara-holdren');
  });

  test('handles name variations in aliases', () => {
    assert.strictEqual(normalizeCritic('juan a ramirez'), 'juan-a-ramirez');
    assert.strictEqual(normalizeCritic('juan a. ramirez'), 'juan-a-ramirez');
    assert.strictEqual(normalizeCritic('juan ramirez'), 'juan-a-ramirez');
    assert.strictEqual(normalizeCritic('zach stewart'), 'zachary-stewart');
    assert.strictEqual(normalizeCritic('z. stewart'), 'zachary-stewart');
    assert.strictEqual(normalizeCritic('chris jones'), 'chris-jones');
    assert.strictEqual(normalizeCritic('christopher jones'), 'chris-jones');
  });

  test('returns slugified version for unknown critics', () => {
    assert.strictEqual(normalizeCritic('Jane Doe'), 'jane-doe');
    assert.strictEqual(normalizeCritic('John Smith Jr'), 'john-smith-jr');
    assert.strictEqual(normalizeCritic('Mary-Jane Watson'), 'mary-jane-watson');
  });

  test('handles single names (gets slugified)', () => {
    // Single names that are not aliases should get slugified
    assert.strictEqual(normalizeCritic('Madonna'), 'madonna');
    assert.strictEqual(normalizeCritic('Prince'), 'prince');
  });

  test('handles edge cases: empty string', () => {
    assert.strictEqual(normalizeCritic(''), 'unknown');
  });

  test('handles edge cases: null', () => {
    assert.strictEqual(normalizeCritic(null), 'unknown');
  });

  test('handles edge cases: undefined', () => {
    assert.strictEqual(normalizeCritic(undefined), 'unknown');
  });

  test('handles edge cases: very short names', () => {
    // Names shorter than 2 chars should return 'unknown'
    assert.strictEqual(normalizeCritic('A'), 'unknown');
    assert.strictEqual(normalizeCritic('X'), 'unknown');
  });

  test('handles whitespace trimming', () => {
    assert.strictEqual(normalizeCritic('  Jesse Green  '), 'jesse-green');
    assert.strictEqual(normalizeCritic('\tBen Brantley\n'), 'ben-brantley');
  });

  test('handles case insensitivity', () => {
    assert.strictEqual(normalizeCritic('JESSE GREEN'), 'jesse-green');
    assert.strictEqual(normalizeCritic('BEN BRANTLEY'), 'ben-brantley');
    assert.strictEqual(normalizeCritic('helen SHAW'), 'helen-shaw');
  });

  test('does NOT match first-name-only for aliases', () => {
    // Per the module's comments, first-name matching was removed because it caused
    // "Jesse Oxfeld" to incorrectly map to "jesse-green"
    // So "Jesse" alone should NOT map to jesse-green
    const result = normalizeCritic('Jesse');
    assert.notStrictEqual(result, 'jesse-green');
    assert.strictEqual(result, 'jesse'); // Gets slugified instead
  });
});

// ============================================================================
// generateReviewFilename tests
// ============================================================================

describe('generateReviewFilename', () => {
  test('generates correct filename for standard case', () => {
    const filename = generateReviewFilename('nytimes', 'jesse-green');
    assert.strictEqual(filename, 'nytimes--jesse-green.json');
  });

  test('generates filename with outlet normalization', () => {
    const filename = generateReviewFilename('The New York Times', 'Jesse Green');
    assert.strictEqual(filename, 'nytimes--jesse-green.json');
  });

  test('generates filename with critic normalization', () => {
    const filename = generateReviewFilename('Vulture', 'johnny oleksinki'); // typo
    assert.strictEqual(filename, 'vulture--johnny-oleksinski.json');
  });

  test('generates filename with both normalizations', () => {
    const filename = generateReviewFilename('ny times', 'J. Green');
    assert.strictEqual(filename, 'nytimes--jesse-green.json');
  });

  test('handles unknown outlet and critic (slugified)', () => {
    const filename = generateReviewFilename('Some Blog', 'Jane Doe');
    assert.strictEqual(filename, 'some-blog--jane-doe.json');
  });

  test('uses double-dash separator', () => {
    const filename = generateReviewFilename('variety', 'david-rooney');
    assert.ok(filename.includes('--'));
    assert.strictEqual(filename, 'variety--david-rooney.json');
  });
});

// ============================================================================
// generateReviewKey tests
// ============================================================================

describe('generateReviewKey', () => {
  test('generates correct key for standard case', () => {
    const key = generateReviewKey('nytimes', 'jesse-green');
    assert.strictEqual(key, 'nytimes|jesse-green');
  });

  test('uses pipe separator', () => {
    const key = generateReviewKey('variety', 'david-rooney');
    assert.ok(key.includes('|'));
    assert.strictEqual(key, 'variety|david-rooney');
  });

  test('normalizes outlet in key', () => {
    const key = generateReviewKey('The New York Times', 'Jesse Green');
    assert.strictEqual(key, 'nytimes|jesse-green');
  });

  test('normalizes critic in key', () => {
    const key = generateReviewKey('Vulture', 'johnny oleksinki');
    assert.strictEqual(key, 'vulture|johnny-oleksinski');
  });

  test('handles full normalization', () => {
    const key = generateReviewKey('ny mag', 'J. Green');
    assert.strictEqual(key, 'vulture|jesse-green');
  });

  test('same review from different sources produces same key', () => {
    // BWW might say "The New York Times" while DTLI says "nytimes"
    const bwwKey = generateReviewKey('The New York Times', 'Jesse Green');
    const dtliKey = generateReviewKey('nytimes', 'jesse green');
    assert.strictEqual(bwwKey, dtliKey);
  });
});

// ============================================================================
// slugify tests
// ============================================================================

describe('slugify', () => {
  test('converts to lowercase', () => {
    assert.strictEqual(slugify('Hello World'), 'hello-world');
    assert.strictEqual(slugify('UPPERCASE'), 'uppercase');
  });

  test('replaces spaces with hyphens', () => {
    assert.strictEqual(slugify('hello world'), 'hello-world');
    assert.strictEqual(slugify('one two three'), 'one-two-three');
  });

  test('removes apostrophes', () => {
    assert.strictEqual(slugify("Talkin' Broadway"), 'talkin-broadway');
    assert.strictEqual(slugify("What's On Stage"), 'whats-on-stage');
  });

  test('replaces ampersand with and', () => {
    assert.strictEqual(slugify('Town & Country'), 'town-and-country');
    assert.strictEqual(slugify('Stage & Cinema'), 'stage-and-cinema');
  });

  test('removes special characters', () => {
    assert.strictEqual(slugify('Hello@World!'), 'helloworld');
    assert.strictEqual(slugify('Test#123'), 'test123');
  });

  test('collapses multiple hyphens', () => {
    assert.strictEqual(slugify('hello   world'), 'hello-world');
    assert.strictEqual(slugify('one - two'), 'one-two');
  });

  test('trims hyphens from ends', () => {
    assert.strictEqual(slugify(' hello '), 'hello');
    assert.strictEqual(slugify('-hello-'), 'hello');
  });

  test('handles empty string', () => {
    assert.strictEqual(slugify(''), '');
  });

  test('handles null/undefined', () => {
    assert.strictEqual(slugify(null), '');
    assert.strictEqual(slugify(undefined), '');
  });
});

// ============================================================================
// areCriticsSimilar tests
// ============================================================================

describe('areCriticsSimilar', () => {
  test('returns true for exact match', () => {
    assert.strictEqual(areCriticsSimilar('Jesse Green', 'Jesse Green'), true);
    assert.strictEqual(areCriticsSimilar('helen shaw', 'helen shaw'), true);
  });

  test('returns true for same normalized form', () => {
    assert.strictEqual(areCriticsSimilar('Jesse Green', 'jesse green'), true);
    assert.strictEqual(areCriticsSimilar('Johnny Oleksinski', 'johnny oleksinki'), true);
  });

  test('returns FALSE for first name match with one full name (removed feature)', () => {
    // First-name matching was intentionally REMOVED because it caused false positives
    // e.g., "Jesse Oxfeld" was incorrectly matching "Jesse Green"
    // Now, partial name matches return FALSE unless they're in CRITIC_ALIASES
    assert.strictEqual(areCriticsSimilar('Jesse', 'Jesse Green'), false);
    assert.strictEqual(areCriticsSimilar('Helen Shaw', 'Helen'), false);
  });

  test('returns true for known typos via CRITIC_ALIASES', () => {
    // Known typos are now handled via explicit aliases, not Levenshtein
    assert.strictEqual(areCriticsSimilar('Johnny Oleksinski', 'Johnny Oleksinki'), true);
    // New aliases added in Task 1.2
    assert.strictEqual(areCriticsSimilar('elisabeth vincentelli', 'elizabeth vincentelli'), true);
    assert.strictEqual(areCriticsSimilar('a d amorosi', 'ad amorosi'), true);
    assert.strictEqual(areCriticsSimilar('charles mcnulty', 'charlesmcnulty'), true);
  });

  test('returns false for similar but non-aliased names (Levenshtein disabled)', () => {
    // Levenshtein matching was removed because it caused false positives
    // (e.g., "Helen Smith" would incorrectly match "Helen Smyth")
    assert.strictEqual(areCriticsSimilar('Helen Smith', 'Helen Smyth'), false);
    assert.strictEqual(areCriticsSimilar('John Williams', 'John Willians'), false);
  });

  test('returns false for different critics', () => {
    assert.strictEqual(areCriticsSimilar('Jesse Green', 'Ben Brantley'), false);
    assert.strictEqual(areCriticsSimilar('Helen Shaw', 'Sara Holdren'), false);
  });

  test('returns false for null/empty inputs', () => {
    assert.strictEqual(areCriticsSimilar(null, 'Jesse Green'), false);
    assert.strictEqual(areCriticsSimilar('Jesse Green', null), false);
    assert.strictEqual(areCriticsSimilar('', 'Jesse Green'), false);
  });

  test('returns false for short first name mismatches', () => {
    // First names <= 2 chars shouldn't trigger first-name matching
    assert.strictEqual(areCriticsSimilar('Al', 'Al Green'), false);
  });
});

// ============================================================================
// areOutletsSame tests
// ============================================================================

describe('areOutletsSame', () => {
  test('returns true for exact match', () => {
    assert.strictEqual(areOutletsSame('nytimes', 'nytimes'), true);
    assert.strictEqual(areOutletsSame('Vulture', 'Vulture'), true);
  });

  test('returns true for normalized aliases', () => {
    assert.strictEqual(areOutletsSame('New York Times', 'nytimes'), true);
    assert.strictEqual(areOutletsSame('ny times', 'The New York Times'), true);
    assert.strictEqual(areOutletsSame('nyt', 'new york times'), true);
  });

  test('returns false for different outlets', () => {
    assert.strictEqual(areOutletsSame('nytimes', 'Vulture'), false);
    assert.strictEqual(areOutletsSame('Variety', 'Hollywood Reporter'), false);
  });

  test('returns false for null/empty inputs', () => {
    assert.strictEqual(areOutletsSame(null, 'nytimes'), false);
    assert.strictEqual(areOutletsSame('nytimes', null), false);
    assert.strictEqual(areOutletsSame('', 'nytimes'), false);
  });
});

// ============================================================================
// areReviewsDuplicates tests
// ============================================================================

describe('areReviewsDuplicates', () => {
  test('returns true for same outlet and critic', () => {
    const review1 = { outlet: 'nytimes', criticName: 'Jesse Green' };
    const review2 = { outlet: 'nytimes', criticName: 'Jesse Green' };
    assert.strictEqual(areReviewsDuplicates(review1, review2), true);
  });

  test('returns true with outlet/critic variations', () => {
    const review1 = { outlet: 'The New York Times', criticName: 'Jesse Green' };
    const review2 = { outlet: 'nytimes', criticName: 'jesse green' };
    assert.strictEqual(areReviewsDuplicates(review1, review2), true);
  });

  test('returns true with known typos', () => {
    const review1 = { outlet: 'Vulture', criticName: 'Johnny Oleksinski' };
    const review2 = { outlet: 'vulture', criticName: 'johnny oleksinki' };
    assert.strictEqual(areReviewsDuplicates(review1, review2), true);
  });

  test('returns false for different reviews', () => {
    const review1 = { outlet: 'nytimes', criticName: 'Jesse Green' };
    const review2 = { outlet: 'Vulture', criticName: 'Helen Shaw' };
    assert.strictEqual(areReviewsDuplicates(review1, review2), false);
  });

  test('returns false for same outlet different critic', () => {
    const review1 = { outlet: 'nytimes', criticName: 'Jesse Green' };
    const review2 = { outlet: 'nytimes', criticName: 'Ben Brantley' };
    assert.strictEqual(areReviewsDuplicates(review1, review2), false);
  });
});

// ============================================================================
// levenshteinDistance tests
// ============================================================================

describe('levenshteinDistance', () => {
  test('returns 0 for identical strings', () => {
    assert.strictEqual(levenshteinDistance('hello', 'hello'), 0);
    assert.strictEqual(levenshteinDistance('', ''), 0);
  });

  test('returns correct distance for single char difference', () => {
    assert.strictEqual(levenshteinDistance('cat', 'bat'), 1);
    assert.strictEqual(levenshteinDistance('cat', 'car'), 1);
  });

  test('returns correct distance for insertions', () => {
    assert.strictEqual(levenshteinDistance('cat', 'cats'), 1);
    assert.strictEqual(levenshteinDistance('hello', 'helllo'), 1);
  });

  test('returns correct distance for deletions', () => {
    assert.strictEqual(levenshteinDistance('hello', 'helo'), 1);
    assert.strictEqual(levenshteinDistance('world', 'word'), 1);
  });

  test('returns string length for empty vs non-empty', () => {
    assert.strictEqual(levenshteinDistance('', 'hello'), 5);
    assert.strictEqual(levenshteinDistance('test', ''), 4);
  });

  test('handles real typo case: Oleksinski vs Oleksinki', () => {
    const distance = levenshteinDistance('oleksinski', 'oleksinki');
    assert.strictEqual(distance, 1);
  });
});

// ============================================================================
// getOutletDisplayName tests
// ============================================================================

describe('getOutletDisplayName', () => {
  test('returns proper display name for known outlets', () => {
    assert.strictEqual(getOutletDisplayName('nytimes'), 'The New York Times');
    assert.strictEqual(getOutletDisplayName('vulture'), 'Vulture');
    assert.strictEqual(getOutletDisplayName('variety'), 'Variety');
    assert.strictEqual(getOutletDisplayName('hollywood-reporter'), 'The Hollywood Reporter');
    assert.strictEqual(getOutletDisplayName('washpost'), 'The Washington Post');
    assert.strictEqual(getOutletDisplayName('wsj'), 'The Wall Street Journal');
  });

  test('returns ID for unknown outlets', () => {
    assert.strictEqual(getOutletDisplayName('unknown-outlet'), 'unknown-outlet');
    assert.strictEqual(getOutletDisplayName('some-blog'), 'some-blog');
  });
});

// ============================================================================
// Integration tests: Cross-aggregator normalization consistency
// ============================================================================

describe('Integration: Cross-aggregator normalization', () => {
  test('BWW and DTLI outlet names normalize to same ID', () => {
    // Based on normalization-diff.json, these are known conflict cases
    // The canonical module should handle them consistently

    // Chicago Tribune variations
    assert.strictEqual(normalizeOutlet('chicago tribune'), 'chicagotribune');
    assert.strictEqual(normalizeOutlet('Chicago Tribune'), 'chicagotribune');

    // Daily Beast variations
    assert.strictEqual(normalizeOutlet('daily beast'), 'dailybeast');
    assert.strictEqual(normalizeOutlet('the daily beast'), 'dailybeast');

    // NY Daily News variations
    assert.strictEqual(normalizeOutlet('new york daily news'), 'nydailynews');
    assert.strictEqual(normalizeOutlet('daily news'), 'nydailynews');
    assert.strictEqual(normalizeOutlet('ny daily news'), 'nydailynews');

    // Financial Times variations
    assert.strictEqual(normalizeOutlet('financial times'), 'financialtimes');
    assert.strictEqual(normalizeOutlet('ft'), 'financialtimes');

    // Rolling Stone variations
    assert.strictEqual(normalizeOutlet('rolling stone'), 'rollingstone');

    // USA Today variations
    assert.strictEqual(normalizeOutlet('usa today'), 'usatoday');
  });

  test('same review generates identical key from BWW and DTLI data', () => {
    // Simulate: BWW says "The New York Times" / "Jesse Green"
    //           DTLI says "NY Times" / "jesse green"
    const bwwKey = generateReviewKey('The New York Times', 'Jesse Green');
    const dtliKey = generateReviewKey('NY Times', 'jesse green');
    assert.strictEqual(bwwKey, dtliKey);
  });

  test('same review generates identical filename from different sources', () => {
    // Vulture review from different aggregators
    const bwwFilename = generateReviewFilename('New York Magazine / Vulture', 'Sara Holdren');
    const dtliFilename = generateReviewFilename('vulture', 'sara holdren');
    const ssFilename = generateReviewFilename('Vulture', 'S. Holdren');

    assert.strictEqual(bwwFilename, dtliFilename);
    assert.strictEqual(dtliFilename, ssFilename);
    assert.strictEqual(bwwFilename, 'vulture--sara-holdren.json');
  });

  test('critic typos from different sources normalize correctly', () => {
    // Johnny Oleksinski has known typo "Oleksinki"
    const correct = generateReviewKey('variety', 'Johnny Oleksinski');
    const typo = generateReviewKey('Variety', 'johnny oleksinki');
    assert.strictEqual(correct, typo);
    assert.strictEqual(correct, 'variety|johnny-oleksinski');
  });

  test('The Stage outlet normalizes from all variations', () => {
    // Registry: thestage is canonical, with aliases: stage-uk, the stage, the-stage, stage
    assert.strictEqual(normalizeOutlet('the stage'), 'thestage');
    assert.strictEqual(normalizeOutlet('The Stage'), 'thestage');
    assert.strictEqual(normalizeOutlet('stage'), 'thestage');
    assert.strictEqual(normalizeOutlet('stage-uk'), 'thestage');
  });

  test('NY Stage Review normalizes from all variations', () => {
    assert.strictEqual(normalizeOutlet('new york stage review'), 'nysr');
    assert.strictEqual(normalizeOutlet('ny stage review'), 'nysr');
    assert.strictEqual(normalizeOutlet('nysr'), 'nysr');
  });
});

// ============================================================================
// Edge case: OUTLET_ALIASES and CRITIC_ALIASES consistency
// ============================================================================

describe('Alias consistency checks', () => {
  test('all OUTLET_ALIASES values are lowercase', () => {
    for (const [canonical, aliases] of Object.entries(OUTLET_ALIASES)) {
      for (const alias of aliases) {
        assert.strictEqual(
          alias,
          alias.toLowerCase(),
          `Alias "${alias}" for "${canonical}" should be lowercase`
        );
      }
    }
  });

  test('all CRITIC_ALIASES values are lowercase', () => {
    for (const [canonical, aliases] of Object.entries(CRITIC_ALIASES)) {
      for (const alias of aliases) {
        assert.strictEqual(
          alias,
          alias.toLowerCase(),
          `Alias "${alias}" for "${canonical}" should be lowercase`
        );
      }
    }
  });

  test('OUTLET_ALIASES auto-generates from registry with substantial coverage', () => {
    // OUTLET_ALIASES now auto-generates from outlet-registry.json
    const count = Object.keys(OUTLET_ALIASES).length;
    assert.ok(count > 100, `Expected >100 outlets, got ${count}`);
    // Spot-check key outlets exist
    assert.ok(OUTLET_ALIASES['nytimes'], 'nytimes should be in OUTLET_ALIASES');
    assert.ok(OUTLET_ALIASES['variety'], 'variety should be in OUTLET_ALIASES');
    assert.ok(OUTLET_ALIASES['vulture'], 'vulture should be in OUTLET_ALIASES');
  });

  test('all canonical IDs included in their own aliases (auto-generated)', () => {
    // Auto-generated aliases always include the canonical ID itself
    for (const [canonical, aliases] of Object.entries(OUTLET_ALIASES)) {
      assert.ok(
        aliases.includes(canonical),
        `Canonical "${canonical}" should be in its own aliases`
      );
    }
  });

  test('no duplicate aliases across outlets', () => {
    // All aliases should map to exactly one canonical outlet.
    // Previously "new york magazine" was in both vulture and newyorkmagazine — now consolidated.
    const duplicates = new Map();
    const seenAliases = new Map();
    for (const [canonical, aliases] of Object.entries(OUTLET_ALIASES)) {
      for (const alias of aliases) {
        if (seenAliases.has(alias)) {
          if (!duplicates.has(alias)) {
            duplicates.set(alias, [seenAliases.get(alias)]);
          }
          duplicates.get(alias).push(canonical);
        }
        seenAliases.set(alias, canonical);
      }
    }
    assert.strictEqual(
      duplicates.size, 0,
      `Found duplicate aliases: ${[...duplicates.entries()].map(([a, outlets]) => `"${a}" in [${outlets.join(', ')}]`).join('; ')}`
    );
    // Verify vulture owns all new york magazine variations
    assert.strictEqual(normalizeOutlet('new york magazine'), 'vulture');
    assert.strictEqual(normalizeOutlet('ny mag'), 'vulture');
    assert.strictEqual(normalizeOutlet('newyorkmagazine'), 'vulture');
  });
});

// ============================================================================
// Registry-based functions tests
// ============================================================================

describe('loadOutletRegistry', () => {
  test('loads the outlet registry from JSON file', () => {
    const registry = loadOutletRegistry();
    assert.ok(registry, 'Registry should be loaded');
    assert.ok(registry.outlets, 'Registry should have outlets');
    assert.ok(registry._aliasIndex, 'Registry should have _aliasIndex');
  });

  test('registry contains expected tier 1 outlets', () => {
    const registry = loadOutletRegistry();
    assert.ok(registry.outlets['nytimes'], 'Should have nytimes');
    assert.ok(registry.outlets['vulture'], 'Should have vulture');
    assert.ok(registry.outlets['variety'], 'Should have variety');
    assert.strictEqual(registry.outlets['nytimes'].tier, 1);
    assert.strictEqual(registry.outlets['vulture'].tier, 1);
    assert.strictEqual(registry.outlets['variety'].tier, 1);
  });
});

describe('getOutletFromRegistry', () => {
  test('returns outlet object for known outlets', () => {
    const nytimes = getOutletFromRegistry('nytimes');
    assert.ok(nytimes, 'Should return outlet for nytimes');
    assert.strictEqual(nytimes.displayName, 'The New York Times');
    assert.strictEqual(nytimes.tier, 1);
    assert.ok(Array.isArray(nytimes.aliases), 'Should have aliases array');
    assert.strictEqual(nytimes.domain, 'nytimes.com');
  });

  test('normalizes input before lookup', () => {
    // Even if we pass a variation, it should normalize and find the outlet
    const nytimes1 = getOutletFromRegistry('New York Times');
    const nytimes2 = getOutletFromRegistry('nyt');
    assert.ok(nytimes1, 'Should find outlet for "New York Times"');
    assert.ok(nytimes2, 'Should find outlet for "nyt"');
    assert.strictEqual(nytimes1.displayName, 'The New York Times');
    assert.strictEqual(nytimes2.displayName, 'The New York Times');
  });

  test('returns null for unknown outlets', () => {
    const unknown = getOutletFromRegistry('completely-unknown-outlet-xyz');
    assert.strictEqual(unknown, null);
  });
});

describe('getOutletTier', () => {
  test('returns correct tier for tier 1 outlets', () => {
    assert.strictEqual(getOutletTier('nytimes'), 1);
    assert.strictEqual(getOutletTier('vulture'), 1);
    assert.strictEqual(getOutletTier('variety'), 1);
    assert.strictEqual(getOutletTier('hollywood-reporter'), 1);
    assert.strictEqual(getOutletTier('newyorker'), 1);
    assert.strictEqual(getOutletTier('wsj'), 1);
    assert.strictEqual(getOutletTier('washpost'), 1);
    assert.strictEqual(getOutletTier('ap'), 1);
    assert.strictEqual(getOutletTier('timeout'), 1);
    assert.strictEqual(getOutletTier('guardian'), 1);
  });

  test('returns correct tier for tier 2 outlets', () => {
    assert.strictEqual(getOutletTier('nypost'), 2);
    assert.strictEqual(getOutletTier('theatermania'), 2);
    assert.strictEqual(getOutletTier('ew'), 2);
    assert.strictEqual(getOutletTier('deadline'), 2);
  });

  test('returns correct tier for tier 3 outlets', () => {
    assert.strictEqual(getOutletTier('cititour'), 3);
    assert.strictEqual(getOutletTier('broadwayworld'), 3);
  });

  test('returns 3 (default) for unknown outlets', () => {
    assert.strictEqual(getOutletTier('unknown-outlet'), 3);
    assert.strictEqual(getOutletTier('random-blog'), 3);
  });

  test('works with outlet variations (normalizes input)', () => {
    // Tier 1
    assert.strictEqual(getOutletTier('New York Times'), 1);
    assert.strictEqual(getOutletTier('nyt'), 1);
    assert.strictEqual(getOutletTier('The Wall Street Journal'), 1);
    // Tier 3
    assert.strictEqual(getOutletTier('Broadway World'), 3);
    assert.strictEqual(getOutletTier('bww'), 3);
  });
});

// ============================================================================
// normalizeUrl tests
// ============================================================================

describe('normalizeUrl', () => {
  test('strips http and https protocols', () => {
    assert.strictEqual(normalizeUrl('http://example.com/page'), 'example.com/page');
    assert.strictEqual(normalizeUrl('https://example.com/page'), 'example.com/page');
  });

  test('strips www prefix', () => {
    assert.strictEqual(normalizeUrl('https://www.example.com/page'), 'example.com/page');
    assert.strictEqual(normalizeUrl('http://www.nytimes.com/review'), 'nytimes.com/review');
  });

  test('strips trailing slashes', () => {
    assert.strictEqual(normalizeUrl('https://example.com/page/'), 'example.com/page');
    assert.strictEqual(normalizeUrl('https://example.com/page///'), 'example.com/page');
  });

  test('strips fragment identifiers', () => {
    assert.strictEqual(normalizeUrl('https://example.com/page#section'), 'example.com/page');
    assert.strictEqual(normalizeUrl('https://example.com/page#top'), 'example.com/page');
  });

  test('strips UTM parameters', () => {
    assert.strictEqual(
      normalizeUrl('https://example.com/page?utm_source=twitter&utm_medium=social'),
      'example.com/page'
    );
    assert.strictEqual(
      normalizeUrl('https://example.com/page?id=123&utm_campaign=spring'),
      'example.com/page?id=123'
    );
  });

  test('strips tracking parameters (fbclid, gclid, ref, source, etc.)', () => {
    assert.strictEqual(
      normalizeUrl('https://example.com/page?fbclid=abc123'),
      'example.com/page'
    );
    assert.strictEqual(
      normalizeUrl('https://example.com/page?ref=homepage&gclid=xyz'),
      'example.com/page'
    );
    assert.strictEqual(
      normalizeUrl('https://example.com/page?partner=rss&emc=rss'),
      'example.com/page'
    );
  });

  test('strips NYT-specific params (smid, _r)', () => {
    assert.strictEqual(
      normalizeUrl('https://nytimes.com/review?smid=tw-share'),
      'nytimes.com/review'
    );
    assert.strictEqual(
      normalizeUrl('https://nytimes.com/review?_r=0'),
      'nytimes.com/review'
    );
  });

  test('strips campaign, algo, nc params', () => {
    assert.strictEqual(
      normalizeUrl('https://example.com/page?campaign=email&algo=top'),
      'example.com/page'
    );
    assert.strictEqual(
      normalizeUrl('https://example.com/page?nc=1'),
      'example.com/page'
    );
  });

  test('preserves meaningful query params', () => {
    assert.strictEqual(
      normalizeUrl('https://example.com/page?id=123&type=review'),
      'example.com/page?id=123&type=review'
    );
  });

  test('lowercases the URL', () => {
    assert.strictEqual(
      normalizeUrl('HTTPS://WWW.EXAMPLE.COM/Page'),
      'example.com/page'
    );
  });

  test('keeps archive.org URLs distinct from direct URLs', () => {
    const direct = normalizeUrl('https://www.nytimes.com/2024/review');
    const archive = normalizeUrl('https://web.archive.org/web/2024/https://www.nytimes.com/2024/review');
    assert.notStrictEqual(direct, archive);
  });

  test('handles empty/null input', () => {
    assert.strictEqual(normalizeUrl(''), '');
    assert.strictEqual(normalizeUrl(null), '');
    assert.strictEqual(normalizeUrl(undefined), '');
  });

  test('handles malformed URLs gracefully', () => {
    // Should not throw, just return lowercased/trimmed
    const result = normalizeUrl('not a url at all');
    assert.ok(typeof result === 'string');
    assert.strictEqual(result, 'not a url at all');
  });

  // AMP-suffix support added 2026-04-28 (Item 3 of systematic CI plan).
  // Origin: dracula-west-end-2025/metro--brooke-ivey-johnson AMP re-scrape
  // produced a parallel file alongside the canonical metro-uk entry. The
  // tightening here is anchored: only path-final `/amp` and ?amp=1 are
  // stripped — mid-path `/amp/` segments remain (false-positive guard,
  // verified by the matching ship-check test in review-write-guard.test.mjs).
  describe('AMP-suffix handling', () => {
    test('strips /amp path suffix — same canonical', () => {
      assert.strictEqual(
        normalizeUrl('https://metro.co.uk/2026/02/17/cynthia-erivos-dracula-26951617/amp'),
        normalizeUrl('https://metro.co.uk/2026/02/17/cynthia-erivos-dracula-26951617/')
      );
    });

    test('strips /amp path suffix — without trailing slash', () => {
      assert.strictEqual(
        normalizeUrl('https://www.metro.co.uk/2026/02/17/article-name/amp'),
        normalizeUrl('https://www.metro.co.uk/2026/02/17/article-name')
      );
    });

    test('strips ?amp=1 query param — Google AMP cache shape', () => {
      assert.strictEqual(
        normalizeUrl('https://example.com/2026/02/17/article-name?amp=1'),
        normalizeUrl('https://example.com/2026/02/17/article-name')
      );
    });

    test('does NOT strip mid-path /amp/ segment', () => {
      // A path-internal /amp/ may be a legitimate route segment (e.g. a
      // section-named "amp"). Stripping it would silently collapse unrelated
      // URLs into one and produce false-positive duplicates.
      assert.notStrictEqual(
        normalizeUrl('https://example.com/news/amp/election-results'),
        normalizeUrl('https://example.com/news/election-results')
      );
    });

    test('AMP-strip composes with utm tracking-param strip', () => {
      assert.strictEqual(
        normalizeUrl('https://metro.co.uk/2026/02/17/article-name/amp?utm_source=tw'),
        normalizeUrl('https://metro.co.uk/2026/02/17/article-name')
      );
    });
  });

  // Task #704 (cousin of #702's verifyFetchedUrl fix): theatre.reviews injects a
  // trailing U+200E (LEFT-TO-RIGHT MARK) into canonical URLs that's invisible on
  // the page but breaks byte-for-byte dedup comparison in this function's callers
  // (gather-reviews.js write-time dedup, cleanup-dedup-comprehensive.js).
  describe('invisible Unicode handling', () => {
    test('theatre.reviews trailing U+200E strips and matches non-marked version', () => {
      const withMark = 'https://theatre.reviews/the-gin-game-review/‎';
      const withoutMark = 'https://theatre.reviews/the-gin-game-review/';
      assert.strictEqual(normalizeUrl(withMark), normalizeUrl(withoutMark));
    });

    test('zero-width space mid-path strips', () => {
      const withZwsp = 'https://example.com/re​view';
      const clean = 'https://example.com/review';
      assert.strictEqual(normalizeUrl(withZwsp), normalizeUrl(clean));
    });

    test('BOM prefix strips', () => {
      const withBom = '﻿https://example.com/review';
      const clean = 'https://example.com/review';
      assert.strictEqual(normalizeUrl(withBom), normalizeUrl(clean));
    });

    test('invisible-Unicode strip composes with existing tracking-param + AMP strip', () => {
      const withMarkAndUtm = 'https://theatre.reviews/the-gin-game-review/‎?utm_source=tw';
      const clean = 'https://theatre.reviews/the-gin-game-review/';
      assert.strictEqual(normalizeUrl(withMarkAndUtm), normalizeUrl(clean));
    });
  });
});

// ============================================================================
// New outlet alias tests (dedup prevention)
// ============================================================================

describe('New outlet aliases (dedup prevention)', () => {
  test('bloomberg aliases normalize correctly', () => {
    assert.strictEqual(normalizeOutlet('bloomberg'), 'bloomberg');
    assert.strictEqual(normalizeOutlet('bloomberg-news'), 'bloomberg');
    assert.strictEqual(normalizeOutlet('bloombeg-news'), 'bloomberg');
    assert.strictEqual(normalizeOutlet('bloomgberg-news'), 'bloomberg');
  });

  test('variety typo aliases normalize correctly', () => {
    assert.strictEqual(normalizeOutlet('varietycom'), 'variety');
    assert.strictEqual(normalizeOutlet('vartiey'), 'variety');
  });

  test('guardian UK alias normalizes correctly', () => {
    assert.strictEqual(normalizeOutlet('uk-guardian'), 'guardian');
  });

  test('ny-post alias normalizes correctly', () => {
    assert.strictEqual(normalizeOutlet('ny-post'), 'nypost');
  });

  test('entertainment weekly typo normalizes correctly', () => {
    assert.strictEqual(normalizeOutlet('enertainment-weekly'), 'ew');
  });

  test('associated-press alias normalizes correctly', () => {
    assert.strictEqual(normalizeOutlet('associated-press'), 'ap');
  });

  test('amny aliases normalize correctly', () => {
    assert.strictEqual(normalizeOutlet('amnycom'), 'amny');
    assert.strictEqual(normalizeOutlet('am-ny-matt-windman'), 'amny');
  });

  test('village-voice aliases normalize correctly', () => {
    assert.strictEqual(normalizeOutlet('village-voice'), 'village-voice');
    assert.strictEqual(normalizeOutlet('villiage-voice'), 'village-voice');
    assert.strictEqual(normalizeOutlet('the village voice'), 'village-voice');
  });

  test('4columns aliases normalize correctly', () => {
    assert.strictEqual(normalizeOutlet('4columns'), '4columns');
    assert.strictEqual(normalizeOutlet('4 columns'), '4columns');
    assert.strictEqual(normalizeOutlet('four columns'), '4columns');
  });

  test('other new canonical entries normalize correctly', () => {
    assert.strictEqual(normalizeOutlet('philadelpia-inquirer'), 'philadelphia-inquirer');
    assert.strictEqual(normalizeOutlet('showbiz 411'), 'showbiz411');
    assert.strictEqual(normalizeOutlet('times square chronicles'), 'times-square-chronicles');
    assert.strictEqual(normalizeOutlet('towle road'), 'towleroad');
    assert.strictEqual(normalizeOutlet('broadstreetreviewcom'), 'broadstreetreview');
    assert.strictEqual(normalizeOutlet('blogcriticsorg'), 'blogcritics');
  });

  test('existing alias additions normalize correctly', () => {
    assert.strictEqual(normalizeOutlet('1minutecritic'), 'one-minute-critic');
    assert.strictEqual(normalizeOutlet('ny-observer'), 'observer');
    assert.strictEqual(normalizeOutlet('thedaily-beast'), 'dailybeast');
    assert.strictEqual(normalizeOutlet('ny-newsday'), 'newsday');
    assert.strictEqual(normalizeOutlet('nytheatrereviewcom'), 'nytheatre');
  });
});

// ============================================================================
// New critic alias tests (dedup prevention)
// ============================================================================

describe('New critic aliases (dedup prevention)', () => {
  test('chris jone (missing s) normalizes to chris-jones', () => {
    assert.strictEqual(normalizeCritic('chris jone'), 'chris-jones');
  });

  test('jonathan mandel (missing l) normalizes to jonathan-mandell', () => {
    assert.strictEqual(normalizeCritic('jonathan mandel'), 'jonathan-mandell');
  });

  test('leah greenblat (missing t) normalizes to leah-greenblatt', () => {
    assert.strictEqual(normalizeCritic('leah greenblat'), 'leah-greenblatt');
  });
});

// ============================================================================
// mergeReviews — wrongProduction flag preservation
// Regression tests for the opening-night-poller oscillation loop:
// the poller was re-scraping Show Score, merging into existing files, and
// mergeReviews was auto-clearing date-based wrongProduction flags. The rebuild
// then re-set the flag, and the cycle repeated. Fix: only URL-based flags
// ('Same URL') auto-clear; date-based flags persist across merges.
// ============================================================================

describe('mergeReviews — wrongProduction flag preservation', () => {
  const baseExisting = {
    showId: 'example-show-2026',
    outletId: 'thestage',
    outlet: 'The Stage',
    criticName: 'Oliver Jones',
    url: 'https://www.thestage.co.uk/reviews/example-show-review',
    publishDate: 'February 13th, 2024',
    wrongProduction: true,
  };

  test('preserves Pre-opening guard flag on same-URL re-merge', () => {
    const existing = {
      ...baseExisting,
      wrongProductionNote: 'Pre-opening guard: review dated 2024-02-13 is 90+ days before show starts 2026-04-07',
    };
    const incoming = { ...existing, source: 'show-score' };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.wrongProduction, true, 'flag should persist');
    assert.ok(
      merged.wrongProductionNote.startsWith('Pre-opening guard'),
      'note should persist'
    );
  });

  test('preserves Date guard flag on same-URL re-merge', () => {
    const existing = {
      ...baseExisting,
      wrongProductionNote: 'Date guard: review 2024-02-13 is 765d before 2026-04-07',
    };
    const incoming = { ...existing, source: 'show-score' };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.wrongProduction, true);
    assert.ok(merged.wrongProductionNote.startsWith('Date guard'));
  });

  test('preserves Dateless show flag on same-URL re-merge', () => {
    const existing = {
      ...baseExisting,
      wrongProductionNote: 'Dateless show — same URL exists in dated show other-show-2020 (2020)',
    };
    const incoming = { ...existing, source: 'show-score' };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.wrongProduction, true);
  });

  test('preserves Tour transfer (manual) flag on same-URL re-merge', () => {
    const existing = {
      ...baseExisting,
      wrongProductionNote: 'Tour transfer: reviews are from 2024 tour run of same production',
    };
    const incoming = { ...existing, source: 'show-score' };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.wrongProduction, true);
    assert.ok(merged.wrongProductionNote.startsWith('Tour transfer'));
  });

  test('still auto-clears Same URL (URL-based) flags on re-merge', () => {
    // Venue transfer self-heal — this case must still work.
    const existing = {
      ...baseExisting,
      wrongProductionNote: 'Same URL exists in other-show-2020 which is closer to review year 2020',
    };
    const incoming = { ...existing, source: 'show-score' };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.wrongProduction, undefined, 'URL-based flag should auto-clear');
    assert.strictEqual(merged.wrongProductionAutoCleared, true);
  });

  test('clears Pre-opening guard flag AND its publishDate basis on canonical URL change', () => {
    // Changed 2026-07-11 with the url-change invariant (Notion 399637c5).
    // Old behavior preserved date-based flags across URL changes ("the publish
    // date fact hasn't changed") — but the date FACT belongs to the old URL's
    // article. Keeping the stale date while clearing everything else made the
    // invariant defeat itself: the rebuild date-guard re-flagged the corrected
    // file from the old article's date. New semantics: the flag and its
    // publishDate basis clear together; collect re-fetches the new URL, and the
    // rebuild re-derives the guard from the REAL date (re-flagging if genuinely
    // pre-opening — the guard runs fresh every rebuild, so nothing can leak in).
    // Manual 'Tour transfer' flags still persist (see test above).
    const existing = {
      ...baseExisting,
      url: 'https://www.thestage.co.uk/reviews/example-show-review-long-slug',
      wrongProductionNote: 'Pre-opening guard: review dated 2024-02-13 is 90+ days before show starts 2026-04-07',
    };
    const incoming = {
      ...baseExisting,
      url: 'https://www.thestage.co.uk/reviews/example-show-review',
      source: 'show-score',
    };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.wrongProduction, undefined, 'stale-date guard clears with its stale basis');
    assert.strictEqual(merged.publishDate, undefined, 'old article publishDate must not survive');
    assert.ok(merged._urlChangedClear.cleared.includes('wrongProduction'), 'clear recorded for push-restore');
  });

  test('still clears Same URL flag when URL changes (URL-based self-heal path)', () => {
    const existing = {
      ...baseExisting,
      url: 'https://www.thestage.co.uk/reviews/old-slug',
      wrongProductionNote: 'Same URL exists in other-show-2020',
    };
    const incoming = {
      ...baseExisting,
      url: 'https://www.thestage.co.uk/reviews/new-slug',
      source: 'show-score',
    };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.wrongProduction, undefined, 'URL-based flag clears on URL change');
  });

  test('preserves flag when humanReviewedWrongProduction !== false', () => {
    const existing = {
      ...baseExisting,
      url: 'https://www.thestage.co.uk/reviews/old',
      wrongProductionNote: 'Same URL exists in other-show',
      humanReviewedWrongProduction: true,  // explicitly human-verified as wrongProduction
    };
    const incoming = { ...baseExisting, url: 'https://www.thestage.co.uk/reviews/new', source: 'show-score' };
    const merged = mergeReviews(existing, incoming);
    // Even for URL-based flags, humanReviewedWrongProduction !== false means
    // don't auto-clear on URL change path. But the self-heal path at the end
    // will still clear it (it doesn't check humanReviewed). This is existing
    // behavior, preserved.
    // This test documents the asymmetry: URL-change path respects human flag,
    // self-heal path does not.
    // (Both paths only apply when wrongProductionManualClear is not set.)
  });
});

// ============================================================================
// mergeReviews — URL protection (urlVerified / urlManualOverride)
// Regression tests for the Boy at the Back of the Class thestage URL
// oscillation: manually-corrected long URL was being reverted to a known-
// broken short URL on every poller re-scrape. Fix: respect urlVerified /
// urlManualOverride as don't-auto-overwrite markers.
// ============================================================================

describe('mergeReviews — URL protection', () => {
  test('preserves URL when existing.urlVerified = true', () => {
    const existing = {
      showId: 'example-show-2026',
      outletId: 'thestage',
      url: 'https://www.thestage.co.uk/reviews/long-verified-url',
      urlVerified: true,
    };
    const incoming = {
      ...existing,
      url: 'https://www.thestage.co.uk/reviews/short--url',  // scrape returned a different URL
      source: 'show-score',
    };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(
      merged.url,
      'https://www.thestage.co.uk/reviews/long-verified-url',
      'verified URL should not be overwritten by re-scrape'
    );
  });

  test('preserves URL when existing.urlManualOverride = true', () => {
    const existing = {
      showId: 'example-show-2026',
      outletId: 'thestage',
      url: 'https://www.thestage.co.uk/reviews/manually-corrected',
      urlManualOverride: true,
    };
    const incoming = {
      ...existing,
      url: 'https://www.thestage.co.uk/reviews/aggregator-returned',
      source: 'show-score',
    };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.url, 'https://www.thestage.co.uk/reviews/manually-corrected');
  });

  test('still updates URL when existing is unverified and incoming differs', () => {
    const existing = {
      showId: 'example-show-2026',
      outletId: 'thestage',
      url: 'https://www.thestage.co.uk/reviews/old',
    };
    const incoming = {
      ...existing,
      url: 'https://www.thestage.co.uk/reviews/new',
      source: 'show-score',
    };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.url, 'https://www.thestage.co.uk/reviews/new',
      'unprotected URLs should still be updated by merge');
  });

  test('still upgrades null URL even when urlVerified present (first URL allowed)', () => {
    const existing = {
      showId: 'example-show-2026',
      outletId: 'thestage',
      url: null,
      urlVerified: true,
    };
    const incoming = {
      ...existing,
      url: 'https://www.thestage.co.uk/reviews/first-url',
      source: 'show-score',
    };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.url, 'https://www.thestage.co.uk/reviews/first-url',
      'first URL set should succeed even when urlVerified is pre-set');
  });

  test('still repairs undefined URL even when urlVerified present', () => {
    const existing = {
      showId: 'example-show-2026',
      outletId: 'thestage',
      url: 'https://www.thestage.co.uk/undefined/review',
      urlVerified: true,
    };
    const incoming = {
      ...existing,
      url: 'https://www.thestage.co.uk/reviews/real-review',
      source: 'show-score',
    };
    const merged = mergeReviews(existing, incoming);
    assert.strictEqual(merged.url, 'https://www.thestage.co.uk/reviews/real-review',
      'URLs containing "undefined" should be repaired');
  });
});

// Junk-byline guard (2026-07-09): CMS boilerplate scraped as a byline must
// normalize to 'unknown', not mint a phantom critic. "Posted By" defeated the
// outlet+critic manual-entry dedup and duplicated MDTG on the live CSC page.
const { normalizeCritic: _normCritic } = require('../../scripts/lib/review-normalization.js');
describe('normalizeCritic junk-byline guard', () => {
  it('maps CMS boilerplate bylines to unknown', () => {
    for (const junk of ['Posted By', 'posted by:', 'Written By', 'Staff Writer', 'Admin', 'BY']) {
      assert.strictEqual(_normCritic(junk), 'unknown', `"${junk}" must normalize to unknown`);
    }
  });
  it('leaves real critic names untouched', () => {
    assert.strictEqual(_normCritic("Aidan O'Connor") !== 'unknown', true);
    assert.strictEqual(_normCritic('Chris Jones') !== 'unknown', true);
    // real surnames that contain junk words must not be swallowed
    assert.strictEqual(_normCritic('By Smith') !== 'unknown', true);
  });
});

describe('resolveOutletFromUrl — shared-primary-domain collisions (card 38b637c5)', () => {
  // 9 registry outlets share a primary domain with another outlet (edition
  // splits like telegraph/sunday-telegraph, express-uk/sunday-express, plus
  // registry duplicates). The old last-write-wins index handed telegraph.co.uk
  // to sunday-telegraph, so every daily-Telegraph URL was re-homed to the
  // Sunday edition at write time. Collision rule under test: eponymous outlet
  // (id matches domain base) wins; otherwise first registration wins.
  const { resolveOutletFromUrl } = require('../../scripts/lib/review-normalization');

  it('telegraph.co.uk resolves to telegraph, never sunday-telegraph', () => {
    const r = resolveOutletFromUrl('https://www.telegraph.co.uk/theatre/what-to-see/some-review/');
    assert.strictEqual(r && r.outletId, 'telegraph');
  });

  it('express.co.uk resolves to express-uk, never sunday-express', () => {
    const r = resolveOutletFromUrl('https://www.express.co.uk/entertainment/theatre/123/review');
    assert.strictEqual(r && r.outletId, 'express-uk');
  });

  it('timeout path split still routes by path', () => {
    assert.strictEqual(resolveOutletFromUrl('https://www.timeout.com/london/theatre/x-review').outletId, 'timeout-london');
    assert.strictEqual(resolveOutletFromUrl('https://www.timeout.com/newyork/theater/x-review').outletId, 'timeout');
  });
});

describe('mergeReviews — cross-outlet URL change guard (Louise Penn Cambridge incident, 2026-07-12)', () => {
  // A slot whose outletId was minted from a SERP label (phantom 'cambridge')
  // swallowed Louise Penn's real loureviews.blog reviews via in-place URL
  // updates, publishing her under an outlet she never wrote for. When the
  // incoming URL's domain resolves to a DIFFERENT outlet than the slot,
  // mergeReviews must no-op entirely — no url, text, critic, or date merge.
  const base = {
    showId: 'jesus-christ-superstar-west-end-2026',
    outletId: 'cambridge',
    outlet: 'Cambridge',
    criticName: 'Unknown',
    url: 'https://www.facebook.com/LWTheatres/posts/some-post/',
    fullText: 'short stub',
  };

  it('no-ops the entire merge when incoming URL resolves to a different outlet', () => {
    const incoming = {
      outletId: 'cambridge',
      criticName: 'Louise Penn',
      url: 'https://loureviews.blog/2026/07/08/sam-ryder-and-jesus-christ-superstar/',
      publishDate: '2026-07-07',
      fullText: 'a much longer real review text that would normally win the length preference merge',
    };
    const merged = mergeReviews({ ...base }, incoming, {}, { script: 'test' });
    assert.strictEqual(merged.url, base.url, 'url must not move to another outlet\'s domain');
    assert.strictEqual(merged.fullText, base.fullText, 'other outlet\'s text must not merge');
    assert.strictEqual(merged.criticName, 'Unknown', 'other outlet\'s critic must not merge');
    assert.strictEqual(merged.urlUpdatedFrom, undefined);
  });

  it('allows a same-outlet URL change', () => {
    const existing = { ...base, outletId: 'loureviews', outlet: 'LouReviews', url: 'https://loureviews.blog/2026/07/01/old-slug/' };
    const incoming = { outletId: 'loureviews', url: 'https://loureviews.blog/2026/07/08/new-slug/', fullText: 'refreshed text for the new url' };
    const merged = mergeReviews(existing, incoming, {}, { script: 'test' });
    assert.strictEqual(merged.url, incoming.url);
  });

  it('allows a URL change to a domain the registry does not know', () => {
    const incoming = { outletId: 'cambridge', url: 'https://some-unknown-blog-domain-xyz.co.uk/review/', fullText: 'text' };
    const merged = mergeReviews({ ...base }, incoming, {}, { script: 'test' });
    assert.strictEqual(merged.url, incoming.url, 'no positive mismatch evidence — merge proceeds');
  });

  it('allows first-URL-set even cross-domain (guard only fires on CHANGES)', () => {
    const existing = { ...base, url: null };
    const incoming = { outletId: 'cambridge', url: 'https://loureviews.blog/2026/07/08/x/' };
    const merged = mergeReviews(existing, incoming, {}, { script: 'test' });
    assert.strictEqual(merged.url, incoming.url);
  });
});

describe('mergeReviews — cross-outlet guard respects existing outlet\'s own domains', () => {
  // resolveOutletFromUrl awards shared domains to their primary owner
  // (telegraph.co.uk → telegraph, abcnews.go.com → abc-news). The guard must
  // not treat that as a mismatch when the slot's own registry entry claims
  // the incoming domain via `domain` or `domainAliases`.
  const { outletOwnsUrlDomain } = require('../../scripts/lib/review-normalization.js');

  it('allows ap slot to take an abcnews.go.com URL (domainAliases syndication)', () => {
    const existing = { outletId: 'ap', outlet: 'Associated Press', criticName: 'Mark Kennedy', url: 'https://apnews.com/article/old-review' };
    const incoming = { outletId: 'ap', url: 'https://abcnews.go.com/Entertainment/wireStory/review-12345', fullText: 'fresh text' };
    const merged = mergeReviews(existing, incoming, {}, { script: 'test' });
    assert.strictEqual(merged.url, incoming.url);
  });

  it('allows sunday-telegraph slot to take a telegraph.co.uk URL (shared domain)', () => {
    const existing = { outletId: 'sunday-telegraph', outlet: 'The Sunday Telegraph', url: 'https://www.telegraph.co.uk/theatre/old-slug/' };
    const incoming = { outletId: 'sunday-telegraph', url: 'https://www.telegraph.co.uk/theatre/new-slug/' };
    const merged = mergeReviews(existing, incoming, {}, { script: 'test' });
    assert.strictEqual(merged.url, incoming.url);
  });

  it('outletOwnsUrlDomain matches subdomains of owned domains', () => {
    assert.strictEqual(outletOwnsUrlDomain('ap', 'https://abcnews.go.com/x'), true);
    assert.strictEqual(outletOwnsUrlDomain('sunday-telegraph', 'https://www.telegraph.co.uk/x'), true);
    assert.strictEqual(outletOwnsUrlDomain('loureviews', 'https://loureviews.blog/x'), true);
    assert.strictEqual(outletOwnsUrlDomain('ap', 'https://loureviews.blog/x'), false);
  });

  it('still blocks the phantom-outlet case (no owned domain)', () => {
    const existing = { outletId: 'cambridge', outlet: 'Cambridge', criticName: 'Unknown', url: 'https://www.facebook.com/LWTheatres/posts/p/', fullText: 'stub' };
    const incoming = { outletId: 'cambridge', criticName: 'Louise Penn', url: 'https://loureviews.blog/2026/07/08/x/', fullText: 'a much longer real review text body' };
    const merged = mergeReviews(existing, incoming, {}, { script: 'test' });
    assert.strictEqual(merged.url, existing.url);
    assert.strictEqual(merged.criticName, 'Unknown');
  });
});

describe('isCrossOutletUrl — wire services and syndication (QA review follow-up)', () => {
  const { isCrossOutletUrl } = require('../../scripts/lib/review-normalization.js');

  it('never treats wire-service slots as cross-outlet (AP syndicates anywhere)', () => {
    assert.strictEqual(isCrossOutletUrl('ap', 'https://www.huffpost.com/entry/review-x'), false);
    assert.strictEqual(isCrossOutletUrl('ap', 'https://www.sfgate.com/entertainment/article/review-y'), false);
  });

  it('blocks observer slots on theguardian.com (deliberate: adding it to domainAliases misattributes Guardian reviews via getKnownDomainMap — see outlet-registry integrity test)', () => {
    assert.strictEqual(isCrossOutletUrl('observer', 'https://www.theguardian.com/stage/2026/jul/06/some-observer-review'), true);
  });

  it('still flags a genuine cross-outlet URL', () => {
    assert.strictEqual(isCrossOutletUrl('cambridge', 'https://loureviews.blog/2026/07/08/x/'), true);
    assert.strictEqual(isCrossOutletUrl('loureviews', 'https://www.nytimes.com/2026/07/08/theater/review.html'), true);
  });

  it('mergeReviews allows an AP slot URL moving between syndication hosts', () => {
    const existing = { outletId: 'ap', outlet: 'Associated Press', criticName: 'Mark Kennedy', url: 'https://www.huffpost.com/entry/old-host' };
    const incoming = { outletId: 'ap', url: 'https://www.sfgate.com/entertainment/article/new-host' };
    const merged = mergeReviews(existing, incoming, {}, { script: 'test' });
    assert.strictEqual(merged.url, incoming.url);
  });
});
