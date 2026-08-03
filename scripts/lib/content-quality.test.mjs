import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateShowMentioned, verifyFullTextContent, validateContentMentionsShow } = require('./content-quality.js');

// ============================================================================
// validateShowMentioned Check 3 (task #915, follow-up to #895's 28/39
// false-positive NYT recoveries) — a long theater-adjacent article used to
// rubber-stamp as a "review" on generic-keyword count alone, with zero
// evidence the SPECIFIC show was ever mentioned. Check 3 now also requires
// at least one show-ID word to appear.
// ============================================================================

// Real text from the reverted task #895 recovery (data/review-texts commit
// 1b7cf875c71): les-miserables-arena-concert-spectacular-off-broadway-2026/
// nytimes--richard-sandomir.json. This is an NYT obituary for a circus
// performer — long, theater-adjacent (hits "theater", "west end", "act",
// "audience", "costume" — 5 THEATER_KEYWORDS), but never once mentions
// "Les Miserables" or any word from the show's title/ID.
const LILLY_YOKOI_OBITUARY = `Lilly Yokoi, an audacious cyclist who mastered half-balletic, half-gymnastic tricks as part of a family act and later broke away to perform solo on her gold-plated bicycle — in high heels — in circuses and theaters, on television and during halftimes of Harlem Globetrotters games, died on May 11 in Tokyo. She was 96.

Her death, in a hospital, was confirmed by her daughter, Monica Yokoi. It was not widely reported at the time.

"Lilly Yokoi began where all the other trick cyclists left off," Cyril Bertram Mills, who hired Ms. Yokoi for his family's circus on London's West End in 1962, once wrote. "She was an artiste down to her fingertips, her costumes were magnificent, and she had a smile which was so infectious that her audience was with her in the first minute."

Ms. Yokoi's tricks demanded remarkable balance and dexterity. She performed handstands on the handlebars of a moving bicycle and, like a gymnast on a pommel horse, swung herself repeatedly over the length of the bike.

She executed wheelies and spun herself around. She turned her two-wheeler into a unicycle by removing the handlebars and front wheel. Other times, she stood up, placing one foot on the seat, the other on the handlebars, her arms in the air. She rode backward, her rear resting on the handlebars, a leg stretched across the seat. When she finished, she leaped off the bike in a dismount.

Abe Saperstein, the impresario who owned the Globetrotters, an exhibition basketball team that became famous for its quirky, comedic play, was so impressed that in 1957 he called Ms. Yokoi "the greatest performer we've ever had with us."

In the early 1960s, Ms. Yokoi made a decision that would forever define her image: She commissioned a new bicycle from the Swiss artistic cyclist Arnold Tschopp. It wasn't performance alone that she wanted — she also had it gold-plated. The bicycle is on display at Circusland, a museum in Besalu, Spain.

She was, from then on, widely known as the Ballerina on the Golden Bicycle.

But it wasn't all glamour. Monica Yokoi said in an interview that her mother's acrobatics brought on pain from, among other things, misaligned bones and pinched nerves.

"This was not what she wanted in life," she said. "She felt more or less obligated to support her family and didn't want me to suffer through the same life. She wasn't happy."

Now a physiotherapist, Monica Yokoi tries to help people perform at their best and stay injury-free as long as possible.

Ms. Yokoi was born on Nov. 15, 1929, in New York City, but moved with her family to Japan when she was a child. Her father, Eizo and her mother, Rui, were also bicycle acrobats, and Mr. Yokoi was the primary teacher of the skills to their children.

Ms. Yokoi's daughter said that performing as a group "was a way for the family to eat during the war in Japan. My mother was the main attraction whom her father trusted to find gigs, so she was sent to different places to ask if they were interested in a performance."

The Yokoi Family Troupe — which, over the years, included five sisters and one brother — often performed in the United States with the traveling Hamid-Morton Circus.

On her own for nearly 30 years, Ms. Yokoi performed at major venues like Radio City Music Hall, the London Palladium and the Lido in Paris. She was a major attraction at circuses in America and Europe; appeared on television programs like "The Ed Sullivan Show" and "The Hollywood Palace"; performed at Las Vegas hotels and in the 1966 circus film "Rings Around the World"; and returned to work with the Globetrotters in the late 1970s.

She retired in 1982 and lived the rest of her life in Tokyo.

In 1955, she married a fellow acrobat, Roland Johansson, a Swede known as the Great Rolando for his one-finger handstands. He also became Ms. Yokoi's manager and performed on bills with her. The marriage ended in divorce.

In addition to her daughter, Ms. Yokoi is survived by two grandchildren and two great-grandchildren.`;

