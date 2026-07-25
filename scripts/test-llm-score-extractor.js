#!/usr/bin/env node
/**
 * Test suite for scripts/lib/llm-score-extractor.js
 *
 * Tests:
 *   1. Unit tests for validation functions (no LLM needed)
 *   2. Live LLM tests against real review files (needs GEMINI_API_KEY)
 *
 * Usage:
 *   node scripts/test-llm-score-extractor.js                # Unit tests only
 *   node scripts/test-llm-score-extractor.js --live          # Unit + live LLM tests
 *   node scripts/test-llm-score-extractor.js --live --verbose # With debug output
 */

const path = require('path');
const fs = require('fs');
const {
  extractExplicitScore,
  extractFromJsonLd,
  parseResponse,
  validateAsteriskCount,
  verifyInText,
  postValidate,
  normalizeScore
} = require('./lib/llm-score-extractor');

const VERBOSE = process.argv.includes('--verbose');
const LIVE = process.argv.includes('--live');

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, name, detail) {
  if (condition) {
    passed++;
    if (VERBOSE) console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
  }
}

function skip(name) {
  skipped++;
  if (VERBOSE) console.log(`  ○ ${name} (skipped)`);
}

// ============================================================
// Unit tests — no LLM needed
// ============================================================

function unitTests() {
  console.log('\n=== Unit Tests ===\n');

  // --- parseResponse ---
  console.log('parseResponse:');
  const p1 = parseResponse('{"found": true, "raw": "***½ out of four", "value": 3.5, "scale": 4, "type": "stars"}');
  assert(p1 && p1.value === 3.5 && p1.scale === 4, 'parses valid star response');

  const p2 = parseResponse('{"found": false}');
  assert(p2 === null, 'returns null for found:false');

  const p3 = parseResponse('```json\n{"found": true, "raw": "A-", "value": 92, "scale": 100, "type": "letter"}\n```');
  assert(p3 && p3.type === 'letter', 'handles markdown code blocks');

  const p4 = parseResponse('garbage text');
  assert(p4 === null, 'returns null for garbage');

  const p5 = parseResponse('{"found": true, "raw": "test", "value": -1, "scale": 5, "type": "stars"}');
  assert(p5 === null, 'rejects negative values');

  const p6 = parseResponse('{"found": true, "raw": "test", "value": 6, "scale": 5, "type": "stars"}');
  assert(p6 === null, 'rejects value > scale');

  // --- validateAsteriskCount ---
  console.log('\nvalidateAsteriskCount:');
  const a1 = validateAsteriskCount({ type: 'stars', raw: '***½ out of four', value: 3, scale: 4 });
  assert(a1.value === 3.5, 'corrects ***½ to 3.5', `got ${a1.value}`);

  const a2 = validateAsteriskCount({ type: 'stars', raw: '**** out of four', value: 3, scale: 4 });
  assert(a2.value === 4, 'corrects **** to 4', `got ${a2.value}`);

  const a3 = validateAsteriskCount({ type: 'stars', raw: '** out of four', value: 2, scale: 4 });
  assert(a3.value === 2, 'keeps ** as 2 (no correction needed)');

  const a4 = validateAsteriskCount({ type: 'stars', raw: '** 1/2 out of four', value: 3, scale: 4 });
  assert(a4.value === 2.5, 'corrects ** 1/2 to 2.5', `got ${a4.value}`);

  const a5 = validateAsteriskCount({ type: 'letter', raw: 'A-', value: 92, scale: 100 });
  assert(a5.value === 92, 'leaves letter grades alone');

  // --- verifyInText ---
  console.log('\nverifyInText:');
  const reviewWithStars = 'This show was great. *** out of four stars. Must see.';
  const v1 = verifyInText({ type: 'stars', raw: '*** out of four', value: 3, scale: 4 }, reviewWithStars);
  assert(v1 !== null, 'finds stars in text');

  const v2 = verifyInText({ type: 'stars', raw: '*** out of four', value: 3, scale: 4 }, 'No stars here just a great show');
  assert(v2 === null, 'rejects when no stars in text');

  const reviewWithGrade = 'A wonderful performance in every way. B+';
  const v3 = verifyInText({ type: 'letter', raw: 'B+', value: 87, scale: 100 }, reviewWithGrade);
  assert(v3 !== null, 'finds letter grade at end of text');

  const reviewNoGrade = 'A wonderful performance in every way. She nailed it.';
  const v4 = verifyInText({ type: 'letter', raw: 'A-', value: 92, scale: 100 }, reviewNoGrade);
  assert(v4 === null, 'rejects grade not found in text');

  const reviewWithNumeric = 'A solid production. Rating: 7/10';
  const v5 = verifyInText({ type: 'numeric', raw: '7/10', value: 7, scale: 10 }, reviewWithNumeric);
  assert(v5 !== null, 'finds numeric rating in text');

  // Test with unicode stars
  const reviewUnicode = 'The show is ★★★★ and brilliant.';
  const v6 = verifyInText({ type: 'stars', raw: '★★★★', value: 4, scale: 5 }, reviewUnicode);
  assert(v6 !== null, 'finds unicode stars');

  // Test letter grade with dash variants
  const reviewGradeDash = 'An accessible adaptation, for better or worse. B–';
  const v7 = verifyInText({ type: 'letter', raw: 'B–', value: 83, scale: 100 }, reviewGradeDash);
  assert(v7 !== null, 'finds letter grade with em-dash');

  // --- postValidate ---
  console.log('\npostValidate:');
  const pv1 = postValidate({ type: 'stars', raw: '*** out of four', value: 3, scale: 4 });
  assert(pv1 !== null, 'keeps valid star rating');

  const pv2 = postValidate({ type: 'stars', raw: 'if i gave stars, five-star knockout', value: 5, scale: 5 });
  assert(pv2 === null, 'rejects hypothetical rating');

  const pv3 = postValidate({ type: 'numeric', raw: '2 1/2 hours of runtime', value: 2.5, scale: 5 });
  assert(pv3 === null, 'rejects runtime');

  const pv4 = postValidate({ type: 'stars', raw: 'rotten tomatoes 85%', value: 85, scale: 100 });
  assert(pv4 === null, 'rejects aggregator score');

  const pv5 = postValidate({ type: 'stars', raw: 'five-star dining', value: 5, scale: 5 });
  assert(pv5 === null, 'rejects metaphorical star');

  const pv6 = postValidate({ type: 'stars', raw: 'four-star performance', value: 4, scale: 5 });
  assert(pv6 === null, 'rejects adjectival star use');

  const pv7 = postValidate({ type: 'letter', raw: 'Grade: B+', value: 87, scale: 100 });
  assert(pv7 !== null, 'keeps formal letter grade with context');

  // Bare asterisks without scale should be rejected
  const pv8 = postValidate({ type: 'stars', raw: '***', value: 3, scale: 4 });
  assert(pv8 === null, 'rejects bare asterisks without scale context');

  const pv9 = postValidate({ type: 'stars', raw: '*** out of four', value: 3, scale: 4 });
  assert(pv9 !== null, 'keeps asterisks with "out of four"');

  // --- normalizeScore ---
  console.log('\nnormalizeScore:');
  const n1 = normalizeScore({ type: 'stars', raw: '***½ out of four', value: 3.5, scale: 4 });
  assert(n1 && n1.originalScore === '3.5/4 stars' && n1.normalizedScore === 88, 'normalizes 3.5/4 stars', `got ${JSON.stringify(n1)}`);

  const n2 = normalizeScore({ type: 'letter', raw: 'A-', value: 92, scale: 100 });
  assert(n2 && n2.originalScore === 'A-' && n2.normalizedScore === 85, 'normalizes A- letter grade', `got ${JSON.stringify(n2)}`);

  const n3 = normalizeScore({ type: 'letter', raw: 'B+', value: 87, scale: 100 });
  assert(n3 && n3.originalScore === 'B+' && n3.normalizedScore === 80, 'normalizes B+ letter grade', `got ${JSON.stringify(n3)}`);

  const n4 = normalizeScore({ type: 'numeric', raw: '8/10', value: 8, scale: 10 });
  assert(n4 && n4.originalScore === '8/10' && n4.normalizedScore === 80, 'normalizes 8/10 numeric', `got ${JSON.stringify(n4)}`);

  const n5 = normalizeScore({ type: 'stars', raw: '4/5 stars', value: 4, scale: 5 });
  assert(n5 && n5.originalScore === '4/5 stars' && n5.normalizedScore === 80, 'normalizes 4/5 stars', `got ${JSON.stringify(n5)}`);

  const n6 = normalizeScore({ type: 'letter', raw: 'B-', value: 80, scale: 100 });
  assert(n6 && n6.originalScore === 'B-' && n6.normalizedScore === 72, 'normalizes B- letter grade', `got ${JSON.stringify(n6)}`);

  // --- extractFromJsonLd ---
  console.log('\nextractFromJsonLd:');
  const j1 = extractFromJsonLd('<script type="application/ld+json">{"@type":"Review","reviewRating":{"ratingValue":"4","bestRating":"5"}}</script>');
  assert(j1 && j1.originalScore === '4/5 stars' && j1.normalizedScore === 80, 'extracts from JSON-LD', `got ${JSON.stringify(j1)}`);

  const j2 = extractFromJsonLd('<div>No structured data here</div>');
  assert(j2 === null, 'returns null without JSON-LD');

  const j3 = extractFromJsonLd(null);
  assert(j3 === null, 'handles null HTML');

  const j4 = extractFromJsonLd('<script>"ratingValue": "1", "bestRating": "5"</script>');
  assert(j4 === null, 'rejects suspiciously low 1/5 rating from JSON-LD');

  // --- Outlet gating + reviewRating/aggregateRating disambiguation ---
  // Regression: londontheatre.co.uk relays a Show-Score AUDIENCE aggregate in its
  // JSON-LD. This path ignored outletId entirely, so "4.45/5" became a critic
  // "89/100" in the P0 originalScore slot on 3 shows and failed the weekly P0
  // score-integrity gate for 3 straight weeks.
  const aggLd = '{"@type":"Event","aggregateRating":{"ratingValue":"4.45","bestRating":"5","ratingCount":"312"}}';
  const revLd = '{"@type":"Review","reviewRating":{"ratingValue":"4","bestRating":"5"}}';

  assert(extractFromJsonLd(aggLd, 5, 'london-theatre') === null,
    'refuses JSON-LD for an outlet that publishes no critic rating');
  assert(extractFromJsonLd(revLd, 5, 'london-theatre') === null,
    'no-critic-rating gate applies even to reviewRating-shaped data');

  // The gate must stay narrow: londontheatre1 / front-row-center carry the same
  // noScoreExtractor marker but DO publish per-critic stars (66 corpus files), and
  // WordPress review plugins emit that single critic rating AS an aggregateRating.
  const wp1 = extractFromJsonLd(aggLd, 5, 'londontheatre1');
  assert(wp1 && wp1.normalizedScore === 89,
    'keeps WordPress-plugin aggregateRating for outlets that do publish ratings', `got ${JSON.stringify(wp1)}`);
  const wp2 = extractFromJsonLd(aggLd, 5, 'front-row-center');
  assert(wp2 && wp2.normalizedScore === 89, 'same for front-row-center', `got ${JSON.stringify(wp2)}`);

  const both = extractFromJsonLd(aggLd + revLd, 5, 'timeout');
  assert(both && both.normalizedScore === 80,
    'prefers reviewRating over aggregateRating when both present', `got ${JSON.stringify(both)}`);
  const bothRev = extractFromJsonLd(revLd + aggLd, 5, 'timeout');
  assert(bothRev && bothRev.normalizedScore === 80,
    'prefers reviewRating regardless of document order', `got ${JSON.stringify(bothRev)}`);

  // bestRating is read from the matched block, not the whole document — a sibling
  // 0-100 block must not rescale a /5 reviewRating (would have read 4/100 = 4).
  const scoped = extractFromJsonLd(
    '{"aggregateRating":{"ratingValue":"90","bestRating":"100"}}' + ' '.repeat(600) + '{"reviewRating":{"ratingValue":"4"}}',
    5, 'timeout');
  assert(scoped && scoped.normalizedScore === 80,
    'does not borrow bestRating from a distant rating block', `got ${JSON.stringify(scoped)}`);

  const noOutlet = extractFromJsonLd(revLd, 5);
  assert(noOutlet && noOutlet.normalizedScore === 80, 'still works with outletId omitted');
}

