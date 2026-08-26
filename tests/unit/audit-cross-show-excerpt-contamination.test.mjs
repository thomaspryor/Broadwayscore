import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeExcerptText,
  baseShowId,
  extractIndexableFields,
  buildExcerptIndex,
  findCrossShowMatches,
  shouldAutoFlag,
  stillExcerptOnly,
  MIN_MATCH_LENGTH,
  HIGH_CONFIDENCE_LENGTH,
} = require('../../scripts/lib/excerpt-contamination-audit.js');

// Mirrors the confirmed BRO-115 case: harry-potter-and-the-cursed-child's
// excerpt-only file carried verbatim Shadowlands content that a sibling
// file under shadowlands' own showId already had flagged wrongProduction.
const LONG_SHADOWLANDS_TEXT = 'Crompton also finds that the script skates along the surface of multiple moral dilemmas, as does Anya Ryan: the production could do more to illuminate Lewis internal struggle after all this is the man who wrote a seven book Christian allegory disguised as childrens stories.';

describe('normalizeExcerptText', () => {
  test('collapses whitespace, smart quotes, and case', () => {
    const a = normalizeExcerptText('  Hello   “World”\n\tit’s  great  ');
    const b = normalizeExcerptText('hello "world" it\'s great');
    assert.strictEqual(a, b);
  });

  test('empty/null input returns empty string', () => {
    assert.strictEqual(normalizeExcerptText(''), '');
    assert.strictEqual(normalizeExcerptText(null), '');
    assert.strictEqual(normalizeExcerptText(undefined), '');
  });
});

describe('baseShowId', () => {
  test('strips trailing year and market suffix', () => {
    assert.strictEqual(baseShowId('shadowlands-west-end-2026'), 'shadowlands');
    assert.strictEqual(baseShowId('hamilton-broadway-2015'), 'hamilton');
    assert.strictEqual(baseShowId('the-play-2024'), 'the-play');
  });

  test('leaves ids with no matching suffix unchanged', () => {
    assert.strictEqual(baseShowId('touch-2026'), 'touch');
    assert.strictEqual(baseShowId('hamilton'), 'hamilton');
  });
});

describe('extractIndexableFields', () => {
  test('pulls excerpt fields, fullText, and wrongFullText', () => {
    const data = {
      theStageExcerpt: 'excerpt text',
      bwwExcerpt: '',
      fullText: 'full text here',
      wrongFullText: 'wrong full text',
    };
    const fields = extractIndexableFields(data);
    const byField = Object.fromEntries(fields.map((f) => [f.field, f.text]));
    assert.strictEqual(byField.theStageExcerpt, 'excerpt text');
    assert.strictEqual(byField.fullText, 'full text here');
    assert.strictEqual(byField.wrongFullText, 'wrong full text');
    assert.ok(!('bwwExcerpt' in byField), 'empty string field should be skipped');
  });

  test('null data returns empty array', () => {
    assert.deepStrictEqual(extractIndexableFields(null), []);
  });
});

describe('stillExcerptOnly', () => {
  test('true when fullText is absent or blank', () => {
    assert.strictEqual(stillExcerptOnly({ theStageExcerpt: 'x' }), true);
    assert.strictEqual(stillExcerptOnly({ fullText: '' }), true);
    assert.strictEqual(stillExcerptOnly({ fullText: '   ' }), true);
    assert.strictEqual(stillExcerptOnly({ fullText: null }), true);
  });

  test('false once real fullText has been collected — a re-collected record is out of BRO-461 scope', () => {
    assert.strictEqual(stillExcerptOnly({ fullText: 'a real review body' }), false);
  });
});

