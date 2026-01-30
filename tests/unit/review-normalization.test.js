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

const { test, describe } = require('node:test');
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

  test('returns true for typos within Levenshtein distance', () => {
    // Names > 5 chars with distance <= 2 should match
    assert.strictEqual(areCriticsSimilar('Johnny Oleksinski', 'Johnny Oleksinki'), true);
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
    // From normalization-diff.json: "stage" and "the stage" should both work
    assert.strictEqual(normalizeOutlet('the stage'), 'thestage');
    assert.strictEqual(normalizeOutlet('The Stage'), 'thestage');
    assert.strictEqual(normalizeOutlet('stage'), 'thestage');
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

  test('detects canonical IDs missing from their own aliases (known issues)', () => {
    // This test documents known data issues in the aliases.
    // These IDs have hyphenated canonical IDs but their aliases list
    // doesn't include the hyphenated form. This doesn't affect functionality
    // since lookups go from variations -> canonical, not canonical -> variations.
    const missingFromOwnAliases = [];
    for (const [canonical, aliases] of Object.entries(OUTLET_ALIASES)) {
      if (!aliases.includes(canonical)) {
        missingFromOwnAliases.push(canonical);
      }
    }
    // Document the known issues (don't fail, just assert they're the expected ones)
    // Known issue: hollywood-reporter uses "hollywood reporter" in aliases but not "hollywood-reporter"
    const knownMissing = ['hollywood-reporter'];
    for (const known of knownMissing) {
      assert.ok(
        missingFromOwnAliases.includes(known),
        `Expected "${known}" to be missing from its own aliases`
      );
    }
  });

  test('detects duplicate aliases across outlets (known issues)', () => {
    // This test documents known duplicate aliases.
    // "new york magazine" maps to both "vulture" and "newyorkmagazine".
    // In practice, this means "new york magazine" will match "vulture" since
    // vulture comes first in the OUTLET_ALIASES object iteration.
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
    // Document the known duplicate
    // Known issue: "new york magazine" and "ny mag" are in both vulture and newyorkmagazine
    const knownDuplicates = ['new york magazine', 'ny mag'];
    for (const known of knownDuplicates) {
      assert.ok(
        duplicates.has(known),
        `Expected "${known}" to be a duplicate alias`
      );
    }
    // Verify vulture wins for these aliases (comes first in iteration)
    assert.strictEqual(normalizeOutlet('new york magazine'), 'vulture');
    assert.strictEqual(normalizeOutlet('ny mag'), 'vulture');
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
    assert.strictEqual(getOutletTier('ew'), 1);
    assert.strictEqual(getOutletTier('ap'), 1);
  });

  test('returns correct tier for tier 2 outlets', () => {
    assert.strictEqual(getOutletTier('nypost'), 2);
    assert.strictEqual(getOutletTier('theatermania'), 2);
    assert.strictEqual(getOutletTier('broadwayworld'), 2);
    assert.strictEqual(getOutletTier('deadline'), 2);
    assert.strictEqual(getOutletTier('timeout'), 2);
    assert.strictEqual(getOutletTier('guardian'), 2);
  });

  test('returns correct tier for tier 3 outlets', () => {
    assert.strictEqual(getOutletTier('nytg'), 3);
    assert.strictEqual(getOutletTier('nyt-theater'), 3);
    assert.strictEqual(getOutletTier('theatrely'), 3);
    assert.strictEqual(getOutletTier('cititour'), 3);
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
    // Tier 2
    assert.strictEqual(getOutletTier('Broadway World'), 2);
    assert.strictEqual(getOutletTier('bww'), 2);
  });
});
