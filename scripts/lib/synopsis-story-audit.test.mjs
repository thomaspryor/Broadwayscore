import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from './synopsis-story-audit.js';
import tpi from './todaytix-page-identity.js';

const { storySentences, synopsisStoryProblems } = pkg;
const { nonStoryReason } = tpi;

// Live rows from BRO-5063, as they read on 2026-10-11.
test('storySentences keeps initials, titles and the show name whole', () => {
  assert.deepEqual(
    storySentences('Three Victorian friends — J., George, and Harris — decide on a boating holiday. It goes wrong.'),
    ['Three Victorian friends — J., George, and Harris — decide on a boating holiday.', 'It goes wrong.'],
  );
  assert.equal(storySentences('Mr. Saturday Night tells the story of Buddy Young Jr. and his act. He is old.').length, 2);
  assert.equal(storySentences('Based on the Ring Lardner Jr.-Michael Kanin film, the musical follows Tess Harding.').length, 1);
  assert.equal(storySentences('It toured the Ahmanson Theatre (Los Angeles), Shakespeare Theatre Company (D.C.), and the Emerson Colonial Theatre (Boston).').length, 1);
  assert.deepEqual(
    storySentences("Rock 'N Roll! The First 5,000 Years was a Broadway musical revue conceived by Bob Gill.", "Rock 'N Roll! The First 5,000 Years"),
    ["Rock 'N Roll! The First 5,000 Years was a Broadway musical revue conceived by Bob Gill."],
  );
});

test('wikitext debris and audience pitch are hard problems', () => {
  const hay = { title: 'Hay Fever', synopsis: "The action is set in the Hall of David Bliss's house. ;A Saturday afternoon in June ) strikes a pose, 1925 thumb alt=middle aged white woman, striking a theatrical pose Sorel and Simon Bliss exchange bohemian dialogue." };
  assert.deepEqual(synopsisStoryProblems(hay, nonStoryReason).hard, ['wikitext-debris']);
  const pitch = { title: 'High Noon', synopsis: 'Don’t miss *High Noon*, a thriller like none other, as it brings one of the most iconic westerns to life on stage.' };
  assert.deepEqual(synopsisStoryProblems(pitch, nonStoryReason).hard, ['audience-pitch']);
});

test('a clean story synopsis has no problems, and a missing one is not flagged', () => {
  const ok = { title: 'Big', synopsis: 'Josh Baskin, a 12-year-old New Jersey boy, finds that whenever he sees 13-year-old Cynthia Benson, he is unaccountably speechless. For him, childhood has ended.' };
  assert.deepEqual(synopsisStoryProblems(ok, nonStoryReason), { hard: [], soft: [] });
  assert.deepEqual(synopsisStoryProblems({ synopsis: null }, nonStoryReason), { hard: [], soft: [] });
});

test('soft hits carry the reason and the sentence, and skip production news', () => {
  const billing = { title: 'The Misanthrope', synopsis: 'Sandra Oh takes the title role in a razor-sharp reimagining of Molière’s classic.' };
  const { soft } = synopsisStoryProblems(billing, s => (/title role/.test(s) ? 'selling-or-list' : null));
  assert.equal(soft.length, 1);
  assert.equal(soft[0].reason, 'selling-or-list');
  const news = { title: 'X', synopsis: 'This 2026 revival is directed by Debbie Allen at the Ethel Barrymore Theatre.' };
  assert.deepEqual(synopsisStoryProblems(news, () => 'production-news').soft, []);
});

test('dialogue with inner exclamations stays one sentence (BRO-5063 review)', () => {
  assert.deepEqual(storySentences('He shouts, "Stop! You fool!" and runs away. Then he sleeps.'), ['He shouts, "Stop! You fool!" and runs away.', 'Then he sleeps.']);
  const steel = { title: 'Steel Pier', synopsis: 'He manages to stand up and exclaims, "Alright! I understand! I\'ve got three weeks! Three weeks! " before hurrying off. He asks if she has a partner yet.' };
  assert.deepEqual(synopsisStoryProblems(steel, nonStoryReason).soft.filter(s => s.reason === 'fragment'), []);
});

test('second review: a stray inch mark rejoins at most three pieces; Capt. is not a sentence end', () => {
  assert.equal(storySentences('He buys a 12" record. Then he sleeps. She cries. Joe sells tickets. Fin.').length, 2);
  assert.deepEqual(storySentences('Capt. Hook kidnaps Wendy. Peter flies after them.'), ['Capt. Hook kidnaps Wendy.', 'Peter flies after them.']);
});

test('a content-warning bullet list is a hard problem (BRO-5063)', () => {
  const spies = { title: 'The Comedy About Spies', synopsis: 'Spies converge on a London hotel. Subject matters in the show include : \u2022 Physical and verbal abuse are depicted. \u2022 Characters are jump scared.' };
  assert.deepEqual(synopsisStoryProblems(spies, nonStoryReason).hard, ['bullet-list']);
});