// ============================================================
// Live LLM tests — needs GEMINI_API_KEY
// ============================================================

async function liveLlmTests() {
  console.log('\n=== Live LLM Tests (Gemini Flash) ===\n');

  if (!process.env.GEMINI_API_KEY) {
    console.log('GEMINI_API_KEY not set — skipping live tests');
    return;
  }

  const reviewTextsDir = path.join(__dirname, '..', 'data', 'review-texts');

  // Helper to load a review file
  function loadReview(relPath) {
    const fullPath = path.join(reviewTextsDir, relPath);
    if (!fs.existsSync(fullPath)) { skip(`File not found: ${relPath}`); return null; }
    return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  }

  // --- Category 1: Reviews with known letter grades (EW) ---
  console.log('Category 1: EW letter grades');
  const letterGradeTests = [
    { file: 'uncle-vanya-2024/ew--shania-russell.json', expected: { type: 'letter', grade: /B[\-–]/, norm: [70, 78] } },
    { file: 'travesties-2018/ew--leah-greenblatt.json', expected: { type: 'letter', grade: /A[\-–]/, norm: [88, 92] } },
    { file: 'an-enemy-of-the-people-2024/ew--dalton-ross.json', expected: { type: 'letter', grade: /A[\-–]/, norm: [88, 92] } },
    { file: 'doubt-2024/ew--dalton-ross.json', expected: { type: 'letter', grade: /A[\-–]/, norm: [88, 92] } },
    { file: 'the-bands-visit-2017/ew--dana-schwartz.json', expected: { type: 'letter', grade: /A[\-–]/, norm: [88, 92] } },
    { file: 'the-ferryman-2018/ew--marc-snetiker.json', expected: { type: 'letter' } },
    { file: 'the-glass-menagerie-2017/ew--maya-stanton.json', expected: { type: 'letter' } },
    { file: 'the-great-gatsby-2024/ew--emlyn-travis.json', expected: { type: 'letter' } },
    { file: 'prima-facie-2023/ew--lester-fabian-brathwaite.json', expected: { type: 'letter' } },
    { file: 'mother-play-2024/ew--christian-holub.json', expected: { type: 'letter' } },
  ];

  for (const test of letterGradeTests) {
    const review = loadReview(test.file);
    if (!review || !review.fullText) { skip(test.file + ' (no fullText)'); continue; }

    try {
      const result = await extractExplicitScore({ text: review.fullText, outletId: review.outletId || 'ew', verbose: VERBOSE });
      if (!result) {
        assert(false, test.file, 'expected letter grade, got null');
        continue;
      }
      const nameShort = test.file.split('/').pop();
      assert(result.originalScore && typeof result.originalScore === 'string', `${nameShort}: got string originalScore "${result.originalScore}"`);
      if (test.expected.grade) {
        assert(test.expected.grade.test(result.originalScore), `${nameShort}: grade matches ${test.expected.grade}`, `got "${result.originalScore}"`);
      }
      if (test.expected.norm) {
        assert(result.normalizedScore >= test.expected.norm[0] && result.normalizedScore <= test.expected.norm[1],
          `${nameShort}: norm in [${test.expected.norm}]`, `got ${result.normalizedScore}`);
      }
      if (VERBOSE) console.log(`    result: ${JSON.stringify(result)}`);
    } catch (e) {
      assert(false, test.file, e.message);
    }
    // Rate limit: 0.5s between calls
    await new Promise(r => setTimeout(r, 500));
  }

  // --- Category 2: Reviews with known star ratings (USA Today, TimeOut) ---
  console.log('\nCategory 2: Star ratings');
  const starTests = [
    { file: 'wicked-2003/usatoday--elysa-gardner.json', expected: { type: 'stars' } },
    { file: 'cabaret-2014/usatoday--elysa-gardner.json', expected: { type: 'stars' } },
    { file: 'pippin-2013/usatoday--elysa-gardner.json', expected: { type: 'stars' } },
    { file: 'fiddler-on-the-roof-2015/usatoday--elysa-gardner.json', expected: { type: 'stars' } },
    { file: 'driving-miss-daisy-2010/usatoday--elysa-gardner.json', expected: { type: 'stars' } },
  ];

  for (const test of starTests) {
    const review = loadReview(test.file);
    if (!review || !review.fullText) { skip(test.file + ' (no fullText)'); continue; }

    try {
      const result = await extractExplicitScore({ text: review.fullText, outletId: review.outletId || 'usatoday', verbose: VERBOSE });
      const nameShort = test.file.split('/').pop();
      if (!result) {
        // Check if there's a known originalRating we can compare to
        if (review.originalRating) {
          assert(false, `${nameShort}: expected star rating "${review.originalRating}", got null`);
        } else {
          skip(`${nameShort}: no result, no known rating`);
        }
        continue;
      }
      assert(result.originalScore && typeof result.originalScore === 'string', `${nameShort}: got "${result.originalScore}" (norm: ${result.normalizedScore})`);
      if (VERBOSE) console.log(`    result: ${JSON.stringify(result)}`);
    } catch (e) {
      assert(false, test.file, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // --- Category 3: Reviews with NO explicit score (NYT, Variety, Vulture) ---
  console.log('\nCategory 3: No explicit score (should return null)');
  const noScoreTests = [
    'gypsy-2008/nytimes--ben-brantley.json',
    'gypsy-2008/variety--aramide-tinubu.json',
    'gypsy-2008/variety--david-rooney.json',
    'gypsy-2008/nytimes--jesse-green.json',
    'gypsy-2008/vulture--sara-holdren.json',
    'ragtime-2009/nytimes--ben-brantley.json',
    'ragtime-2009/variety--david-rooney.json',
    'ragtime-2009/nytimes--laura-collins-hughes.json',
    'an-enemy-of-the-people-1971/variety--daniel-daddario.json',
    'an-enemy-of-the-people-1971/nytimes--jesse-green.json',
  ];

  for (const file of noScoreTests) {
    const review = loadReview(file);
    if (!review || !review.fullText) { skip(file + ' (no fullText)'); continue; }

    try {
      const result = await extractExplicitScore({ text: review.fullText, outletId: review.outletId || file.split('/')[1].split('--')[0], verbose: VERBOSE });
      const nameShort = file.split('/').pop();
      assert(result === null, `${nameShort}: returns null (no score)`, result ? `got "${result.originalScore}"` : '');
    } catch (e) {
      assert(false, file, e.message);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  // --- Category 4: False positive traps ---
  console.log('\nCategory 4: False positive rejection');

  // Test with text containing runtime patterns
  const runtimeText = `The show runs for 2 1/2 hours. It's a magnificent production that deserves all the praise it gets. Running time: Two hours and thirty minutes, including one intermission. At the Shubert Theatre. Through March 2026.`;
  try {
    const r1 = await extractExplicitScore({ text: runtimeText, outletId: 'nytimes', verbose: VERBOSE });
    assert(r1 === null, 'rejects runtime-only text');
  } catch (e) { assert(false, 'runtime test', e.message); }
  await new Promise(r => setTimeout(r, 500));

  // Test with metaphorical star usage
  const metaphorText = `This was a five-star performance from everyone involved. The ensemble delivered a four-star meal of theater. It's a three-star evening that could have been better with tighter direction. The supporting cast all gave star turns. Truly a star-studded affair with real magic on stage.`;
  try {
    const r2 = await extractExplicitScore({ text: metaphorText, outletId: 'nytimes', verbose: VERBOSE });
    assert(r2 === null, 'rejects metaphorical star text', r2 ? `got "${r2.originalScore}"` : '');
  } catch (e) { assert(false, 'metaphor test', e.message); }
  await new Promise(r => setTimeout(r, 500));

  // Test with hypothetical rating
  const hypotheticalText = `If I gave star ratings, this production would get all five stars. I would give it an A+ if I used letter grades. The show deserves a perfect score. But we don't do ratings at this publication. We just tell you whether to go. And you should absolutely go.`;
  try {
    const r3 = await extractExplicitScore({ text: hypotheticalText, outletId: 'vulture', verbose: VERBOSE });
    assert(r3 === null, 'rejects hypothetical rating', r3 ? `got "${r3.originalScore}"` : '');
  } catch (e) { assert(false, 'hypothetical test', e.message); }
}

// ============================================================
// Run
// ============================================================
async function main() {
  console.log('Testing llm-score-extractor.js');
  console.log(`Mode: ${LIVE ? 'unit + live LLM' : 'unit only'}`);

  unitTests();

  if (LIVE) {
    await liveLlmTests();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed, ${skipped} skipped ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
