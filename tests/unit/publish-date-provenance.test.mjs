/**
 * BRO-5081: two write paths put a date that is not the review's own publish
 * date into publishDate. Built from the two real cases the audit found.
 *
 *  1. LLM scoring guess. Wolf Hall Parts One & Two (Broadway 2015), The
 *     Hollywood Reporter (David Rooney): stored 2015-03-20 with dateSource
 *     'llm-scoring' (2015-03-20 is the first preview in shows.json); the
 *     review page is dated 2015-04-09 (opening night).
 *  2. Roundup article date. When We Have Sufficiently Tortured Each Other
 *     (West End 2019), BritishTheatre.com: stored 2019-02-07, the date of the
 *     BroadwayWorld review roundup; the review page is dated 2019-01-24.
 *
 * Uses the real functions (CLAUDE.md §15).
 * Run: node --test tests/unit/publish-date-provenance.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(import.meta.dirname, '..', '..');
const {
  llmScoringDateFields,
  roundupEntryDateFields,
  isProvisionalPublishDate,
} = require('../../scripts/lib/publish-date-provenance.js');
const { extractBWWRoundupReviews } = require('../../scripts/gather-reviews.js');

// Real row values (the live review and show records, 2026-10-12).
const WOLF_HALL_THR = {
  showId: 'wolf-hall-parts-one-and-two-2015',
  outletId: 'hollywood-reporter',
  criticName: 'David Rooney',
  url: 'https://www.hollywoodreporter.com/review/wolf-hall-parts-one-two-787581',
};
const WOLF_HALL_GUESS = '2015-03-20';
const WOLF_HALL_REAL = '2015-04-09';

describe('LLM scoring date never becomes publishDate (Wolf Hall THR)', () => {
  const WOLF_HALL_SHOW = { id: WOLF_HALL_THR.showId, status: 'closed', openingDate: '2015-04-09' };
  const SCORED_AT = Date.parse('2026-02-15'); // the legacy web-search backfill

  test('historical show: a dateless review keeps publishDate empty; the guess is kept apart', () => {
    const fields = llmScoringDateFields(
      { ...WOLF_HALL_THR, publishDate: null },
      { claude: { publishDate: WOLF_HALL_GUESS }, openai: { publishDate: null } },
      WOLF_HALL_SHOW, SCORED_AT,
    );
    assert.deepEqual(fields, { llmPublishDateGuess: WOLF_HALL_GUESS });
    assert.equal('publishDate' in fields, false);
    assert.equal('dateSource' in fields, false);
  });

  test('near opening the guess still fills publishDate, provisionally (dateless-revival guard exposure)', () => {
    const opening = { id: 'x-2026', status: 'previews', openingDate: '2026-10-11' };
    const f = llmScoringDateFields({ publishDate: null }, { claude: { publishDate: '2026-10-11' } }, opening, Date.parse('2026-10-12'));
    assert.deepEqual(f, { llmPublishDateGuess: '2026-10-11', publishDate: '2026-10-11', dateSource: 'llm-scoring' });
    assert.equal(isProvisionalPublishDate(f), true, 'a later page fetch replaces it');
    const justOpened = { id: 'y', status: 'open', openingDate: '2026-09-01' };
    assert.equal(llmScoringDateFields({}, { claude: { publishDate: '2026-09-01' } }, justOpened, Date.parse('2026-10-12')).publishDate, '2026-09-01');
    assert.equal(llmScoringDateFields({}, { claude: { publishDate: '2026-09-01' } }, null).publishDate, '2026-09-01', 'unknown show keeps the old fill');
  });

  test('model order is Claude > OpenAI > Gemini > Kimi; bad values are skipped', () => {
    assert.deepEqual(
      llmScoringDateFields({}, { claude: { publishDate: 'March 2015' }, gemini: { publishDate: WOLF_HALL_GUESS } }, WOLF_HALL_SHOW, SCORED_AT),
      { llmPublishDateGuess: WOLF_HALL_GUESS },
    );
    assert.deepEqual(llmScoringDateFields({}, { claude: { error: 'x' } }), {});
    assert.deepEqual(llmScoringDateFields({}, undefined), {});
  });

  test('a review that already has a date gets nothing from the model', () => {
    assert.deepEqual(
      llmScoringDateFields({ ...WOLF_HALL_THR, publishDate: WOLF_HALL_REAL }, { claude: { publishDate: WOLF_HALL_GUESS } }),
      {},
    );
  });

  test('an old llm-scoring date is provisional, so the page date replaces it', () => {
    assert.equal(isProvisionalPublishDate({ ...WOLF_HALL_THR, publishDate: WOLF_HALL_GUESS, dateSource: 'llm-scoring' }), true);
    assert.equal(isProvisionalPublishDate({ ...WOLF_HALL_THR, publishDate: WOLF_HALL_REAL, dateSource: 'html-page' }), false);
    assert.equal(isProvisionalPublishDate({ ...WOLF_HALL_THR, publishDate: WOLF_HALL_REAL }), false);
    assert.equal(isProvisionalPublishDate({ ...WOLF_HALL_THR, publishDate: null, dateSource: 'llm-scoring' }), false);
  });

  test('wiring: ensemble-scorer.ts decides through the helper with the show record', () => {
    const src = readFileSync(join(ROOT, 'scripts/llm-scoring/ensemble-scorer.ts'), 'utf8');
    assert.match(src, /llmScoringDateFields\(scoredFile, ensembleResult\.modelResults, showRecordFor\(reviewFile\.showId\)\)/);
    assert.doesNotMatch(src, /dateSource\s*=\s*['"]llm-scoring['"]/);
    assert.doesNotMatch(src, /scoredFile\.publishDate\s*=/);
  });

  test('wiring: collect-review-texts.js lets the page replace a provisional date', () => {
    const src = readFileSync(join(ROOT, 'scripts/collect-review-texts.js'), 'utf8');
    assert.match(src, /isProvisionalPublishDate\(data\)/);
  });
});

// Real case 2. The roundup is BroadwayWorld's (articleBody format, JSON-LD
// datePublished = the roundup's own date). The critic name is a fixture
// stand-in; the dates and outlet are the audit's.
const TORTURED_SHOW_ID = 'when-we-have-sufficiently-tortured-each-other-west-end-2019';
const ROUNDUP_DATE = '2019-02-07';
const REAL_REVIEW_DATE = '2019-01-24';
const ROUNDUP_URL = 'https://www.broadwayworld.com/westend/article/Review-Roundup-WHEN-WE-HAVE-SUFFICIENTLY-TORTURED-EACH-OTHER-20190207';
const ROUNDUP_HTML = `<html><body>
<script type="application/ld+json">
{
  "@type": "NewsArticle",
  "headline": "Review Roundup: When We Have Sufficiently Tortured Each Other",
  "datePublished": "${ROUNDUP_DATE}T10:00:00Z",
  "articleBody": "Let's see what the critics had to say... Fixture Critic, BritishTheatre.com: A provocative evening that refuses to let its audience settle into comfort."
}
</script>
<p>Body text</p>
</body></html>`;

describe('roundup article date is a provisional publishDate (Tortured, BritishTheatre.com)', () => {
  test('roundupEntryDateFields marks the roundup date provisional', () => {
    assert.deepEqual(roundupEntryDateFields(ROUNDUP_DATE), { publishDate: ROUNDUP_DATE, dateSource: 'roundup-article' });
    assert.deepEqual(roundupEntryDateFields(null), { publishDate: null });
    assert.equal(isProvisionalPublishDate(roundupEntryDateFields(ROUNDUP_DATE)), true, 'the page date replaces it at the next fetch');
  });

  test('BWW roundup articleBody extraction stamps dateSource roundup-article', () => {
    const reviews = extractBWWRoundupReviews(ROUNDUP_HTML, TORTURED_SHOW_ID, ROUNDUP_URL, 'When We Have Sufficiently Tortured Each Other');
    // Matched on the outlet name, not outletId: the id BritishTheatre.com
    // normalizes to depends on the outlet registry data present.
    const bt = reviews.find(r => /britishtheatre/i.test(`${r.outletId} ${r.outlet}`));
    assert.ok(bt, `BritishTheatre.com entry extracted (got ${reviews.map(r => r.outletId).join(', ')})`);
    assert.equal(String(bt.publishDate).slice(0, 10), ROUNDUP_DATE);
    assert.equal(bt.dateSource, 'roundup-article');
    assert.equal(isProvisionalPublishDate(bt), true);
    assert.equal(isProvisionalPublishDate({ ...bt, publishDate: REAL_REVIEW_DATE, dateSource: 'html-page' }), false);
  });

  test('wiring: every roundup extractor uses roundupEntryDateFields; merge writers never pass the marker', () => {
    for (const f of ['scripts/gather-reviews.js', 'scripts/extract-bww-reviews.js', 'scripts/re-extract-aggregator-reviews.js', 'scripts/scrape-westendtheatre-roundups.js']) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      assert.match(src, /roundupEntryDateFields\(/, f);
    }
    for (const f of ['scripts/re-extract-aggregator-reviews.js', 'scripts/scrape-westendtheatre-roundups.js']) {
      // createOrMergeReviewFile fills fields one by one: a dateSource passed
      // here would label an existing file's real publishDate provisional.
      assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), /\{ dateSource: review\.dateSource \}/, f);
    }
  });
});

// BRO-5397: the model's guess for a dateless "Thursday, 4th June" review came back as 2024-06-04 for a show that
// opened 2026-05-28 (Beetlejuice WE, Islington Tribune), and was stored as publishDate. 13 live reviews carried
// years 2-11 before their show.
describe('an implausible LLM date guess never becomes publishDate (BRO-5397)', () => {
  const { isPlausibleGuess } = require('../../scripts/lib/publish-date-provenance.js');
  const BEETLEJUICE = { id: 'beetlejuice-west-end-2026', status: 'open', previewsStartDate: '2026-05-08', openingDate: '2026-05-28' };
  const NOW = Date.parse('2026-06-07');

  test('Beetlejuice 2026: a 2024 guess stays a guess; the real 2026 date fills', () => {
    const bad = llmScoringDateFields({}, { claude: { publishDate: '2024-06-04' } }, BEETLEJUICE, NOW);
    assert.deepEqual(bad, { llmPublishDateGuess: '2024-06-04' });
    const good = llmScoringDateFields({}, { claude: { publishDate: '2026-06-04' } }, BEETLEJUICE, NOW);
    assert.equal(good.publishDate, '2026-06-04');
    assert.equal(good.dateSource, 'llm-scoring');
  });

  test('edge: 60 days before the first preview is allowed, 61 is not; a future date is never', () => {
    assert.equal(isPlausibleGuess('2026-03-09', BEETLEJUICE, NOW), true);
    assert.equal(isPlausibleGuess('2026-03-08', BEETLEJUICE, NOW), false);
    assert.equal(isPlausibleGuess('2026-06-20', BEETLEJUICE, NOW), false);
  });

  test('boundary: a declared prior run keeps its own dates; unknown show and show with no dates keep the old behaviour', () => {
    const transfer = { ...BEETLEJUICE, priorRuns: [{ id: 'x', openingDate: '2024-05-01', closingDate: '2024-08-31' }] };
    assert.equal(isPlausibleGuess('2024-06-04', transfer, NOW), true);
    assert.equal(isPlausibleGuess('2024-06-04', null, NOW), true);
    assert.equal(isPlausibleGuess('2024-06-04', { id: 'y' }, NOW), true);
  });
});

describe('an opted-out prior run does not make an old guess plausible (BRO-5397)', () => {
  const { isPlausibleGuess } = require('../../scripts/lib/publish-date-provenance.js');
  const show = { id: 'z', status: 'open', openingDate: '2026-05-28', priorRuns: [{ id: 'old', openingDate: '2024-05-01', closingDate: '2024-08-31', inheritReviews: false }] };
  test('inheritReviews:false run: the 2024 guess is still implausible; an inheriting run keeps it', () => {
    assert.equal(isPlausibleGuess('2024-06-04', show, Date.parse('2026-06-07')), false);
    const inherit = { ...show, priorRuns: [{ ...show.priorRuns[0], inheritReviews: undefined }] };
    assert.equal(isPlausibleGuess('2024-06-04', inherit, Date.parse('2026-06-07')), true);
  });
});
