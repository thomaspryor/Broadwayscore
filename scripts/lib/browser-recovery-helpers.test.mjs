import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Point the module's show lookup at a scratch shows.json BEFORE requiring it
// — SHOWS_JSON_PATH is read once at module-load time.
const tmpShowsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-shows-'));
const tmpShowsPath = path.join(tmpShowsDir, 'shows.json');
fs.writeFileSync(tmpShowsPath, JSON.stringify([
  { id: 'hamlet-2026', previewsStartDate: '2026-01-05', openingDate: '2026-01-20' },
  { id: 'joe-turners-come-and-gone-2026', previewsStartDate: '2026-03-01', openingDate: '2026-03-15' },
]));
process.env.SHOWS_JSON_PATH = tmpShowsPath;

const { processRecoveredText } = require('./browser-recovery-helpers.js');

// Real text from the reverted task #895 recovery (data/review-texts commit
// 1b7cf875c71): hamlet-2026/nytimes--charles-isherwood.json. A genuine, well
// -written NYT review — of a 2015 Classic Stage Company "Hamlet" starring
// Peter Sarsgaard, 11 years before the 2026 Broadway "hamlet-2026" show it
// got attached to. It passes validateShowMentioned trivially (the bare word
// "Hamlet" appears throughout), so only a date check catches this class.
const ISHERWOOD_HAMLET_2015 = `A lavish tiered wedding cake stands sentinel throughout the new production of "Hamlet" that opened Wednesday at the Classic Stage Company, with Peter Sarsgaard in the title role. As the presence of this big pile of pastry suggests, the concept behind this stylish-looking modern-dress production directed by Austin Pendleton essentially presents the action as a long dramatic hangover after the wedding celebrations for Claudius and Gertrude.

A bar with top-shelf liquor sits in one corner of the theater, a cocktail table in another. At center stage for most of the drama is a round table set for a celebratory dinner, surrounded by black cane chairs, the kind that gnaw into your back at formal functions. Unfortunately, by the end of this respectable but sluggish production, which runs over three hours, you may feel as you do after attending one of those overblown weddings that seem to go on for days, and sometimes do. In other words, dazed and ready for bed.

Mr. Pendleton is an accomplished actor and director who staged three of this company's uneven cycle of Chekhov's major plays, and recently the fine production of Stephen Adly Guirgis's "Between Riverside and Crazy." He also has a distinguished reputation as an acting teacher. It's the spirit of the pedagogue that seems to get the upper hand during the more ponderous expanses of the production, when bits of business that could easily be dispatched more quickly are belabored.

Mr. Sarsgaard, with his head shaved, delivers an emotionally intense and lucid Hamlet. But his Hamlet doesn't seem tortured by indecision and the weight of his particular responsibility; rather, he seems generally cranky and angry at the world, prone to fits of sarcasm and petulance.

The decision to excise the ghost of Hamlet's father from the production, the most radical change here, points to the possibility that Hamlet's pursuit of vengeance may stem from his own psychological problems. There are virtues in his always watchable if rarely penetrating interpretation. Mr. Sarsgaard speaks the verse in an easily digested colloquial style that fits snugly within the production's modern-dress context.

Lisa Joyce lends Ophelia an unusual and appealing firmness of spirit. She is often onstage in scenes in which she has no part, bearing witness with watchful eyes. And when Hamlet brutally rejects her, Ms. Joyce's Ophelia reacts with a bewilderment that bleeds into near-hysteria, so that the madness that overtakes her does not seem, as it often does, to come out of nowhere.

Mr. Yulin is a dignified Claudius, with a firm grip on the rhythm and sense in the verse. Ms. Allen's Gertrude matches Mr. Yulin's Claudius in restraint and dignity. Stephen Spinella's Polonius is very much from the nonbuffoonish, noncomic school. Mr. Fitzgerald's Laertes is particularly hot-blooded, nicely matched in a way to Mr. Sarsgaard's Hamlet, so that their duel to the death seems an inevitability.

The wedding cake, by the way, survives the production intact, with its white swirls of frosting still pristine as the lights dim. Of course the principal characters, all dead by the time this party's over, don't fare as well. Nobody gets to eat dessert.`;

function makeCandidateFile(showId, url, publishDate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsc-recovery-'));
  const filePath = path.join(dir, 'nytimes--critic.json');
  fs.writeFileSync(filePath, JSON.stringify({ url, showId, publishDate, contentTier: 'stub' }));
  return {
    reviewId: `${showId}/nytimes--critic.json`,
    filePath,
    url,
    showId,
    existingChars: 0,
    contentTier: 'stub',
  };
}

test('processRecoveredText: rejects a genuine review of the WRONG production when publishDate is far outside the show window (hamlet-2026 class, task #895/#915)', () => {
  const candidate = makeCandidateFile(
    'hamlet-2026',
    'https://www.nytimes.com/2015/04/15/theater/review-hamlet-as-an-after-party-that-got-out-of-hand.html',
    'April 15th, 2015'
  );
  const result = processRecoveredText(candidate, ISHERWOOD_HAMLET_2015, { fetchMethod: 'test', sourceMethod: 'test' });
  assert.equal(result.ok, false, 'a review 11 years before the show opened must not be auto-accepted');
  assert.match(result.reason, /date implausible/);

  // The candidate file itself must be untouched — no partial write leaking
  // wrong-production text into contentTier=complete.
  const onDisk = JSON.parse(fs.readFileSync(candidate.filePath, 'utf8'));
  assert.equal(onDisk.fullText, undefined);
  assert.equal(onDisk.contentTier, 'stub');
});

test('processRecoveredText: a plausibly-dated review for the right show proceeds past the date guard', () => {
  const text = `Joe Turner's Come and Gone returned to the stage this week in a production that finds new urgency in August Wilson's text. `.repeat(40);
  const candidate = makeCandidateFile(
    'joe-turners-come-and-gone-2026',
    'https://www.nytimes.com/2026/03/16/theater/joe-turners-come-and-gone-review.html',
    '2026-03-16'
  );
  const result = processRecoveredText(candidate, text, { fetchMethod: 'test', sourceMethod: 'test' });
  assert.equal(result.ok, true, `expected the plausibly-dated review to pass the date guard, got: ${result.reason}`);
});
