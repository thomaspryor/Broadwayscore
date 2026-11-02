// BRO-6736: joint reviews (one article covering several shows) must go live on
// EVERY show. Fixtures replay the SHAPE of the real articles; prose is invented.
// Run: node --test scripts/lib/multi-show-joint-sibling.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planMultiShowFanout, applyMultiShowFanoutToFile, heldSiblingNeedsTrim } = require('./multi-show-review-fanout.js');
const { findSectionHeadings, extractShowSection, isolateMultiShowSection } = require('./multi-show-section-extract.js');

const SHOWS = [
  { id: 'marjorie-prime-x', title: 'Marjorie Prime', category: 'broadway', openingDate: '2025-12-08' },
  { id: 'anna-christie-x', title: 'Anna Christie', category: 'off-broadway', openingDate: '2025-12-11' },
  { id: 'bughouse-x', title: 'Bughouse', category: 'off-broadway', openingDate: '2026-03-05' },
  { id: 'silver-manhattan-x', title: 'Silver Manhattan', category: 'off-broadway', openingDate: '2026-03-08' },
  { id: 'burnout-paradise-x', title: 'Burnout Paradise', category: 'off-broadway', openingDate: '2026-03-10' },
  { id: 'the-dinosaurs-x', title: 'The Dinosaurs', category: 'off-broadway', openingDate: '2026-02-02' },
  { id: 'the-monsters-x', title: 'The Monsters', category: 'off-broadway', openingDate: '2026-02-05' },
];
const filler = (topic, n) => Array.from({ length: n }, (_, i) =>
  `The ${topic} passage number ${i + 1} moves along at a patient, deliberate pace that the cast keeps up with real care.`).join(' ');

// La Voce shape: per-show "Title ***/***** (N stars out of five)" heading, and a
// "Title . Through <date>" listing that CLOSES each section.
const LAVOCE = [
  'Several productions have recently opened below 23rd Street. Here is a look at three plays off the beaten path.',
  `Bughouse **/***** (two stars out of five) The new play Bughouse opened at the Vineyard. ${filler('bughouse', 6)} Bughouse . Through April 3 at The Vineyard Theatre (108 East 15th Street).`,
  `Silver Manhattan ****/***** (four stars out of five) The rock memoir Silver Manhattan opened last week. ${filler('silver', 6)} Silver Manhattan . Through March 29 at Bowery Palace (327 Bowery).`,
  `Burnout Paradise ***/***** (three stars out of five) Burnout Paradise, now playing at the Astor Place Theatre, is a party. ${filler('burnout', 6)} Burnout Paradise . Through June 28 at the Astor Place Theatre (434 Lafayette Street).`,
].join(' ');

const base = (over) => ({ outletId: 'la-voce', outlet: 'La Voce', criticName: 'JK Clarke', url: 'https://example.com/col', contentTier: 'complete', publishDate: '2026-03-12', ...over });
const planFor = (showId, fullText, over = {}) => planMultiShowFanout(base({ showId, fullText, ...over }), SHOWS, { joint: true });
const idsOf = (p) => [p.ownSection.showId, ...p.otherSections.map((s) => s.showId)].sort();

test('rating-header column: every show gets its own section, from any show\'s file', () => {
  for (const s of ['bughouse-x', 'silver-manhattan-x', 'burnout-paradise-x']) {
    const p = planFor(s, LAVOCE);
    assert.ok(p, `plan for ${s}`);
    assert.deepEqual(idsOf(p), ['bughouse-x', 'burnout-paradise-x', 'silver-manhattan-x']);
    const own = p.ownSection.sectionText;
    assert.match(own, /stars out of five\)/);
    assert.match(own, / \. Through /, 'own listing line stays with its section');
    for (const other of SHOWS.slice(0, 3).filter((x) => x.id !== s)) {
      assert.doesNotMatch(own, new RegExp(`${other.title} \\*`), `no ${other.title} heading in ${s} section`);
    }
  }
});

test('a joint file an automated check rejected off the whole article is re-planned only when the verdict names the other show', () => {
  const text = [
    'Two new plays at Playwrights Horizons are about recovery: “The Dinosaurs” and “The Monsters.”',
    `The more patient is “The Dinosaurs,” which gathers a support group in a rec room. ${filler('dinosaurs', 7)} By its last scene “The Dinosaurs” has earned its length.`,
    `Sadly, no amount of patience could turn “The Monsters” into my sort of evening. ${filler('monsters', 7)} Fans of the family may feel otherwise.`,
    'The Dinosaurs Through March 1 at Playwrights Horizons, Manhattan. Running time: 90 minutes.',
    'The Monsters Through March 1 at Playwrights Horizons, Manhattan. Running time: 100 minutes.',
  ].join(' ');
  const flagged = {
    wrongShow: true, wrongProduction: true, contentTier: 'invalid',
    wrongShowReason: 'CV-promoted: The scraped content is a review of "The Dinosaurs", not "The Monsters".',
  };
  const p = planFor('the-monsters-x', text, { ...flagged, publishDate: '2026-02-17' });
  assert.ok(p, 'verdict names The Dinosaurs: planned');
  assert.equal(p.strategy, 'joint');
  assert.match(p.ownSection.sectionText, /^Sadly, no amount of patience/);
  // Same flags with a reason that names no other section: left alone.
  assert.equal(planFor('the-monsters-x', text, { ...flagged, wrongShowReason: 'Content is not a review', publishDate: '2026-02-17' }), null);
  // A human verdict is never overridden.
  assert.equal(planFor('the-monsters-x', text, { ...flagged, wrongShowManualClear: true, publishDate: '2026-02-17' }), null);
});