test('validateShowMentioned: long theater-adjacent article that never mentions the show is REJECTED (les-miserables-arena obituary, task #895)', () => {
  assert.ok(LILLY_YOKOI_OBITUARY.length > 3000, 'fixture must exceed the Check-3 length gate to actually exercise it');
  const result = validateShowMentioned(
    LILLY_YOKOI_OBITUARY,
    'les miserables arena concert spectacular',
    'les-miserables-arena-concert-spectacular-off-broadway-2026'
  );
  assert.equal(result.valid, false, `expected rejection, got: ${result.reason}`);
});

test('validateShowMentioned: unrelated long article with no showId is REJECTED (no ID words to fall back on)', () => {
  assert.ok(LILLY_YOKOI_OBITUARY.length > 3000);
  const result = validateShowMentioned(LILLY_YOKOI_OBITUARY, null, null);
  assert.equal(result.valid, false);
});

// A synthetic-but-representative pronoun-heavy review: mentions the show by
// a single ID word once ("Turner") and otherwise refers to it only as "the
// production"/"this revival" — the exact pattern Check 3 exists to admit.
// Deliberately engineered so idWords match count is 1 (below Check 2's >=2
// threshold) while still clearing 5+ THEATER_KEYWORDS, so this exercises
// Check 3's relaxed-but-not-blind path specifically.
function buildPronounHeavyReview() {
  const paragraph = 'The production which opened this week at the small off-Broadway theater is a triumph of staging and performance. The director asked the cast to underplay every scene, and the choreographer kept the ensemble in near-constant motion around a spare set. Understudy work aside, this revival never loses its grip on the audience, who sat rapt through a long first act and returned for an equally gripping second. The costume design leans into faded work clothes, evoking the boardinghouse setting without a hint of nostalgia. ';
  // "comes" contains the id word "come" as a substring — the single,
  // deliberate show-word hit this fixture exists to exercise.
  let body = 'Whatever else comes of this busy season, this staging will be remembered. ';
  while (body.length < 3200) body += paragraph;
  return body;
}

test('validateShowMentioned: pronoun-heavy long review WITH a partial show-word match still validates (Check 3 fallback preserved)', () => {
  const text = buildPronounHeavyReview();
  assert.ok(text.length > 3000);
  const result = validateShowMentioned(text, "joe turner's come and gone", 'joe-turners-come-and-gone-2026');
  assert.equal(result.valid, true, `expected the partial-match fallback to still validate, got: ${result.reason}`);
  assert.equal(result.confidence, 'low');
});

test('validateShowMentioned: exact title match still short-circuits (Check 1 unaffected)', () => {
  const text = 'A wonderful new production of Hamilton opened last night to rapturous applause. '.repeat(5);
  const result = validateShowMentioned(text, 'Hamilton', 'hamilton-2015');
  assert.equal(result.valid, true);
  assert.equal(result.reason, 'Exact show title found');
});

// Check 3's word-boundary guard: a short idWord (e.g. "rent" from a show
// like "rent-2026") must not match as a mid-word substring of an unrelated
// word ("diffeRENT", "appaRENT") — found in review by an adversarial code
// review of this fix; Check 3 originally reused idWords with a bare
// .includes(), reopening the exact substring hole Check 2's single-word
// branch already guards against via its length>4 floor.
test('validateShowMentioned: Check 3 rejects a short idWord matched only as a mid-word substring (rent-2026 class)', () => {
  const paragraph = 'A completely different topic entirely, nothing theater related except this apparent mention of an unrelated matter. The theatre world watches on as the stage performance from the touring actor troupe drew applause at the curtain call. ';
  let text = '';
  while (text.length < 3200) text += paragraph;
  const result = validateShowMentioned(text, null, 'rent-2026');
  assert.equal(result.valid, false, `"rent" should not match inside "different"/"apparent", got: ${result.reason}`);
});

// ============================================================================
// validateShowMentioned generic idWords (task #947, live incident during
// task #914's outlet sweep). showId 'a-woman-among-women-off-broadway-2026'
// decomposes to idWords ['woman','among','women','broadway'] — every one of
// them a common English word or market-suffix artifact, so Check 2's
// "2+ matches" bar was clearing on generic-usage rate alone. Two completely
// unrelated Variety articles (an actor profile, a Tony-Awards-hosting news
// piece) were written as contentTier=complete "reviews" of the show as a
// result, overriding a prior correct url_content_mismatch rejection.
// ============================================================================

