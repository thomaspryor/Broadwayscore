// Tests for the joint strategy of multi-show-review-fanout.js (BRO-5895): one
// critic piece that reviews two or three shows in a single running text, with
// no captions or per-show introductions marking the joins.
// Each fixture replays the SHAPE of a real article that failed before
// (titles, order, where the joins and listings sit). The prose is invented:
// review text is copyrighted and never enters this repo.
// Run: node --test scripts/lib/multi-show-review-fanout-joint.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planMultiShowFanout, applyMultiShowFanoutToFile, buildJointMatcher, rewriteParent } = require('./multi-show-review-fanout.js');

const SHOWS = [
  { id: 'midnight-off-broadway-2026', title: 'Midnight', category: 'off-broadway', openingDate: '2026-10-15' },
  { id: 'the-curious-case-of-benjamin-button-off-broadway-2026', title: 'The Curious Case of Benjamin Button', category: 'off-broadway', openingDate: '2026-10-21' },
  { id: 'school-pictures-off-broadway-2026', title: 'School Pictures', category: 'off-broadway', openingDate: '2026-10-18' },
  { id: 'two-girls-off-broadway-2026', title: 'Two Girls', category: 'off-broadway', openingDate: '2026-10-18' },
  { id: 'memoirs-of-amorous-gentlemen-off-broadway-2026', title: 'Memoirs of Amorous Gentlemen', category: 'off-broadway', openingDate: '2026-10-15' },
  { id: 'a-ghost-in-your-ear-off-broadway-2026', title: 'A Ghost in Your Ear', category: 'off-broadway', openingDate: '2026-10-09' },
  { id: 'anon-a-tempest-at-our-kitchen-table-off-broadway-2026', title: 'ANON – a tempest at our kitchen table', category: 'off-broadway', openingDate: '2026-10-14' },
  { id: 'good-time-charlie-off-broadway-2026', title: 'Good Time Charlie', category: 'off-broadway', openingDate: '2026-10-09' },
  { id: 'fish-off-broadway-2026', title: 'Fish', category: 'off-broadway', openingDate: '2026-10-11' },
];
const ID = Object.fromEntries(SHOWS.map((s) => [s.title, s.id]));

const filler = (topic, n) => Array.from({ length: n }, (_, i) =>
  `The ${topic} passage number ${i + 1} moves along at a patient, deliberate pace that the cast keeps up with real care.`).join(' ');

const base = (over) => ({ outletId: 'x', outlet: 'X', criticName: 'Critic', url: 'https://example.com/a', contentTier: 'complete', ...over });
const plan = (showId, fullText, over = {}) =>
  planMultiShowFanout(base({ showId, publishDate: '2026-10-20', fullText, ...over }), SHOWS, { joint: true });
const ids = (p) => [p.ownSection.showId, ...p.otherSections.map((s) => s.showId)].sort();
const section = (p, id) => [p.ownSection, ...p.otherSections].find((s) => s.showId === id).sectionText;

// NYT shape: one lede sentence names both shows, the first show's stretch,
// a transition sentence that names the second show mid-sentence, its
// stretch, then the closing run listings. No paragraph breaks survive.
const NYT_TWO = [
  'Two new shows downtown play games with time: “Midnight,” a sprawling quest, and “The Curious Case of Benjamin Button,” a folk fable.',
  `The more ambitious is the sprawling “Midnight,” which follows a night watchman through a city of dreams. ${filler('dream', 5)} By its last scene “Midnight” has earned its length.`,
  `Sadly, no amount of time could turn “The Curious Case of Benjamin Button” into my sort of evening. ${filler('banjo', 5)} Fans of the story may feel otherwise.`,
  'Midnight Through Jan. 3 at the Daryl Roth Theater, Manhattan; example.org. Running time: 2 hours 40 minutes.',
  'The Curious Case of Benjamin Button Through Dec. 6 at the Public Theater, Manhattan; example.org. Running time: 2 hours.',
].join(' ');

