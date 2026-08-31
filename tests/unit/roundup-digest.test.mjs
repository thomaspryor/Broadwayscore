/**
 * Unit tests for scripts/lib/roundup-digest.js — detect WestEndTheatre review-
 * roundup DIGESTS mis-stored as individual reviews. Precondition: WET url on a
 * non-WET outlet. MUST flag digests; MUST NOT flag a real critic's relayed
 * excerpt, and MUST NOT touch a legitimate review on its own domain.
 *
 * Run: node --test tests/unit/roundup-digest.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectRoundupDigest, detectPullQuoteCompilation } = require('../../scripts/lib/roundup-digest.js');

const WET = 'https://www.westendtheatre.com/351724/news/reviews/the-price-reviews/';

describe('detectRoundupDigest', () => {
  test('flags digest text on a WET-misattributed file', () => {
    const r = detectRoundupDigest({ fullText: 'Reviews are in for The Price, and the verdict is...', criticName: 'Ghenet Pinderhughes Randall', url: WET, outletId: 'telegraph' });
    assert.equal(r?.isRoundup, true);
  });

  test('flags publication-name-as-critic on a WET-misattributed file', () => {
    const r = detectRoundupDigest({ fullText: 'Passion at the Donmar — a strong revival.', criticName: 'Daily Telegraph', url: WET, outletId: 'daily-mail' });
    assert.equal(r?.isRoundup, true);
  });

  test('flags a known WET roundup author on a WET-misattributed file', () => {
    const r = detectRoundupDigest({ fullText: '19 years after its first staging, War Horse returns.', criticName: 'West End Theatre', url: WET, outletId: 'timeout' });
    assert.equal(r?.isRoundup, true);
  });

  test('does NOT flag a real critic excerpt relayed via WET (Tim Bano / FT — the counted case)', () => {
    const r = detectRoundupDigest({ fullText: 'Nineties garage music and nods to Beyoncé put new flesh on the old bones of Wilde’s comedy.', criticName: 'Tim Bano', url: WET, outletId: 'financialtimes' });
    assert.equal(r, null);
  });

  test('does NOT flag a legit review on its OWN domain (precondition: must be a WET url)', () => {
    // FT bylines staff reviews as "Financial Times" on ft.com — legitimate.
    assert.equal(detectRoundupDigest({ fullText: 'A pointed, well-argued FT review.', criticName: 'Financial Times', url: 'https://www.ft.com/content/abc', outletId: 'financialtimes' }), null);
    // The Stage bylines some reviews as "The Stage" on thestage.co.uk — legitimate.
    assert.equal(detectRoundupDigest({ fullText: 'A real Stage review mentioning the critics have had their say.', criticName: 'The Stage', url: 'https://www.thestage.co.uk/reviews/x', outletId: 'thestage' }), null);
  });

  test('does NOT flag a WET page that IS the WestEndTheatre outlet itself', () => {
    assert.equal(detectRoundupDigest({ fullText: 'Reviews are in for X.', criticName: 'West End Theatre', url: WET, outletId: 'westendtheatre' }), null);
  });

  test('returns null on empty input', () => {
    assert.equal(detectRoundupDigest({}), null);
    assert.equal(detectRoundupDigest(null), null);
  });
});

// Fictional review prose below (no copyrighted excerpts) — only real,
// registered outlet names are used so isRegisteredOutlet() resolves them.
describe('detectPullQuoteCompilation (task #1888)', () => {
  test('flags a "critical consensus" page bylined to a critic who never gives their own verdict (the newyorktheater.me shape)', () => {
    const fullText = 'A new production opened tonight at the August Wilson Theatre. That is the critical consensus, as indicated below: '
      + 'Helen Shaw, New York Times. A confident, unsettling piece of theater that earns its scares. '
      + 'Jackson McHenry, Vulture. The design team pulls off tricks that leave the audience gasping. '
      + "Howard Miller, Talkin' Broadway. A tightly wound thriller with a starry cast. "
      + 'Johnny Oleksinski, New York Post. Genuinely frightening in a way few Broadway shows manage. '
      + 'Frank Rizzo, Variety. A slick, well-drilled production that never quite finds its heart.';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'nyt-theater', criticName: 'Jonathan Mandell' });
    assert.equal(r?.isRoundup, true);
  });

  test('does NOT flag a real critic review that quotes ONE rival outlet in passing', () => {
    const fullText = 'This revival earns its long run. As The Guardian noted in an earlier notice, the design has always been the draw here, '
      + 'and this cast only deepens that impression across a satisfying two hours.';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'nytimes', criticName: 'Jesse Green' });
    assert.equal(r, null);
  });

  test('does NOT flag when the byline critic is themselves one of the attributed quotes (syndicated wire digest carrying their own verdict)', () => {
    const fullText = "Here are what the critics said after Thursday's opening: "
      + 'Frank Rich, New York Times. A gripping entertainment that earns its long run. '
      + 'David Patrick Stearn, USA Today. Worth the high ticket price for the visual thrills alone. '
      + 'Michael Kuchwara, Associated Press. The central performance carries the whole show. '
      + "Howard Kissel, New York Daily News. Apart from some impressive performances, there's not much else to make this worthwhile.";
    const r = detectPullQuoteCompilation({ fullText, outletId: 'nydailynews', criticName: 'Howard Kissel' });
    assert.equal(r, null);
  });

  test('does NOT flag on a consensus-intro phrase alone with fewer than 2 corroborating outlet attributions', () => {
    const fullText = 'Reviews are in for the new revival, and the response has been warm across the board. '
      + 'This critic found plenty to admire in a well-cast, briskly paced production that never overstays its welcome.';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'amny', criticName: 'Matt Windman' });
    assert.equal(r, null);
  });

  test('flags a consensus-intro phrase corroborated by 2 distinct other-outlet attributions', () => {
    const fullText = "Here's what critics are saying about the new revival: "
      + 'Adam Feldman, Time Out New York. A joyous, big-hearted revival that never once loses its footing across two brisk acts. '
      + 'David Rooney, The Hollywood Reporter. Confidently staged and beautifully sung, this is a production built to last well beyond opening week.';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'broadwayworld', criticName: 'A.A. Cristi' });
    assert.equal(r?.isRoundup, true);
  });

  test('does NOT flag a marketing pull-quote footer of one-line blurbs on a real review (short excerpts, not real quoted paragraphs)', () => {
    const fullText = 'This revival is a triumph of staging and voice, anchored by a cast that never lets the material down. '
      + '"A must-see!" — J. Smith, Time. "Electrifying" — A. Jones, Observer. "Don\'t miss it" — B. Lee, Post.';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'nytimes', criticName: 'Jesse Green' });
    assert.equal(r, null);
  });

  test('returns null on empty input', () => {
    assert.equal(detectPullQuoteCompilation({}), null);
    assert.equal(detectPullQuoteCompilation(null), null);
    assert.equal(detectPullQuoteCompilation({ outletId: 'nytimes' }), null);
  });

  // BRO-2520: Gold Derby's goldderby--ethan-alter.json (paranormal-activity-2026)
  // slipped past the comma-shape-only detector — its "sampling of the critical
  // reaction" section uses prose narrative attribution ("Variety's Frank Rizzo
  // agrees, writing: ...") instead of the "{Name}, {Outlet}." shape. These tests
  // cover the two new prose shapes added to catch it.
  test('flags a prose-narrative compilation using the possessive "{Outlet}\'s {Critic}" shape (the Gold Derby shape)', () => {
    const fullText = "It's a real scream, and here's a sampling of the reaction. "
      + 'Entertainment Weekly\'s Emlyn Travis got the shivers, raving that the show is "jam-packed with jaw-dropping illusions." '
      + 'Variety\'s Frank Rizzo agrees, writing: "The stage version delivers more thrills and chills than Broadway has seen in years." '
      + 'And Time Out New York\'s Raven Snook pens a four-star rave, adding: "The whole show is a scream."';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'goldderby', criticName: 'Ethan Alter' });
    assert.equal(r?.isRoundup, true);
  });

  test('tolerates the scraper artifact of a stray space before the possessive apostrophe ("Variety \'s Frank Rizzo")', () => {
    const fullText = "It's a real scream, and here's a sampling of the reaction. "
      + 'Entertainment Weekly \'s Emlyn Travis got the shivers, raving that the show is "jam-packed with jaw-dropping illusions." '
      + 'Variety \'s Frank Rizzo agrees, writing: "The stage version delivers more thrills and chills than Broadway has seen in years." '
      + 'And Time Out New York \'s Raven Snook pens a four-star rave, adding: "The whole show is a scream."';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'goldderby', criticName: 'Ethan Alter' });
    assert.equal(r?.isRoundup, true);
  });

  test('flags a prose-narrative compilation using the "{Critic} of {Outlet}" shape', () => {
    const fullText = "It's a real scream, and here's a sampling of the reaction. "
      + 'Entertainment Weekly\'s Emlyn Travis got the shivers, raving that the show is "jam-packed with jaw-dropping illusions." '
      + 'Variety\'s Frank Rizzo agrees, writing: "The stage version delivers more thrills and chills than Broadway has seen in years." '
      + 'Ron Fassler of Theater Pizzazz also yearned for something more, adding: "It does not amount to much more than a stretched-out episode."';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'goldderby', criticName: 'Ethan Alter' });
    assert.equal(r?.isRoundup, true);
  });

  test('does NOT flag a possessive-shape mention without a quoted excerpt — ordinary prose apostrophes (contractions) must not count as a quote', () => {
    // Regression test: an earlier version of QUOTE_CHAR_RE included a bare
    // apostrophe, so ordinary contractions ("didn't", "it's") anywhere in the
    // trailing span satisfied the "quoted excerpt" guard, making it a no-op.
    const fullText = "It's a real scream, and here's a sampling of the reaction. Erivo told the paper she doesn't pay attention to the noise online — "
      + "she's got a job to do, and she isn't going to let anyone's comments take the energy she needs for the stage, no matter what people think. "
      + 'Variety\'s Frank Rizzo also weighed in on the production values without directly praising or panning the show itself, focusing instead on the design choices made by the creative team throughout its long and winding two-hour running time. '
      + "And Time Out New York's Raven Snook wasn't available for comment, though the piece notes she's expected to weigh in once the show settles into its run over the coming weeks and months ahead.";
    const r = detectPullQuoteCompilation({ fullText, outletId: 'bbc-news', criticName: 'Yasmin Rufo' });
    assert.equal(r, null);
  });

  test('strips a leading conjunction from a possessive-shape outlet capture ("And Time Out New York\'s..." resolves to the registered outlet "Time Out New York")', () => {
    const fullText = "It's a real scream, and here's a sampling of the reaction. "
      + 'Entertainment Weekly\'s Emlyn Travis got the shivers, raving that the show is "jam-packed with jaw-dropping illusions." '
      + 'Variety\'s Frank Rizzo agrees, writing: "The stage version delivers more thrills and chills than Broadway has seen in years." '
      + 'And Time Out New York\'s Raven Snook pens a four-star rave, adding: "The whole show is a scream."';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'goldderby', criticName: 'Ethan Alter' });
    assert.equal(r?.isRoundup, true);
    assert.match(r.reason, /timeout/);
  });

  // Review-flagged residual risk (BRO-2520): the outlet registry legitimately
  // registers several bare common-English-word aliases (Time, Post, Stage,
  // Mirror, Observer, People, Herald...), so a possessive/"of" construction
  // that happens to land on one of those words in ordinary prose — not an
  // actual outlet attribution — is a structural coincidence risk shared with
  // the pre-existing comma shape. A SINGLE such coincidental match can never
  // trigger the ≥3-distinct-outlets threshold or the intro-phrase+2 fallback
  // on its own, so an isolated one-off mention must not flag.
  test('does NOT flag on an isolated "{bare-common-word-outlet}\'s {Phrase}" coincidence with no surrounding compilation', () => {
    const fullText = 'This revival is a triumph of staging and voice. The design team clearly had one eye on next year\'s '
      + "People's Choice Award, and it shows in the lavish, crowd-pleasing spectacle they've built around a game cast "
      + 'that never lets the material down across a brisk and thoroughly satisfying two hours.';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'nytimes', criticName: 'Jesse Green' });
    assert.equal(r, null);
  });

  test('does NOT flag a compilation whose excerpts use only curly single quotes (‘…’), not double quotes — known limitation, see QUOTE_CHAR_RE comment', () => {
    const fullText = "It's a real scream, and here's a sampling of the reaction. "
      + "Entertainment Weekly's Emlyn Travis got the shivers, raving that the show is ‘jam-packed with jaw-dropping illusions.’ "
      + "Variety's Frank Rizzo agrees, writing: ‘The stage version delivers more thrills and chills than Broadway has seen in years.’ "
      + "Time Out New York's Raven Snook pens a four-star rave, adding: ‘The whole show is a scream.’";
    const r = detectPullQuoteCompilation({ fullText, outletId: 'goldderby', criticName: 'Ethan Alter' });
    assert.equal(r, null);
  });

  test('does NOT flag when the byline critic is themselves attributed via the possessive shape (own-byline escape hatch survives the possessive/"of"-shape group reordering)', () => {
    const fullText = "Here's a sampling of the critical reaction. "
      + 'Entertainment Weekly\'s Emlyn Travis got the shivers, raving that the show is "jam-packed with jaw-dropping illusions." '
      + 'Variety\'s Frank Rizzo agrees, writing: "The stage version delivers more thrills and chills than Broadway has seen in years." '
      + 'And Gold Derby\'s Ethan Alter found real dramatic dead spots amid the scares, writing: "It carries the play through some flat stretches."';
    const r = detectPullQuoteCompilation({ fullText, outletId: 'goldderby', criticName: 'Ethan Alter' });
    assert.equal(r, null);
  });
});
