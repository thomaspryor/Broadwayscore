/**
 * Fixture tests for scripts/lib/title-match.js
 *
 * Run: node scripts/lib/title-match.test.js
 *
 * Covers every case surfaced by the 2026-04-28 ship-check (Claude + Codex
 * dual review of the original Mezzanine fix). Each fixture is a real title
 * from Mezzanine or shows.json — not synthetic — to ensure the lib stays
 * correct against the corpus that motivated it.
 */

const { normalizeTitle, titleTokens, jaccard } = require('./title-match');

const NORMALIZE_FIXTURES = [
  // --- Original bug: U+2026 ellipsis (What Happened Was incident)
  ['What Happened Was…',                 'what happened was'],
  ['What Happened Was',                  'what happened was'],
  // Both U+2026 ellipsis and three-dot variants must produce the same form,
  // so the two productions of this play match each other after normalization.
  ['"Master Harold"…and the boys',       'master harold and the boys'],
  ['"Master Harold"...and the Boys',     'master harold and the boys'],

  // --- & vs "and" (Bonnie & Clyde / Marie & Rosetta)
  ['Bonnie & Clyde',                     'bonnie and clyde'],
  ['Bonnie and Clyde',                   'bonnie and clyde'],
  ['& Juliet',                           'and juliet'],
  ['Marie & Rosetta',                    'marie and rosetta'],
  ['Marie and Rosetta',                  'marie and rosetta'],

  // --- Trailing " the musical" (Urinetown / Burlesque)
  ['Urinetown The Musical',              'urinetown'],
  ['Urinetown',                          'urinetown'],
  ['Burlesque the Musical',              'burlesque'],
  ['Burlesque',                          'burlesque'],

  // --- Type designators preserved when trailing (Redwood Play vs Musical)
  ['Redwood (Musical)',                  'redwood'],
  ['Redwood (Play)',                     'redwood play'],
  ['Redwood',                            'redwood'],

  // --- Mid-string parens stripped (Codex regression case)
  ['Foo (Musical) Bar',                  'foo bar'],
  ['Show & Co. (The Musical)',           'show and co'],

  // --- Bracketed content stripped (Codex case: [2024] Show)
  ['[2024] Show',                        'show'],

  // --- Slash separator (For Colored Girls)
  ['For Colored Girls Who Have Considered Suicide/When the Rainbow Is Enuf',
   'for colored girls who have considered suicide when the rainbow is enuf'],
  ['for colored girls who have considered suicide / when the rainbow is enuf',
   'for colored girls who have considered suicide when the rainbow is enuf'],

  // --- Hyphens are joiners (Grown-Ups stays distinct from Grown Ups)
  ['The Grown-Ups',                      'grownups'],
  ['Grown Ups',                          'grown ups'],

  // --- Venue-suffix titles match bare titles (Cable Street / Monte Cristo)
  ['Cable Street (59e59)',               'cable street'],
  ['Cable Street',                       'cable street'],
  ['Monte Cristo (The York Theatre Company)', 'monte cristo'],
  ['Ulster American (Irish Repertory Theatre)', 'ulster american'],

  // --- Leading "the " stripped
  ['The Karate Kid - The Musical',       'karate kid'],
  ['The Hunger Games on Stage',          'hunger games on stage'],

  // --- Empty / null safety
  ['',                                   ''],
  [null,                                 ''],
  [undefined,                            ''],
];

const TOKEN_FIXTURES = [
  // Type designators MUST stay in token set so audit jaccard distinguishes them
  ['Redwood (Play)',    new Set(['redwood','play'])],
  ['Redwood (Musical)', new Set(['redwood'])],   // (Musical) → strip → bare
  ['Redwood',           new Set(['redwood'])],
];

const JACCARD_FIXTURES = [
  // Type-distinguished titles must NOT score 1.0 (Claude review case)
  [titleTokens('Redwood (Play)'), titleTokens('Redwood (Musical)'), 0.5],
  [titleTokens('Redwood (Play)'), titleTokens('Redwood'),           0.5],
  [titleTokens('Redwood (Musical)'), titleTokens('Redwood'),        1.0],

  // Identical titles
  [titleTokens('Hamilton'), titleTokens('Hamilton'), 1.0],
];

let passed = 0, failed = 0;
const fail = (msg) => { console.error('FAIL:', msg); failed++; };
const pass = () => { passed++; };

for (const [input, expected] of NORMALIZE_FIXTURES) {
  const got = normalizeTitle(input);
  if (got === expected) pass();
  else fail(`normalizeTitle(${JSON.stringify(input)}) = ${JSON.stringify(got)} ; expected ${JSON.stringify(expected)}`);
}

for (const [input, expected] of TOKEN_FIXTURES) {
  const got = titleTokens(input);
  const eq = got.size === expected.size && [...expected].every(t => got.has(t));
  if (eq) pass();
  else fail(`titleTokens(${JSON.stringify(input)}) = ${[...got]} ; expected ${[...expected]}`);
}

for (const [a, b, expected] of JACCARD_FIXTURES) {
  const got = jaccard(a, b);
  if (Math.abs(got - expected) < 0.01) pass();
  else fail(`jaccard(${[...a]}, ${[...b]}) = ${got} ; expected ${expected}`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
