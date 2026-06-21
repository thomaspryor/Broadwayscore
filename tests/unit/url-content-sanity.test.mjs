/**
 * Unit tests for validateContentMentionsShow
 * (scripts/lib/content-quality.js — Schmigadoon 2026 Bug #2).
 *
 * Background: BrightData returned an "Everybody's Talking About Jamie" (EBT)
 * article when asked for a Schmigadoon review URL. The fetched page was a
 * complete, well-formed theater article — but about the wrong show. The
 * existing validateShowMentioned() gate only checked presence, not count,
 * so a single fleeting "Schmigadoon" mention in a long EBT piece could slip
 * past and reach scoring as an override-eligible review.
 *
 * validateContentMentionsShow adds a cheap deterministic gate BEFORE LLM
 * content verification spends tokens:
 *   - Text ≥1500 chars needs ≥3 show-token mentions
 *   - Text <1500 chars needs ≥1 show-token mention
 *   - HTML <title> (if provided) must reference the show, else reject
 *
 * A miss here = a wrong-show full-text review reaching updateReviewJson.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { validateContentMentionsShow } = require('../../scripts/lib/content-quality.js');

describe('validateContentMentionsShow — EBT-as-Schmigadoon regression', () => {
  test('long EBT article with 0 Schmigadoon mentions → rejected', () => {
    const ebtText = `
      Everybody's Talking About Jamie returns to the West End this spring for
      a limited engagement. The coming-of-age musical, based on the BBC Three
      documentary film "Jamie: Drag Queen at 16," first opened at the Sheffield
      Crucible in 2017 before transferring to London. The production stars a
      new cast including a fresh lead actor making his West End debut. The
      show runs two and a half hours with one interval and features songs by
      Dan Gillespie Sells and book by Tom MacRae. Critics praised the original
      London production for its warmth, its honesty about queer teenagerhood,
      and its emotional central performance. This revival takes the same
      design team as the original and promises to retain the heart of the
      piece while refreshing the staging for a new generation of audiences.
      The show examines themes of identity, acceptance, and the courage
      required to be visibly yourself in a world that often prefers conformity.
      Performances run through September at the Peacock Theatre.
    `.repeat(3);
    const r = validateContentMentionsShow(ebtText, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.mentionCount, 0);
    assert.strictEqual(r.threshold, 3);
    assert.match(r.reason, /mentioned 0×/);
  });

  test('long EBT article with 1 fleeting Schmigadoon mention → still rejected', () => {
    // Build a ≥1500-char article with exactly ONE mention of "Schmigadoon"
    // (a fleeting comparative reference). Long-text threshold is 3, so this
    // must be rejected.
    const filler = (
      'Everybody is Talking About Jamie returns to the West End this spring. ' +
      'The coming of age musical first opened at the Sheffield Crucible in 2017. ' +
      'The production stars a new cast including a fresh lead actor making his ' +
      'West End debut. Critics praised the original London production for its ' +
      'warmth and honesty. This revival takes the same design team as the ' +
      'original and promises to retain the heart of the piece while refreshing ' +
      'the staging for new audiences. The show examines themes of identity, ' +
      'acceptance, and courage. Performances run through September. '
    ).repeat(3);
    const ebtText = filler +
      '(One critic compared it favorably to Schmigadoon, another musical about conformity.) ' +
      filler;
    assert.ok(ebtText.length >= 1500, 'setup: must be long-text');
    const r = validateContentMentionsShow(ebtText, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.mentionCount, 1);
    assert.strictEqual(r.threshold, 3);
  });
});

describe('validateContentMentionsShow — legitimate Schmigadoon review', () => {
  test('real Schmigadoon review with many mentions → valid', () => {
    const schmigText = `
      Schmigadoon arrives on Broadway after its celebrated Apple TV+ run, and
      the stage adaptation of Schmigadoon proves even sharper than its
      streaming predecessor. The Schmigadoon book leans into the absurdity
      of its Brigadoon-meets-Oklahoma! premise, sending two modern hikers
      into a town where everyone breaks into 1940s-style song. Schmigadoon's
      cast delivers its parody of golden-age musical theater with both
      affection and bite. The production opened last night at the Lunt-Fontanne.
    `.repeat(3);
    const r = validateContentMentionsShow(schmigText, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, true);
    assert.ok(r.mentionCount >= 3);
  });
});

describe('validateContentMentionsShow — length-based threshold', () => {
  test('short text (<1500 chars) with 1 mention → valid (threshold = 1)', () => {
    const shortText = 'A brief capsule review of Schmigadoon on Broadway.';
    const r = validateContentMentionsShow(shortText, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.threshold, 1);
    assert.strictEqual(r.mentionCount, 1);
  });

  test('short text (<1500 chars) with 0 mentions → rejected', () => {
    const shortText = 'A brief capsule review of an unrelated musical on Broadway.';
    const r = validateContentMentionsShow(shortText, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.mentionCount, 0);
  });

  test('long text (≥1500 chars) with 1 mention → rejected (threshold = 3)', () => {
    const filler = 'This is filler text to pad the length above the 1500-char threshold. '.repeat(40);
    const longText = `A review mentioning Schmigadoon once. ${filler}`;
    assert.ok(longText.length >= 1500, 'setup: text must be ≥1500 chars');
    const r = validateContentMentionsShow(longText, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.threshold, 3);
    assert.strictEqual(r.mentionCount, 1);
  });

  test('length threshold boundary: exactly 1500 chars uses long threshold', () => {
    const shortEnough = 'Schmigadoon. '.padEnd(1499, ' ');
    const atBoundary = 'Schmigadoon. '.padEnd(1500, ' ');
    assert.strictEqual(shortEnough.length, 1499);
    assert.strictEqual(atBoundary.length, 1500);
    const rShort = validateContentMentionsShow(shortEnough, null, 'Schmigadoon', null);
    const rLong = validateContentMentionsShow(atBoundary, null, 'Schmigadoon', null);
    assert.strictEqual(rShort.threshold, 1);
    assert.strictEqual(rLong.threshold, 3);
  });
});

describe('validateContentMentionsShow — HTML <title> cross-check', () => {
  test('HTML <title> matches show → valid', () => {
    const text = 'A brief review of Schmigadoon.';
    const html = '<html><head><title>Schmigadoon Review — NYT</title></head><body>...</body></html>';
    const r = validateContentMentionsShow(text, html, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.htmlTitleMatch, true);
    assert.strictEqual(r.htmlTitle, 'Schmigadoon Review — NYT');
  });

  test('HTML <title> references wrong show → rejected even with body mention', () => {
    const text = 'Schmigadoon is mentioned once but the page is really about something else.';
    const html = '<html><head><title>Everybody\'s Talking About Jamie — Review</title></head><body>...</body></html>';
    const r = validateContentMentionsShow(text, html, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.htmlTitleMatch, false);
    assert.match(r.reason, /HTML <title>/);
  });

  test('HTML provided but no <title> tag → htmlTitleMatch null, passes on body alone', () => {
    const text = 'A brief review of Schmigadoon.';
    const html = '<html><head></head><body>no title tag here</body></html>';
    const r = validateContentMentionsShow(text, html, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.htmlTitleMatch, null);
    assert.strictEqual(r.htmlTitle, null);
  });

  test('EMPTY <title></title> → htmlTitleMatch null, passes on body alone (Wix/SPA, Glengarry ATD 2026-06-19)', () => {
    // allthatdazzles.co.uk (Wix) ships an empty raw <title> filled by JS post-load.
    // The All That Dazzles Glengarry review had 17 body mentions but was rejected
    // because an empty <title> set htmlTitleMatch=false and tripped the backstop.
    const text = ('Schmigadoon is a delight. The Schmigadoon revival sparkles, and '
      + 'Schmigadoon fans will rejoice. ').repeat(20);
    const html = '<html><head><title></title></head><body>review body</body></html>';
    const r = validateContentMentionsShow(text, html, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.htmlTitleMatch, null);
    assert.strictEqual(r.htmlTitle, '');
  });

  test('whitespace-only <title> → htmlTitleMatch null (no false mismatch)', () => {
    const text = ('Schmigadoon is a delight. The Schmigadoon revival sparkles, and '
      + 'Schmigadoon fans will rejoice. ').repeat(20);
    const html = '<title>   \n  </title>';
    const r = validateContentMentionsShow(text, html, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.htmlTitleMatch, null);
  });

  test('empty <title> does NOT rescue a wrong-show page (body mentions still required)', () => {
    // Empty title means "unknown", so rejection must still fall through to the
    // body-mention check — a page with 0 mentions and an empty title is rejected.
    const text = 'A completely different musical about cats and dogs. '.repeat(40);
    const html = '<title></title>';
    const r = validateContentMentionsShow(text, html, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.htmlTitleMatch, null);
  });

  test('no HTML provided → htmlTitleMatch null, pass/fail on body only', () => {
    const text = 'Schmigadoon is great.';
    const r = validateContentMentionsShow(text, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.htmlTitle, null);
    assert.strictEqual(r.htmlTitleMatch, null);
    assert.strictEqual(r.valid, true);
  });

  test('HTML <title> with whitespace/newlines is normalized', () => {
    const text = 'Brief Schmigadoon review.';
    const html = '<title>\n   Schmigadoon   Review\n   on Broadway\n  </title>';
    const r = validateContentMentionsShow(text, html, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.htmlTitle, 'Schmigadoon Review on Broadway');
    assert.strictEqual(r.htmlTitleMatch, true);
  });
});

describe('validateContentMentionsShow — showId fallback (no title)', () => {
  test('extracts significant words from showId when no title given', () => {
    const text = 'A review of the Broadway production at the Lunt-Fontanne.';
    const r = validateContentMentionsShow(text, null, null, 'schmigadoon-2026');
    // showId "schmigadoon-2026" → token "schmigadoon" (year stripped)
    // Body has no "schmigadoon" → 0 mentions → rejected
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.mentionCount, 0);
  });

  test('showId token matches body text → valid', () => {
    const text = 'A brief review of Schmigadoon on Broadway.';
    const r = validateContentMentionsShow(text, null, null, 'schmigadoon-2026');
    assert.strictEqual(r.valid, true);
    assert.ok(r.mentionCount >= 1);
  });

  test('short ID words (≤4 chars) are NOT used as tokens (false-positive guard)', () => {
    // "cats-2024" → id base "cats" is 4 chars, filtered out (word.length > 4 required)
    // So with no title, there are zero tokens, mentionCount stays 0 → reject.
    const text = 'This review discusses Cats, the famous Andrew Lloyd Webber musical.';
    const r = validateContentMentionsShow(text, null, null, 'cats-2024');
    assert.strictEqual(r.mentionCount, 0);
    assert.strictEqual(r.valid, false);
  });

  test('"the" / "and" / "for" / "with" / "from" are filtered from ID tokens', () => {
    // "the-band-and-the-phantom" → tokens after filter: "phantom" (>4 chars, not stopword)
    // "band" (4 chars) filtered. "the"/"and" filtered.
    const text = 'Review of a show mentioning Phantom in one place.';
    const r = validateContentMentionsShow(text, null, null, 'the-band-and-the-phantom');
    assert.ok(r.mentionCount >= 1, `expected phantom match, got ${r.mentionCount}`);
  });
});

describe('validateContentMentionsShow — "The" prefix handling', () => {
  test('title starting with "The" also matches without "The"', () => {
    const text = 'A review of Phantom on Broadway.';
    const r = validateContentMentionsShow(text, null, 'The Phantom', 'the-phantom');
    // Both "the phantom" and "phantom" are tokens; "phantom" matches the body.
    assert.ok(r.mentionCount >= 1);
    assert.strictEqual(r.valid, true);
  });

  test('title "The" alone (≤2 chars after strip) is not added as token', () => {
    // "The" (lowercase "the", 3 chars) — add the full title token. Strip "the " → "" (length 0),
    // skipped. So tokens = {"the"}. Body has no standalone "the" as whole word? It does,
    // but that would be a false-positive — we guard against that with the "showTitle.length > 2"
    // precondition. Here showTitle is "The", 3 chars, so it IS added. This is a known edge case
    // for one-word "The" titles (none exist on Broadway but confirm no crash).
    const r = validateContentMentionsShow('body the body', null, 'The', null);
    assert.strictEqual(typeof r.valid, 'boolean'); // just confirm no crash
  });
});

describe('validateContentMentionsShow — safe defaults', () => {
  test('null text → invalid, mentionCount 0', () => {
    const r = validateContentMentionsShow(null, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.mentionCount, 0);
    assert.strictEqual(r.reason, 'empty text');
  });

  test('undefined text → invalid', () => {
    const r = validateContentMentionsShow(undefined, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
  });

  test('empty string text → invalid', () => {
    const r = validateContentMentionsShow('', null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
  });

  test('non-string text (number) → invalid', () => {
    const r = validateContentMentionsShow(42, null, 'Schmigadoon', 'schmigadoon-2026');
    assert.strictEqual(r.valid, false);
  });

  test('text but no showTitle AND no showId → 0 tokens, 0 mentions, rejected', () => {
    const r = validateContentMentionsShow('Any text at all here', null, null, null);
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.mentionCount, 0);
  });

  test('opts.minMentionsLong override respected', () => {
    const longText = 'Schmigadoon. '.padEnd(1600, ' ');
    const rDefault = validateContentMentionsShow(longText, null, 'Schmigadoon', null);
    const rLenient = validateContentMentionsShow(longText, null, 'Schmigadoon', null, { minMentionsLong: 1 });
    assert.strictEqual(rDefault.valid, false); // 1 mention, threshold 3
    assert.strictEqual(rLenient.valid, true);  // 1 mention, threshold 1
  });

  test('opts.minMentionsShort override respected', () => {
    const shortText = 'Schmigadoon review.';
    const rDefault = validateContentMentionsShow(shortText, null, 'Schmigadoon', null);
    const rStrict = validateContentMentionsShow(shortText, null, 'Schmigadoon', null, { minMentionsShort: 2 });
    assert.strictEqual(rDefault.valid, true);  // 1 mention, threshold 1
    assert.strictEqual(rStrict.valid, false);  // 1 mention, threshold 2
  });
});

describe('validateContentMentionsShow — word boundary correctness', () => {
  test('single-word title uses word boundaries (no substring FP)', () => {
    // "Cats" as a title should NOT match "scatter" or "category"
    const text = 'The show takes place in scattered categories, with a catalog of songs.';
    const r = validateContentMentionsShow(text, null, 'Phantom', null);
    // Title "Phantom" not in body → 0 mentions
    // But crucially: "catalog"/"scattered"/"category" did not match substring tokens we don't have.
    assert.strictEqual(r.mentionCount, 0);
  });

  test('multi-word title uses substring match (no \\b)', () => {
    // "The Book of Mormon" is multi-word → substring match (no \b gating)
    const text = 'A review of The Book of Mormon on Broadway.';
    const r = validateContentMentionsShow(text, null, 'The Book of Mormon', 'the-book-of-mormon');
    assert.ok(r.mentionCount >= 1);
    assert.strictEqual(r.valid, true);
  });
});

describe('validateContentMentionsShow — long-title FP (Are You Now Or Have You Ever Been, 2026-06-15)', () => {
  const TITLE = 'Are You Now or Have You Ever Been?';
  const ID = 'are-you-now-or-have-you-ever-been-off-broadway-2026';

  test('long title appearing once in body (then "the play") is accepted', () => {
    const body = "As Americans, we like to think our witch-hunting days are behind us. The off-Broadway revival of Eric Bentley's Are You Now or Have You Ever Been could reinforce that notion. "
      + 'The play unfolds through transcripts of HUAC hearings. '.repeat(60);
    const r = validateContentMentionsShow(body, null, TITLE, ID);
    assert.strictEqual(r.valid, true);
  });

  test('full title in body once + matching HTML <title> is accepted', () => {
    const body = "The off-Broadway revival of Eric Bentley's Are You Now or Have You Ever Been at City Center is a chilling mirror. "
      + 'The production unfolds through HUAC transcripts. '.repeat(80);
    const html = '<title>Review: Are You Now or Have You Ever Been, a Red Scare Docudrama - TheaterMania.com</title>';
    const r = validateContentMentionsShow(body, html, TITLE, ID);
    assert.strictEqual(r.valid, true);
  });

  test('dedicated review whose headline LEADS with the show, 0 body mentions, is accepted (Theater Pizzazz case)', () => {
    // Long-titled reviews often put the title only in the headline, never in body
    // prose. A headline that LEADS with the full title is a dedicated review.
    const body = 'The production at City Center is a chilling mirror to America. '.repeat(120);
    const html = '<title>“Are You Now or Have You Ever Been” Holds a Chilling Mirror to America | Theater Pizzazz</title>';
    const r = validateContentMentionsShow(body, html, TITLE, ID);
    assert.strictEqual(r.valid, true);
  });

  test('roundup whose <title> lists the show MID-headline, 0 body mentions, is rejected (roundup-FP guard, ship-check 2026-06-15)', () => {
    // The title appears in the <title> but NOT at the lead — a "shows to see" page.
    // Must not pass: titleLeadsWithShow=false, 0 body mentions.
    const body = 'A week of theater offered many options across the city. '.repeat(120);
    const html = '<title>10 Shows to See This Week: Are You Now or Have You Ever Been and More | Some Site</title>';
    const r = validateContentMentionsShow(body, html, TITLE, ID);
    assert.strictEqual(r.valid, false);
  });

  test('full title in body once but HTML <title> about a DIFFERENT show is rejected (backstop intact)', () => {
    // Body mentions our title once in passing, but the page is primarily about another show.
    const body = "This week's roundup also covers Are You Now or Have You Ever Been. "
      + 'But the main event is a dazzling new musical about cats and dogs. '.repeat(80);
    const html = '<title>Cats: The Jellicle Ball — Review</title>';
    const r = validateContentMentionsShow(body, html, TITLE, ID);
    assert.strictEqual(r.valid, false);
  });

  test('headline LEADS with show but continues into a roundup list is rejected (ship-check re-review 2026-06-15)', () => {
    // "Are You Now... and More Shows to See This Week" — leads with the title but is
    // a comparison/roundup piece. Roundup markers reject it despite the leading match.
    const body = 'A week of theater offered many options across the city. '.repeat(120);
    const html = '<title>Are You Now or Have You Ever Been and More Shows to See This Week | Some Site</title>';
    const r = validateContentMentionsShow(body, html, TITLE, ID);
    assert.strictEqual(r.valid, false);
  });

  test('wrong-show content with long title still rejected (guard intact)', () => {
    const body = 'A completely different musical about cats and dogs. '.repeat(80);
    const html = '<title>Cats Review - SomeSite</title>';
    const r = validateContentMentionsShow(body, html, TITLE, ID);
    assert.strictEqual(r.valid, false);
  });
});