test('apply trims a sibling that already holds the whole article (held), and clears its whole-post verdict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6736-'));
  try {
    for (const s of ['bughouse-x', 'silver-manhattan-x', 'burnout-paradise-x']) fs.mkdirSync(path.join(dir, s));
    const mk = (showId, over = {}) => base({ showId, fullText: LAVOCE, ...over });
    const fp = path.join(dir, 'bughouse-x', 'la-voce--jk.json');
    fs.writeFileSync(fp, JSON.stringify(mk('bughouse-x')));
    const sib = mk('silver-manhattan-x', { wrongProduction: true, wrongProductionReason: 'CV: review of "Bughouse"', contentTier: 'complete' });
    fs.writeFileSync(path.join(dir, 'silver-manhattan-x', 'la-voce--jk.json'), JSON.stringify(sib));
    const res = applyMultiShowFanoutToFile(fp, { shows: SHOWS, reviewTextsDir: dir, joint: true });
    assert.ok(res.applied);
    const byShow = Object.fromEntries(res.children.map((c) => [c.showId, c.action]));
    assert.equal(byShow['silver-manhattan-x'], 'held-trim');
    assert.equal(byShow['burnout-paradise-x'], 'create');
    const read = (s) => JSON.parse(fs.readFileSync(path.join(dir, s, 'la-voce--jk.json'), 'utf8'));
    const silver = read('silver-manhattan-x');
    assert.match(silver.fullText, /^Silver Manhattan \*\*\*\*/);
    assert.doesNotMatch(silver.fullText, /Bughouse \*\*|Burnout Paradise \*\*\*/);
    assert.ok(!silver.wrongProduction, 'whole-post verdict retired');
    assert.ok(silver.multiShowSplitProcessed);
    assert.equal(silver.multiShowWholeArticleText, sib.fullText, 'whole article kept on the trimmed sibling');
    assert.doesNotMatch(read('burnout-paradise-x').fullText, /Silver Manhattan \*\*\*\*/);
    assert.doesNotMatch(read('bughouse-x').fullText, /Silver Manhattan \*\*\*\*/);
    // idempotent: a second pass moves nothing
    const again = applyMultiShowFanoutToFile(path.join(dir, 'silver-manhattan-x', 'la-voce--jk.json'), { shows: SHOWS, reviewTextsDir: dir, joint: true });
    assert.equal(again.applied, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('heldSiblingNeedsTrim: only a whole-article copy no person owns', () => {
  const sec = { sectionText: `Silver Manhattan ${filler('silver', 6)}` };
  const whole = { fullText: `Intro. Bughouse ${filler('b', 5)} ${sec.sectionText} Burnout ${filler('c', 5)}` };
  assert.equal(heldSiblingNeedsTrim(whole, sec), true);
  assert.equal(heldSiblingNeedsTrim({ fullText: sec.sectionText }, sec), false, 'already just the section');
  assert.equal(heldSiblingNeedsTrim({ ...whole, humanReviewScore: 80 }, sec), false);
  assert.equal(heldSiblingNeedsTrim({ ...whole, _locked: true }, sec), false);
  assert.equal(heldSiblingNeedsTrim({ ...whole, wrongProductionOverride: true }, sec), false, 'a person\'s reject blocks');
  assert.equal(heldSiblingNeedsTrim({ ...whole, wrongProductionManualClear: true }, sec), true, 'a manual clear does not');
  assert.equal(heldSiblingNeedsTrim({ ...whole, multiShowSplitProcessed: 'x' }, sec), false);
  assert.equal(heldSiblingNeedsTrim({ fullText: `Unrelated ${filler('z', 12)}` }, sec), false, 'different text');
});

// Interested Bystander December 2025 shape: the caption is followed by a NEWLINE,
// then the "Theater:" label (the older posts ran them together on one line).
const BYSTANDER = [
  'Reviews: Catching Up on Theater',
  `Gotta Dance (c) Bjorn Bolinder \n\nTheater: Gotta Dance \nAt Theatre at St. Jean \n ${filler('dance', 8)}`,
  `Laowang (c) James Leynse \n\n Theater: Laowang \nPrimary Stages at 59E59 Theaters \n ${filler('lear', 8)}`,
  `Oedipus (c) Julieta Cervantes \n\n Broadway: Oedipus \nAt Studio 54 \n ${filler('king', 8)}`,
].join('\n\n');

test('bystander newline-separated caption/label headings are found and isolated', () => {
  assert.equal(findSectionHeadings(BYSTANDER).length, 3);
  const sec = extractShowSection(BYSTANDER, 'Laowang');
  assert.ok(sec);
  assert.match(sec.text, /^Laowang \(c\) James Leynse/);
  assert.doesNotMatch(sec.text, /Oedipus|Gotta Dance/);
  const iso = isolateMultiShowSection('https://www.interestedbystander.com/2025/12/x.html', BYSTANDER, 'Oedipus');
  assert.equal(iso.action, 'isolated');
  assert.doesNotMatch(iso.text, /Laowang/);
});

// New Yorker shape: no lede naming both, no listing; two full reviews back to back.
const NYER = [
  `Appropriately enough, “Marjorie Prime” has been here before. ${filler('prime', 4)} “Marjorie Prime” keeps its quiet. ${filler('prime', 4)} Here “Marjorie Prime” lands softly. ${filler('prime', 3)} At the end, “Marjorie Prime” fades.`,
  `If during “Anna Christie,” the old play, O’Neill wanted fog, he wrote fog. ${filler('fog', 5)} In this revival Williams plays Anna Christie. ${filler('fog', 4)} The staging of “Anna Christie” never settles. ${filler('fog', 3)}`,
].join('\n\n');

test('side-by-side reviews with no shared lede split (New Yorker Marjorie Prime / Anna Christie)', () => {
  for (const own of ['marjorie-prime-x', 'anna-christie-x']) {
    const p = planMultiShowFanout(base({ showId: own, fullText: NYER, publishDate: '2025-12-14' }), SHOWS, { joint: true });
    assert.ok(p, `plan from ${own}`);
    assert.deepEqual(idsOf(p), ['anna-christie-x', 'marjorie-prime-x']);
  }
  // One review that only compares to the other show once or twice stays whole.
  const compare = `Appropriately enough, “Marjorie Prime” has been here before. ${filler('prime', 14)} Unlike “Anna Christie,” it keeps quiet. ${filler('prime', 4)}`;
  assert.equal(planMultiShowFanout(base({ showId: 'marjorie-prime-x', fullText: compare, publishDate: '2025-12-14' }), SHOWS, { joint: true }), null);
});

// Interested Bystander post whose other heading names its venue with a
// lowercase " at " ("Ma-Yi Theater Company at the Public"): the generic
// "Label: Title At Venue" header pattern saw one heading, so the post stayed
// whole under a wrong-production flag (Liberation, BRO-6736).
test('bystander post with a lowercase-venue heading trims the flagged file to its own section', () => {
  const shows = [...SHOWS, { id: 'liberation-x', title: 'Liberation', category: 'broadway', openingDate: '2025-10-28' },
    { id: 'did-you-eat-x', title: 'Did You Eat?', category: 'broadway', openingDate: '2025-10-20' }];
  const post = [
    `Did You Eat? (c) Emma ZordanTheater: Did You Eat? Ma-Yi Theater Company at the Public Theater ${filler('hunger', 8)}`,
    `Liberation (c) Little FangBroadway: Liberation At the James Earl Jones Theatre ${filler('liberation', 8)}`,
  ].join(' ');
  const data = { ...base({ showId: 'liberation-x', url: 'https://www.interestedbystander.com/2025/10/x.html', publishDate: null }),
    contentTier: 'invalid', isRoundupArticle: true, wrongProduction: true, fullText: '', wrongFullText: post };
  const p = planMultiShowFanout(data, shows, { joint: true });
  assert.ok(p, 'planned');
  assert.equal(p.strategy, 'header');
  assert.equal(p.ownSection.showId, 'liberation-x');
  assert.match(p.ownSection.sectionText, /^Liberation \(c\) Little Fang/);
  assert.doesNotMatch(p.ownSection.sectionText, /hunger/);
  // The lowercase-venue heading still resolves to its show (prefix match).
  assert.deepEqual(p.otherSections.map((x) => x.showId), ['did-you-eat-x']);
  assert.match(p.otherSections[0].sectionText, /^Did You Eat\? \(c\)/);
});

test('bystander fallback never drops a generic heading it does not cover', () => {
  const shows = [...SHOWS, { id: 'alpha-x', title: 'Alpha', category: 'broadway', openingDate: '2025-10-20' },
    { id: 'beta-x', title: 'Beta Show', category: 'broadway', openingDate: '2025-10-20' },
    { id: 'gamma-x', title: 'Gamma Show', category: 'broadway', openingDate: '2025-10-20' }];
  const post = [
    `Beta Show (c) A PhotogTheater: Beta Show at the Public ${filler('beta', 8)}`,
    `Broadway: Alpha At the Shubert ${filler('alpha', 8)}`,
    `Gamma Show (c) B PhotogTheater: Gamma Show at the Atlantic ${filler('gamma', 8)}`,
  ].join(' ');
  const data = { ...base({ showId: 'beta-x', url: 'https://www.interestedbystander.com/2025/10/y.html', publishDate: '2025-10-25' }), fullText: post };
  const p = planMultiShowFanout(data, shows, { joint: true });
  if (p) for (const sec of [p.ownSection, ...p.otherSections]) {
    if (sec.showId !== 'alpha-x') assert.doesNotMatch(sec.sectionText, /alpha passage/);
  }
});