test('NYT two-show piece: lede names both, transition mid-sentence, listings at the end', () => {
  const p = plan(ID.Midnight, NYT_TWO);
  assert.ok(p, 'expected a plan');
  assert.equal(p.strategy, 'joint');
  assert.deepEqual(ids(p), [ID.Midnight, ID['The Curious Case of Benjamin Button']].sort());
  const m = section(p, ID.Midnight);
  const b = section(p, ID['The Curious Case of Benjamin Button']);
  assert.match(m, /^The more ambitious is the sprawling “Midnight,”/);
  assert.doesNotMatch(m, /Benjamin Button/, 'no other-show prose or listing in Midnight section');
  assert.match(m, /Midnight Through Jan\. 3 at the Daryl Roth/, 'own listing kept');
  assert.match(b, /^Sadly, no amount of time/);
  assert.match(b, /Benjamin Button Through Dec\. 6/);
  assert.doesNotMatch(b, /Midnight|Daryl Roth/);
  assert.doesNotMatch(m + b, /^Two new shows/, 'shared lede dropped');
});

test('a missing publish date falls back to firstSeenAt only near the own opening', () => {
  const bb = ID['The Curious Case of Benjamin Button'];
  const near = planMultiShowFanout(base({ showId: bb, firstSeenAt: '2026-10-22T03:07:20Z', fullText: NYT_TWO }), SHOWS, { joint: true });
  assert.ok(near, 'found a day after opening: fan out');
  assert.equal(near.ownSection.showId, bb);
  const late = planMultiShowFanout(base({ showId: bb, firstSeenAt: '2027-02-20T00:00:00Z', fullText: NYT_TWO }), SHOWS, { joint: true });
  assert.equal(late, null, 'found four months later: the date is not trusted');
});

// NYT shape 2: a joint lede that names neither show; the closing listing
// names both in one line.
const NYT_SHARED_LISTING = [
  'Small theaters reward small ideas, and this month one downtown house has two very different shows sharing its stage.',
  `I hope the composer of the excellent “School Pictures” likes a simile. ${filler('portrait', 5)} “School Pictures” ends with a gentle song.`,
  `Though it is just as portable, I cannot recommend the other production in the building, a jaunty and unpleasant “Two Girls,” for anyone. ${filler('roommate', 5)} The ending lands with a thud.`,
  'School Pictures and Two Girls Through Nov. 29 at the Cherry Lane Theater, Manhattan; example.org.',
].join(' ');

test('NYT shared-house piece: no titles in the lede, one shared closing listing', () => {
  const p = plan(ID['School Pictures'], NYT_SHARED_LISTING);
  assert.ok(p);
  assert.deepEqual(ids(p), [ID['School Pictures'], ID['Two Girls']].sort());
  const sp = section(p, ID['School Pictures']);
  const tg = section(p, ID['Two Girls']);
  assert.match(sp, /^I hope the composer/);
  assert.match(tg, /^Though it is just as portable/);
  assert.doesNotMatch(sp.split('\n\n')[0], /Two Girls/);
  assert.match(tg, /Through Nov\. 29 at the Cherry Lane/, 'shared listing kept for both');
});

// Vulture shape: bare (unquoted) titles, a photo caption first, run listings
// ("X is at ... through ...") and lowercase tag chrome at the end.
const VULTURE = [
  'From Memoirs of Amorous Gentlemen, at the Culture Club. Photo: A. Photographer',
  `Of all the preshow speeches this year, the one before Memoirs of Amorous Gentlemen is the oddest. ${filler('cabaret', 6)} Memoirs of Amorous Gentlemen is better company than its premise.`,
  `Speaking of strange preshow speeches, you will hear another at A Ghost in Your Ear, once the headphones go on. ${filler('headphone', 5)} Whether it works depends on you.`,
  'Memoirs of Amorous Gentlemen is at the Culture Club through January 3. A Ghost in Your Ear is at the Minetta Lane Theatre through December 12.',
  'Tags: theater review memoirs of amorous gentlemen a ghost in your ear More Stories',
].join(' ');

test('Vulture double review: bare titles, run listings, tag chrome', () => {
  const p = plan(ID['Memoirs of Amorous Gentlemen'], VULTURE);
  assert.ok(p);
  assert.deepEqual(ids(p), [ID['Memoirs of Amorous Gentlemen'], ID['A Ghost in Your Ear']].sort());
  const g = section(p, ID['A Ghost in Your Ear']);
  assert.match(g, /^Speaking of strange preshow speeches/);
  assert.match(g, /A Ghost in Your Ear is at the Minetta Lane Theatre through December 12\.$/);
  assert.doesNotMatch(g, /Tags:|Culture Club/);
  assert.doesNotMatch(section(p, ID['Memoirs of Amorous Gentlemen']), /Ghost/);
});