// Synthetic stand-in for the real incident fixture (a celebrity profile) —
// not the copyrighted article text, which lives only in the private
// review-texts repo. Deliberately hits 'women'/'among'/'broadway' at
// ordinary-English-usage rates while never mentioning the show.
function buildUnrelatedCelebrityProfile() {
  const paragraph = 'The actor reflected on a long career among veteran performers, noting that women in the industry still fight for equal billing on Broadway and beyond. He recalled early roles playing men of few words, and joked that among his proudest credits was a single scene that ran the length of a full act. Broadway insiders say the honor is well deserved. ';
  let text = '';
  while (text.length < 3200) text += paragraph;
  return text;
}

test('validateShowMentioned: unrelated long article hitting only generic idWords is REJECTED (a-woman-among-women class, task #947)', () => {
  const text = buildUnrelatedCelebrityProfile();
  assert.ok(text.length > 3000);
  const result = validateShowMentioned(text, 'A Woman Among Women', 'a-woman-among-women-off-broadway-2026');
  assert.equal(result.valid, false, `expected rejection — idWords are all generic, got: ${result.reason}`);
});

test('validateShowMentioned: a show whose idWords are ALL generic still validates via exact title match (Check 1 unaffected)', () => {
  const text = 'Critics were divided on the new play A Woman Among Women, which opened downtown this week to mixed reviews. '.repeat(3);
  const result = validateShowMentioned(text, 'A Woman Among Women', 'a-woman-among-women-off-broadway-2026');
  assert.equal(result.valid, true, `expected Check 1 exact-title match to still validate, got: ${result.reason}`);
  assert.equal(result.reason, 'Exact show title found');
});

test('validateShowMentioned: idWords with a mix of generic and distinctive words still match on the distinctive word alone', () => {
  // 'little-women-2005' -> idWords ['little', 'women']; 'women' is generic
  // but 'little' is not, so the single-significant-word branch should fire.
  const text = 'This revival brings a fresh, unsentimental energy to the March sisters that keeps the show moving briskly through its two acts. '.repeat(15) + 'A little more restraint from the ensemble would have helped the quieter scenes land. ';
  const result = validateShowMentioned(text, 'Little Women', 'little-women-2005');
  assert.equal(result.valid, true, `expected 'little' alone to still validate, got: ${result.reason}`);
});

// verifyFullTextContent and validateContentMentionsShow have their own,
// independent idWords derivations (task #947 second-opinion review found
// both were reachable through the SAME show as the live incident and were
// not filtered). Both now apply the GENERIC_ID_WORDS filter too.
//
// Fixture deliberately avoids 'woman'/'among'/'women' (which would trip
// verifyFullTextContent's separate TITLE-word 50% match — a different,
// pre-existing mechanism working off the literal title string, not the
// showId-derived idWords this fix targets; out of scope here) and instead
// repeats only the idWords-fallback-relevant generic word 'broadway', which
// does not appear in the title itself.
function buildUnrelatedBroadwayIndustryPiece() {
  const paragraph = 'Ticket prices on Broadway have climbed again this season, with several long-running Broadway hits raising top prices ahead of the holidays. Industry watchers say Broadway grosses remain strong despite the increases. ';
  let text = '';
  while (text.length < 3200) text += paragraph;
  return text;
}

test('verifyFullTextContent: unrelated article hitting only generic idWords does NOT score a titleFound match (a-woman-among-women class, task #947)', () => {
  const text = buildUnrelatedBroadwayIndustryPiece();
  const result = verifyFullTextContent(text, { title: 'A Woman Among Women', id: 'a-woman-among-women-off-broadway-2026' });
  assert.equal(result.details.titleFound, false, `expected no title match from generic idWords alone, got positiveSignals: ${JSON.stringify(result.positiveSignals)}`);
});

test('validateContentMentionsShow: unrelated article hitting only generic idWords does NOT clear the mention threshold (task #947)', () => {
  const text = buildUnrelatedBroadwayIndustryPiece();
  const result = validateContentMentionsShow(text, null, 'A Woman Among Women', 'a-woman-among-women-off-broadway-2026');
  assert.equal(result.valid, false, `expected generic idWords alone to fail the mention-count gate, got: ${JSON.stringify(result)}`);
});
