import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyAggregatorByline, STAFF_CRITIC_AGGREGATOR_OUTLET_IDS } = require('./aggregator-outlet-byline-audit.js');

// --- Fixtures drawn from real corpus data (BRO-225, 2026-08-14 audit) ---

// KEEP bucket: london-box-office / Stuart King — LBO's own head reviewer,
// first-party masthead byline (confirmed via live-page fetch), full-length
// original text, no overlap with any real-outlet sibling.
const LBO_STUART_KING_KEEP = {
  outletId: 'london-box-office',
  criticName: 'Stuart King',
  fullText: "A DOLL'S HOUSE — but not as we know it. Directed by Joe Hill-Gibbins for the Almeida, the new production which opened last evening, is a distinctly modern adaptation with only occasional nods to Ibsen's 1879 Scandic original, filled with its claustrophobic bourgeois marital tropes. In this overhaul by Anya Reiss, we're in the cosy basement of a plush-carpeted rental, where Nora has assembled the proceeds of her blow-out shopping spree for the Christmas hols.",
};

// KEEP bucket: dtli / Ran Xia — a genuine DTLI contributor (confirmed via
// live-page fetch: "A review of American Buffalo by Ran Xia"), text does not
// appear in any other outlet's file for the same show.
const DTLI_RAN_XIA_KEEP = {
  outletId: 'dtli',
  criticName: 'Ran Xia',
  fullText: 'There is no denying the technical merits of the production, from the lived-in grime of the junk shop set to the way the actors inhabit Mamet\'s clipped, overlapping dialogue with total conviction, even when the play itself circles the same three ideas for ninety minutes without much forward motion.',
};

// COLLAPSE bucket: dtli / Juan Michael Porter II on
// a-beautiful-noise-the-neil-diamond-musical-2022 — fullText is lifted
// verbatim from Charles Isherwood's WSJ review (already filed separately as
// wsj--charles-isherwood.json for the same show).
const DTLI_COLLAPSED_DUPLICATE = {
  outletId: 'dtli',
  criticName: 'Juan Michael Porter II',
  fullText: 'There are certainly some infectious sing-along numbers, notably “Sweet Caroline.” And Mr. Diamond had an early knack for jaunty (if derivative) 1960s guitar-driven pop, evinced by the smash “I’m a Believer,” which the Monkees made famous. But this smoothly produced show’s presentation of his semi-symphonic rock and sentimental balladry failed to convert me. I’m still not a believer.',
};

const WSJ_ISHERWOOD_SIBLING = {
  outletId: 'wsj',
  criticName: 'Charles Isherwood',
  fullText: 'Giving a fair assessment of a jukebox musical is not easy when you find yourself intermittently wanting to pull the plug. “A Beautiful Noise, the Neil Diamond Musical” will appeal primarily to the many admirers of Mr. Diamond’s songbook. Growing up in the 1970s, I certainly registered Mr. Diamond’s easy-listening pop-rock hits in my consciousness, but I never warmed to them. “A Beautiful Noise,” which moves through more than two dozen of Mr. Diamond’s songs as it unfolds his journey from lonesome Brooklyn boy to lonesome worldwide stardom, did little to alter my opinion, although song and story are integrated with unusual care and intelligence here. There are certainly some infectious sing-along numbers, notably “Sweet Caroline.” And Mr. Diamond had an early knack for jaunty (if derivative) 1960s guitar-driven pop, evinced by the smash “I’m a Believer,” which the Monkees made famous. But this smoothly produced show’s presentation of his semi-symphonic rock and sentimental balladry failed to convert me. I’m still not a believer.',
};

const UNRELATED_SIBLING = {
  outletId: 'nytg',
  criticName: 'Someone Else',
  fullText: 'A completely different review of a completely different production, sharing no text at all with the aggregator file under test, padded out well past the two-hundred character minimum comparison threshold so the sibling is actually considered by the matcher.',
};

test('LBO staff critic (Stuart King) with no sibling match is kept', () => {
  const result = classifyAggregatorByline(LBO_STUART_KING_KEEP, [UNRELATED_SIBLING]);
  assert.equal(result.classification, 'staff-critic');
});