// WSJ shape: the head introduces both shows in order, each stretch follows,
// and the closing venue boxes carry no titles. The ANON stretch names its
// show once ("Anon" for "ANON – a tempest at our kitchen table").
const WSJ = [
  'Two plays this fall wrestle with the screens in our hands. “Anon,” a new drama about a mother lost to conspiracy forums, aims high.',
  'And a recorded voice leads the audience of “A Ghost in Your Ear” through a haunted apartment.',
  `“Anon,” at MCC Theater, is directed with precision by a reliable hand. ${filler('kitchen', 6)} The mother is hard to see as tragic.`,
  `Shakespeare is far from the script the actor is handed in “A Ghost in Your Ear,” a solo piece told through headphones. ${filler('whisper', 5)} By the end “A Ghost in Your Ear” lingers.`,
  'MCC Theater, 511 W. 52nd St., New York. Minetta Lane Theatre, 18 Minetta Lane, New York.',
].join(' ');

test('WSJ double review: head names both in order, no titled listings', () => {
  const p = plan(ID['A Ghost in Your Ear'], WSJ, { publishDate: '2026-10-15' });
  assert.ok(p);
  assert.deepEqual(ids(p), [ID['A Ghost in Your Ear'], ID['ANON – a tempest at our kitchen table']].sort());
  assert.match(section(p, ID['ANON – a tempest at our kitchen table']), /^“Anon,” at MCC Theater/);
  assert.match(section(p, ID['A Ghost in Your Ear']), /^Shakespeare is far from the script/);
});

// Theater Life shape: a star-rated header names all three shows, three
// stretches, then a star-rated listing for each show.
const THEATER_LIFE = [
  'Good Time Charlie ***, Fish ****, Anon ***',
  `Family secrets fill the memory play Good Time Charlie, at the Public Theater. ${filler('memory', 5)} Good Time Charlie needs a stronger spine.`,
  `The playwright’s Fish (a co-production of two companies) also digs into family trouble. ${filler('aquarium', 5)} The cast never lets go.`,
  `The internet plays a large part in the scathing but uneven Anon at MCC Theater. ${filler('screen', 5)} It is not a fully satisfying night.`,
  'Good Time Charlie *** Public Theater, 425 Lafayette St., NYC. Fish **** WP Theater, 2162 Broadway, NYC. Anon *** MCC Theater, 511 W. 52nd St., NYC.',
].join(' ');

test('Theater Life three-show column: star header, star-rated listings', () => {
  const p = plan(ID['Good Time Charlie'], THEATER_LIFE, { publishDate: '2026-10-16' });
  assert.ok(p);
  assert.deepEqual(ids(p), [ID['Good Time Charlie'], ID.Fish, ID['ANON – a tempest at our kitchen table']].sort());
  const f = section(p, ID.Fish);
  assert.match(f, /^The playwright’s Fish/);
  assert.match(f, /Fish \*\*\*\* WP Theater/, 'own star rating kept');
  assert.doesNotMatch(f, /Charlie|Anon/, 'no other show’s stars or prose');
  assert.match(section(p, ID['ANON – a tempest at our kitchen table']), /^The internet plays a large part[\s\S]*Anon \*\*\* MCC Theater/);
  assert.doesNotMatch(section(p, ID['Good Time Charlie']), /\*\*\*\*/, 'header with Fish stars dropped');
});

test('the joint strategy is on by default; MULTI_SHOW_JOINT=0 and opts.joint=false turn it off', () => {
  const prev = process.env.MULTI_SHOW_JOINT;
  const rec = () => base({ showId: ID['Good Time Charlie'], publishDate: '2026-10-16', fullText: THEATER_LIFE });
  try {
    delete process.env.MULTI_SHOW_JOINT;
    assert.ok(planMultiShowFanout(rec(), SHOWS));
    assert.equal(planMultiShowFanout(rec(), SHOWS, { joint: false }), null);
    process.env.MULTI_SHOW_JOINT = '0';
    assert.equal(planMultiShowFanout(rec(), SHOWS), null);
  } finally {
    delete process.env.MULTI_SHOW_JOINT;
    if (prev !== undefined) process.env.MULTI_SHOW_JOINT = prev;
  }
});

// --- Single-show reviews that must stay whole ---------------------------