describe('buildExcerptIndex + findCrossShowMatches', () => {
  test('detects the confirmed BRO-115 cross-show shape: excerpt-only file matches a flagged sibling elsewhere', () => {
    const records = [
      {
        showId: 'shadowlands-west-end-2026',
        file: 'london-theatre--anya-ryan.json',
        data: {
          criticName: 'Anya Ryan',
          wrongProduction: true,
          wrongFullText: LONG_SHADOWLANDS_TEXT,
        },
      },
      {
        showId: 'harry-potter-and-the-cursed-child-both-parts-west-end-2021',
        file: 'london-theatre--unknown.json',
        data: {
          theStageExcerpt: LONG_SHADOWLANDS_TEXT,
        },
      },
    ];
    const index = buildExcerptIndex(records);

    const target = records[1];
    const matches = findCrossShowMatches(target.showId, target.file, target.data, index);

    assert.strictEqual(matches.length, 1);
    const [m] = matches;
    assert.strictEqual(m.matchedShowId, 'shadowlands-west-end-2026');
    assert.strictEqual(m.matchedField, 'wrongFullText');
    assert.strictEqual(m.targetField, 'theStageExcerpt');
    assert.strictEqual(m.confidence, 'high');
    assert.strictEqual(m.matchedWrongProduction, true);
    assert.strictEqual(m.sameBase, false);
    assert.ok(m.matchLength >= HIGH_CONFIDENCE_LENGTH);
    assert.strictEqual(shouldAutoFlag(m), true);
  });

  test('does not match text filed under the SAME showId', () => {
    const records = [
      { showId: 'hamilton-2015', file: 'a.json', data: { theStageExcerpt: LONG_SHADOWLANDS_TEXT } },
      { showId: 'hamilton-2015', file: 'b.json', data: { theStageExcerpt: LONG_SHADOWLANDS_TEXT } },
    ];
    const index = buildExcerptIndex(records);
    const target = records[1];
    const matches = findCrossShowMatches(target.showId, target.file, target.data, index);
    assert.strictEqual(matches.length, 0);
  });

  test('short shared boilerplate below MIN_MATCH_LENGTH is not indexed or matched', () => {
    const shortText = 'Five stars, a must-see!'; // well under MIN_MATCH_LENGTH
    assert.ok(shortText.length < MIN_MATCH_LENGTH);
    const records = [
      { showId: 'show-a-2024', file: 'a.json', data: { bwwExcerpt: shortText } },
      { showId: 'show-b-2024', file: 'b.json', data: { bwwExcerpt: shortText } },
    ];
    const index = buildExcerptIndex(records);
    const target = records[1];
    const matches = findCrossShowMatches(target.showId, target.file, target.data, index);
    assert.strictEqual(matches.length, 0);
  });

  test('same-base revival-year collision is flagged sameBase=true and not auto-flag-eligible even when corroborated', () => {
    const records = [
      {
        showId: 'the-play-2017',
        file: 'critic-a.json',
        data: { wrongShow: true, dtliExcerpt: LONG_SHADOWLANDS_TEXT },
      },
      {
        showId: 'the-play-2024',
        file: 'critic-b.json',
        data: { dtliExcerpt: LONG_SHADOWLANDS_TEXT },
      },
    ];
    const index = buildExcerptIndex(records);
    const target = records[1];
    const [m] = findCrossShowMatches(target.showId, target.file, target.data, index);
    assert.strictEqual(m.sameBase, true);
    assert.strictEqual(shouldAutoFlag(m), false);
  });

  test('uncorroborated high-confidence match (neither copy previously flagged) is reported but not auto-flag-eligible', () => {
    const records = [
      { showId: 'show-a-2024', file: 'a.json', data: { bwwExcerpt: LONG_SHADOWLANDS_TEXT } },
      { showId: 'show-b-2024', file: 'b.json', data: { bwwExcerpt: LONG_SHADOWLANDS_TEXT } },
    ];
    const index = buildExcerptIndex(records);
    const target = records[1];
    const [m] = findCrossShowMatches(target.showId, target.file, target.data, index);
    assert.strictEqual(m.confidence, 'high');
    assert.strictEqual(m.matchedWrongProduction, false);
    assert.strictEqual(m.matchedWrongShow, false);
    assert.strictEqual(shouldAutoFlag(m), false);
  });
});