test('DTLI contributing critic (Ran Xia) with no sibling match is kept', () => {
  const result = classifyAggregatorByline(DTLI_RAN_XIA_KEEP, [UNRELATED_SIBLING]);
  assert.equal(result.classification, 'staff-critic');
});

test('DTLI file with content lifted from a real-outlet sibling is flagged as a collapsed duplicate', () => {
  const result = classifyAggregatorByline(DTLI_COLLAPSED_DUPLICATE, [UNRELATED_SIBLING, WSJ_ISHERWOOD_SIBLING]);
  assert.equal(result.classification, 'collapsed-duplicate');
  assert.equal(result.duplicateOfOutlet, 'wsj');
  assert.equal(result.duplicateOfCritic, 'Charles Isherwood');
});

// Regression fixtures (real corpus false positives found during BRO-225
// validation, 2026-08-14): both critics independently quoting the same
// distinctive line of dialogue from the show, and shared cast-list
// boilerplate copied from the same press release. Neither is evidence of a
// collapsed byline and both must classify as staff-critic, not
// collapsed-duplicate.
test('two critics independently quoting the same show dialogue is NOT a collapse (theatre-reviews-limited/bright-star false positive)', () => {
  const trl = {
    outletId: 'theatre-reviews-limited',
    criticName: 'David Roberts',
    fullText: '"And I understood that truth seeks us out - then walks beside us like a shadow, and one day it merges with us. Until it does, we are not truly whole." (Billy to Miss Murphy) Steve Martin and Edie Brickell\'s "Bright Star" is a welcomed infusion of optimism into the veins of the Broadway stage.',
  };
  const ap = {
    outletId: 'ap',
    criticName: 'Mark Kennedy',
    fullText: 'NEW YORK (AP) - The new Broadway musical "Bright Star" starts with a bit of bluster. Later in the show, a character says: "And I understood that truth seeks us out - then walks beside us like a shadow, and one day it merges with us. Until it does, we are not truly whole." Comedian and banjo enthusiast Steve Martin has teamed up with singer-songwriter Edie Brickell to write a cliche-ridden, foot-pounding, over-eager Southern Gothic romance that ill serves a wonderful Broadway debut.',
  };
  const result = classifyAggregatorByline(trl, [ap]);
  assert.equal(result.classification, 'staff-critic');
});

test('shared press-release cast list across outlets is NOT a collapse', () => {
  const trl = {
    outletId: 'theatre-reviews-limited',
    criticName: 'David Roberts',
    fullText: 'The strong ensemble cast features Olivia Lacie Andrews, Brandon Mel Borkowsky, Shavey Brown, Hannah Yun Chamberlain, Cydney Clark, Raúl Contreras, Tyler Jimenez, and many others in a production that never quite finds its footing despite considerable technical polish and an evident commitment from every performer on that stage.',
  };
  const deadline = {
    outletId: 'deadline',
    criticName: 'Greg Evans',
    fullText: 'The cast includes Olivia Lacie Andrews, Brandon Mel Borkowsky, Shavey Brown, Hannah Yun Chamberlain, Cydney Clark, Raúl Contreras, Tyler Jimenez, in a mounting that critics found visually striking but dramatically inert across its long, unhurried running time and repetitive structure.',
  };
  const result = classifyAggregatorByline(trl, [deadline]);
  assert.equal(result.classification, 'staff-critic');
});

test('non-aggregator outlets are not-applicable', () => {
  const result = classifyAggregatorByline({ outletId: 'nytimes', criticName: 'Someone', fullText: 'x'.repeat(300) }, []);
  assert.equal(result.classification, 'not-applicable');
});

test('unnamed/staff bylines are not-applicable (already excluded from the audit population)', () => {
  const result = classifyAggregatorByline({ outletId: 'dtli', criticName: 'Staff', fullText: 'x'.repeat(300) }, []);
  assert.equal(result.classification, 'not-applicable');
});

test('the three known staff-critic aggregator outlet IDs are exactly dtli/london-box-office/theatre-reviews-limited', () => {
  assert.deepEqual(
    [...STAFF_CRITIC_AGGREGATOR_OUTLET_IDS].sort(),
    ['dtli', 'london-box-office', 'theatre-reviews-limited']
  );
});