test('single review: comparison lede and middle aside, review continues after', () => {
  const text = [
    'Like “Two Girls” down the street, “Midnight” is about friends who cannot let go.',
    `“Midnight” starts slowly. ${filler('lantern', 4)} “Midnight” then finds its feet.`,
    `“Two Girls” handled the same idea with a lighter touch. ${filler('comparison', 4)} “Two Girls” did not overstay.`,
    `Back at the Daryl Roth, the second act is a marvel. ${filler('finale', 6)} It is the best thing on stage this month.`,
  ].join(' ');
  assert.equal(plan(ID.Midnight, text), null);
});

// Each guard below has a fixture that passes every OTHER gate, so removing
// that one guard makes the test fail.

test('tail cap: a review that names both shows again late keeps its ending', () => {
  const text = [
    `“Midnight” is a long night out at the Daryl Roth. ${filler('lantern', 10)} “Midnight” never rests.`,
    `Down the street “Two Girls” tried something similar. ${filler('comparison', 6)} “Two Girls” was lighter.`,
    `The second act of “Midnight” is where it all comes together. ${filler('finale', 6)} Few shows this season, “Two Girls” included, end as well.`,
  ].join(' ');
  assert.equal(plan(ID.Midnight, text), null);
});

test('head order: a lede naming the other show first, then a closing aside about it', () => {
  const text = [
    'Fans of “Two Girls” will find “Midnight” familiar, though “Two Girls” was funnier.',
    `“Midnight” follows a night watchman through a city of dreams. ${filler('lantern', 6)} “Midnight” rarely flags.`,
    `As for “Two Girls,” its roommates bicker in a smaller key. ${filler('comparison', 5)} “Two Girls” wins on economy.`,
  ].join(' ');
  assert.equal(plan(ID.Midnight, text), null);
});

test('alternating paragraphs are one comparative review, even with listings for both', () => {
  const lede = 'Two shows this week, “Midnight” and “Two Girls,” both start late.';
  const end = '“Midnight” is at the Daryl Roth through Jan. 3. “Two Girls” is at the Minetta Lane through Dec. 6.';
  const m = (t, n) => `“Midnight” ${t}. ${filler('lantern', n)} “Midnight” goes on.`;
  const g = (t, n) => `“Two Girls” ${t}. ${filler('roommate', n)} “Two Girls” goes on.`;
  assert.equal(plan(ID.Midnight, [lede, m('opens dark', 4), g('opens bright', 4), m('turns', 4), g('turns too', 4), end].join(' ')), null);
  // Control: the same material grouped by show is a joint review.
  assert.equal(plan(ID.Midnight, [lede, m('opens dark', 8), g('opens bright', 8), end].join(' ')).strategy, 'joint');
});

test('lede comparison plus one late mention is a single review, not a joint one', () => {
  const text = [
    '“Midnight” is the second ghost story of the fall after “Two Girls.” It is the better one.',
    `“Midnight” is a tight ninety minutes. ${filler('lantern', 16)} “Midnight” rarely flags.`,
    `When “Two Girls” opened last month, I said the season needed more nerve. ${filler('verdict', 9)}`,
  ].join('\n\n');
  assert.equal(plan(ID.Midnight, text), null);
});

test('a closing sentence naming both shows is not a listing', () => {
  const text = [
    `“Midnight” is a long night out. ${filler('lantern', 22)} “Midnight” never rests.`,
    `The comparison everyone will make is with “Two Girls.” ${filler('comparison', 7)}`,
    'In the end “Midnight” is the better night. Fans of “Two Girls” should go anyway.',
  ].join('\n\n');
  assert.equal(plan(ID.Midnight, text), null);
});

test('a compact listing gives each show only its own rating', () => {
  const text = [
    'This week: “Midnight” and “Two Girls.”',
    `“Midnight” is a long night out. ${filler('lantern', 8)} “Midnight” never rests.`,
    `“Two Girls” is shorter and meaner. ${filler('roommate', 8)} “Two Girls” ends in a shrug.`,
    '“Midnight” ****, “Two Girls” ** and that is the week in theater.',
  ].join(' ');
  const p = plan(ID.Midnight, text);
  assert.match(section(p, ID.Midnight), /Midnight” \*\*\*\*$/);
  assert.match(section(p, ID['Two Girls']), /Two Girls” \*\* and that is the week in theater\.$/);
});

test('a joint-split parent re-trims with the joint strategy when the switch is off', () => {
  const whole = base({ showId: ID.Midnight, publishDate: '2026-10-20', fullText: NYT_TWO, multiShowSplitParent: true,
    multiShowSplitProcessed: true, multiShowSplitAnchorKind: 'joint', multiShowSplitTextLength: 100 });
  const p = planMultiShowFanout(whole, SHOWS, { ownShowId: ID.Midnight });
  assert.equal(p && p.strategy, 'joint');
});

test('no head route with a tail: a closing listing must name every show', () => {
  const text = [
    'Two shows this week, “Midnight” and “Two Girls,” both start late.',
    `“Midnight” is a long night out. ${filler('lantern', 6)} “Midnight” never rests.`,
    `“Two Girls” is shorter and meaner. ${filler('roommate', 6)} “Two Girls” ends in a shrug.`,
    'Midnight Through Jan. 3 at the Daryl Roth Theater, Manhattan; example.org.',
  ].join(' ');
  assert.equal(plan(ID.Midnight, text), null);
});

test('a show titled after someone credited on the reviewed show: the person never splits, a co-reviewed show still does', () => {
  const BB = ID['The Curious Case of Benjamin Button'];
  const credit = (name) => SHOWS.map((s) => (s.id === BB ? { ...s, creativeTeam: [{ name, role: 'Composer' }] } : s));
  const doc = (fullText) => base({ showId: BB, publishDate: '2026-10-20', fullText });
  // One-word credit ("Sting" for The Last Ship): the other show drops out.
  assert.equal(planMultiShowFanout(doc(NYT_TWO), credit('Midnight'), { joint: true }), null);
  // Surname credit: a real co-review of the show "Midnight" still splits...
  assert.deepEqual(ids(planMultiShowFanout(doc(NYT_TWO), credit('Ava Midnight'), { joint: true })),
    [ID['Midnight'], BB].sort());
  // ...but "Ava Midnight" and "Midnight's score" are the composer.
  const single = NYT_TWO.replace(/“Midnight,”/g, 'Ava Midnight,').replace(/“Midnight”/g, 'Midnight’s score')
    .replace(/^Midnight Through/m, 'Ava Midnight wrote through').replace(/Midnight Through/, 'Ava Midnight wrote through');
  assert.equal(planMultiShowFanout(doc(single), credit('Ava Midnight'), { joint: true }), null);
});

test('a one-word title opening ordinary sentences is not a mention', () => {
  const text = [
    `“Midnight” is a long night out. ${filler('lantern', 6)} “Midnight” never rests.`,
    `Fish swim across a projected sky in the second act. ${filler('sky', 6)} Fish appear again at the curtain call.`,
    'Midnight Through Jan. 3 at the Daryl Roth Theater, Manhattan; example.org. Fish tacos are sold in the lobby.',
  ].join(' ');
  assert.equal(plan(ID.Midnight, text), null);
});

test('a common-word title split off by a dash never matches bare', () => {
  const m = buildJointMatcher({ id: 'x', title: 'Company – The Revival' });
  m.re.lastIndex = 0;
  assert.equal(m.re.test('The Company at the Barrow Street gave a fine show.'), false);
  m.re.lastIndex = 0;
  assert.equal(m.re.test('I saw Company – The Revival last night.'), true);
  assert.equal(buildJointMatcher({ id: 'y', title: 'Six' }), null);
});

test('a show named only inside a longer title drops out instead of crashing', () => {
  // Corpus dry run crash: a show whose every mention sat inside a longer
  // title had no mentions left after the overlap rule and no run to point at.
  const shows = [...SHOWS, { id: 'your-ear-off-broadway-2026', title: 'Your Ear', category: 'off-broadway', openingDate: '2026-10-12' }];
  const p = planMultiShowFanout(base({ showId: ID['A Ghost in Your Ear'], publishDate: '2026-10-15', fullText: WSJ }), shows, { joint: true });
  assert.ok(p);
  assert.deepEqual(ids(p), [ID['A Ghost in Your Ear'], ID['ANON – a tempest at our kitchen table']].sort());
});

test('applying the plan writes each show its own section (Theater Life)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'joint-fanout-'));
  try {
    const own = ID['Good Time Charlie'];
    fs.mkdirSync(path.join(dir, own));
    const file = path.join(dir, own, 'theater-life--critic.json');
    fs.writeFileSync(file, JSON.stringify(base({ showId: own, publishDate: '2026-10-16', fullText: THEATER_LIFE, assignedScore: 75 })));
    const res = applyMultiShowFanoutToFile(file, { shows: SHOWS, reviewTextsDir: dir, joint: true });
    assert.equal(res.applied, true);
    assert.equal(res.strategy, 'joint');
    for (const id of [ID.Fish, ID['ANON – a tempest at our kitchen table']]) {
      const child = JSON.parse(fs.readFileSync(path.join(dir, id, 'theater-life--critic.json'), 'utf8'));
      assert.equal(child.showId, id);
      assert.equal(child.multiShowSplitChild, true);
      assert.doesNotMatch(child.fullText, /Good Time Charlie/);
    }
    const parent = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(parent.fullText, /^Family secrets fill the memory play/);
    assert.doesNotMatch(parent.fullText, /Fish|Anon/);
    // Guard I: every section is one review filed per show, so the article URL
    // may be filed under any of the three shows, and no other show.
    const own_ = require('./url-ownership.js');
    own_._resetUrlOwnershipIndex();
    for (const id of [own, ID.Fish, ID['ANON – a tempest at our kitchen table']]) {
      const owners = own_.findCrossShowOwners('https://example.com/a', id, dir);
      assert.equal(own_.shouldBlockCrossShowCreate(owners, null, id).block, false, `${id} is a section of the article`);
    }
    const stranger = own_.findCrossShowOwners('https://example.com/a', ID.Midnight, dir);
    assert.equal(own_.shouldBlockCrossShowCreate(stranger, null, ID.Midnight).block, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// BRO-5942 corpus backfill: shapes of the false positives the dry run found.

test('a single mention inside a sentence about the other show is a comparison, not a stretch', () => {
  // TheaterMania "My Name Is Lucy Barton": the lede recalls "The Sound
  // Inside", and one later sentence about the reviewed show names it again.
  const shape = (opener) => [
    '“Two Girls” closed last week. “Midnight” strikes similar chords at the Daryl Roth.',
    `${opener} ${filler('loneliness', 7)}`,
    `“Midnight” finds its own way in the second act. ${filler('lantern', 7)} “Midnight” ends quietly.`,
  ].join('\n\n');
  assert.equal(plan(ID.Midnight, shape('While the story told in “Two Girls” was about loneliness, this one is about memory.')), null);
  // Control: a stretch that opens on its title is that show's own review.
  assert.equal(plan(ID.Midnight, shape('“Two Girls” was about loneliness, and it said so plainly.')).strategy, 'joint');
});

test('a credited person named in full makes every bare surname that person', () => {
  // NYSR "Kramer/Fauci": "directed by Daniel Fish", then "Fish recreates...".
  const BB = ID['The Curious Case of Benjamin Button'];
  const shows = SHOWS.map((s) => (s.id === BB ? { ...s, creativeTeam: [{ name: 'Ava Midnight', role: 'Director' }] } : s));
  const text = NYT_TWO.replace('Two new shows downtown', 'Ava Midnight directs one of two new shows downtown');
  assert.equal(planMultiShowFanout(base({ showId: BB, publishDate: '2026-10-20', fullText: text }), shows, { joint: true }), null);
});

test('no head, and the second stretch opens in the first one\'s closing sentence: interleaved, not joint', () => {
  // Newsday "No Man's Land": a photo caption, a lede naming both repertory
  // shows, then one essay moving between them, then one shared listing.
  const body = [
    `“Midnight” at the Daryl Roth Theater, in a photo by a staff photographer. ${filler('rehearsal', 6)}`,
    `The company performs the familiar “Midnight,” and the sparer “Two Girls.” ${filler('repertory', 8)} “Two Girls” keeps the pace.`,
    `${filler('comparison', 6)} “Two Girls” closes on a shrug.`,
    'WHAT: “Midnight” and “Two Girls” WHERE: Daryl Roth Theater, 101 E. 15th St.',
  ];
  assert.equal(plan(ID.Midnight, body.join('\n\n')), null);
  // Control: a lede that names both first makes the same join a transition.
  const withHead = ['This week, “Midnight” and “Two Girls” share a stage.',
    `“Midnight” is the louder of the two. ${filler('lantern', 8)} By the end, while “Midnight” roars, “Two Girls” whispers. ${filler('roommate', 8)} “Two Girls” closes on a shrug.`,
    body[3]];
  assert.equal(plan(ID.Midnight, withHead.join('\n\n')).strategy, 'joint');
});

test('a credits listing with no sentence end never opens the next section (Flipside)', () => {
  // Flipside "Thérèse Raquin / King Charles III": the piece opens on both
  // shows' credits (title, writer, director, dates, theatre, web address)
  // with no full stop anywhere, then each review opens on a photo caption.
  // The second show's credits sat between its title and the first review,
  // so the cut fell back to the title and the first section opened on the
  // second show's credits: the scorer rejected it as the wrong production.
  const text = [
    'School Pictures Written by D. Writer; directed by E. Director Performances through January 3, 2026 Studio 54, 254 West 54th Street, New York, NY schoolpictures.org',
    'Midnight Written by A. Writer; directed by B. Director Performances through January 31, 2026 Music Box Theatre, 239 West 45th Street, New York, NY midnightshow.com',
    `Actor One and Actor Two in “School Pictures” (photo: C. Photographer) “School Pictures” is a quiet piece about a class photographer. ${filler('portrait', 8)} “School Pictures” never raises its voice.`,
    `Actor Three in “Midnight” (photo: C. Photographer) “Midnight” is a long night watch in a city of dreams. ${filler('dream', 10)} By its last scene “Midnight” has earned its length.`,
  ].join(' ');
  const p = plan(ID.Midnight, text);
  assert.ok(p, 'expected a plan');
  assert.equal(p.strategy, 'joint');
  const s = section(p, ID['School Pictures']);
  assert.match(s, /^Actor One and Actor Two in “School Pictures”/);
  assert.doesNotMatch(s, /midnightshow\.com|Music Box/, 'no Midnight credits in the School Pictures section');
  assert.match(section(p, ID.Midnight), /^Actor Three in “Midnight”/);
});

test('a split parent drops a rating an LLM read off the whole article, keeps a scraped one (Observer)', () => {
  const own = { sectionText: 'Plaza Suite is a creaky vehicle.', anchorKind: 'joint' };
  const llm = rewriteParent({ fullText: 'whole article', originalScore: '4/5 stars', originalScoreSource: 'llm-gemini', starRating: 4 }, own, ['till-2024']);
  assert.equal(llm.originalScore, null);
  assert.equal(llm.originalScoreSource, null);
  assert.equal(llm.starRating, null);
  assert.equal(llm.originalScoreCorrectedFrom, '4/5 stars');
  assert.equal(llm.originalScoreCleared, true);
  const scraped = rewriteParent({ fullText: 'whole article', originalScore: '2/5 stars', originalScoreSource: 'guardian-api' }, own, ['till-2024']);
  assert.equal(scraped.originalScore, '2/5 stars');
  assert.equal(scraped.originalScoreSource, 'guardian-api');
});

test('a web address in ordinary prose never moves the cut into the next show\'s sentence', () => {
  const shows = [
    { id: 'midnight', title: 'Midnight', category: 'off-broadway', openingDate: '2026-10-15' },
    { id: 'school', title: 'School Pictures', category: 'off-broadway', openingDate: '2026-10-18' },
  ];
  const filler = (t, n) => Array.from({ length: n }, (_, i) => `The ${t} passage number ${i + 1} moves along at a patient, deliberate pace that the cast keeps up with real care.`).join(' ');
  const fullText = [
    'Two shows this week: “School Pictures” and “Midnight”.',
    `“School Pictures” is a quiet piece. ${filler('portrait', 8)} “School Pictures” never raises its voice.`,
    `Fans who found it via Broadway.com will love “Midnight” which is a long night watch. ${filler('dream', 10)} By its last scene “Midnight” has earned its length.`,
  ].join(' ');
  const plan = planMultiShowFanout({ showId: 'midnight', outletId: 'x', criticName: 'c', url: 'https://e.com/a', contentTier: 'complete', publishDate: '2026-10-20', fullText }, shows, { joint: true });
  assert.ok(plan, 'expected a joint plan');
  const mid = [plan.ownSection, ...plan.otherSections].find((s) => s.showId === 'midnight');
  assert.ok(mid.sectionText.startsWith('Fans who found it via Broadway.com'), mid.sectionText.slice(0, 60));
});
