// Tests for multi-show-review-fanout.js (BRO-4431): one critic article that
// reviews several shows is filed under every show it reviews.
// Run: node --test scripts/lib/multi-show-review-fanout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  planMultiShowFanout,
  applyMultiShowFanoutToFile,
  dedupeProductions,
  candidateShows,
  childWriteDecision,
} = require('./multi-show-review-fanout.js');
const { extractArticleText } = require('./article-extractor.js');

// Synthetic catalogue (real titles, invented prose: review text is copyrighted).
const SHOWS = [
  { id: 'delirium-off-broadway-2026', title: 'Delirium', category: 'off-broadway', openingDate: '2026-09-24' },
  { id: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', title: 'The Cherry Orchard', category: 'off-broadway', openingDate: '2026-09-17' },
  { id: 'the-cherry-orchard-riverside-studios-off-west-end-2026', title: 'The Cherry Orchard', category: 'off-west-end', openingDate: '2026-09-08' },
  { id: 'the-cherry-orchard-west-end-2026', title: 'The Cherry Orchard', category: 'west-end', openingDate: '2026-10-13' },
  { id: 'pre-existing-condition-off-broadway-2026', title: 'Pre-Existing Condition', category: 'off-broadway', openingDate: '2026-09-10' },
  { id: 'the-body-of-mary-a-play-in-three-acts-of-god-off-broadway-2026', title: 'The Body of Mary: A Play in Three Acts (of God)', category: 'off-broadway', openingDate: '2026-09-15' },
  { id: 'the-other-place-off-broadway-2026', title: 'The Other Place', category: 'off-broadway', openingDate: '2026-01-30' },
  { id: 'oedipus-2025', title: 'Oedipus', category: 'broadway', openingDate: '2025-11-13' },
  { id: 'our-class-2023', title: 'Our Class', category: 'off-broadway', openingDate: '2023-11-01' },
  { id: 'the-last-ship-west-end-2026', title: 'The Last Ship', category: 'west-end', openingDate: '2026-09-23' },
  { id: 'sting-west-end-2026', title: 'Sting', category: 'west-end', openingDate: '2026-06-23' },
];

const filler = (topic, n) => Array.from({ length: n }, (_, i) =>
  `The ${topic} sequence number ${i + 1} holds the stage with a patient, deliberate rhythm that the company sustains.`).join(' ');

// New Yorker shape: no caption, no rule; each half opens by quoting its show.
const TWO_SHOW_COLUMN = [
  `Igor Golyak’s “Delirium,” a madcap reinvention of an Ionesco farce, opens on a crushed man under a door. ${filler('Delirium', 4)}`,
  `Golyak founded Arlekin, whose much praised “Our Class” toured widely. In “Delirium” the couple bicker through a war. ${filler('bickering', 4)}`,
  `Simon Stone’s glamorous renovation of Chekhov’s masterpiece “The Cherry Orchard” moves the estate to modern Seoul. ${filler('orchard', 4)}`,
  `The set for “The Cherry Orchard” is spectacular to look at, and the costumes are bright. ${filler('estate', 3)}`,
].join('\n\n');

// Theatrely shape: capsules split by a rule, the second names its show once.
const CAPSULES = `Our senior critic on two plays Off-Broadway right now: I saw Pre-Existing Condition twice at the Connelly. ${filler('recovery', 6)} Pre-Existing Condition remains a brave piece of writing. ————— Don’t be misled by the title: The Body of Mary: A Play In Three Acts (Of God) is a stinging absurdist comedy. ${filler('farce', 6)}`;

const base = (over) => ({ outletId: 'x', outlet: 'X', criticName: 'Critic', url: 'https://example.com/a', contentTier: 'complete', ...over });

test('intro strategy: a column that introduces each show in quotes fans out to both', () => {
  const plan = planMultiShowFanout(base({ showId: 'delirium-off-broadway-2026', publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN }), SHOWS);
  assert.ok(plan, 'expected a fan-out plan');
  assert.equal(plan.strategy, 'intro');
  assert.equal(plan.ownSection.showId, 'delirium-off-broadway-2026');
  assert.deepEqual(plan.otherSections.map((s) => s.showId), ['the-cherry-orchard-park-avenue-armory-off-broadway-2026']);
  // Cut at the start of the introducing sentence, not mid-sentence.
  assert.match(plan.otherSections[0].sectionText, /^Simon Stone’s glamorous renovation/);
  assert.doesNotMatch(plan.ownSection.sectionText, /Cherry Orchard/);
});

test('intro strategy works from either show; a title quoted mid-paragraph never opens a section', () => {
  const fromCherry = planMultiShowFanout(base({ showId: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN }), SHOWS);
  assert.equal(fromCherry.otherSections[0].showId, 'delirium-off-broadway-2026');
  // Paragraph breaks collapsed: the second show's introduction is now
  // mid-paragraph, which is indistinguishable from a comparison. Stay whole.
  const flat = planMultiShowFanout(base({ showId: 'delirium-off-broadway-2026', publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN.replace(/\n\n/g, ' ') }), SHOWS);
  assert.equal(flat, null);
});

test('an opening-party paragraph that reaches another show late is not a section (Sweat / Jitney)', () => {
  const shows = [
    { id: 'sweat-2017', title: 'Sweat', category: 'broadway', openingDate: '2017-03-26' },
    { id: 'jitney-2017', title: 'Jitney', category: 'broadway', openingDate: '2017-01-19' },
  ];
  const text = `Lynn Nottage’s “Sweat” is high-wattage drama about a Reading bar. ${filler('bar', 8)} “Sweat” deserves its audience.\n\nAt Sunday’s opening party at the brasserie, stars mingled with an array of well-wishers, producers, family and friends, and Stephen McKinley Henderson, part of the original “Jitney” ensemble, was hobnobbing near the bar with the cast of the recent “Jitney” production. ${filler('party', 6)}`;
  assert.equal(planMultiShowFanout(base({ showId: 'sweat-2017', publishDate: '2017-03-27', fullText: text }), shows), null);
});

test('a single review that returns to its show after a comparison is not split (Crucible vs A View From the Bridge)', () => {
  const shows = [
    { id: 'the-crucible-2016', title: 'The Crucible', category: 'broadway', openingDate: '2016-03-31' },
    { id: 'a-view-from-the-bridge-2015', title: 'A View From the Bridge', category: 'broadway', openingDate: '2015-11-12' },
  ];
  const text = `Ivo van Hove stages “The Crucible” as a classroom nightmare. ${filler('classroom', 6)}\n\n“A View From the Bridge,” his previous Arthur Miller revival, stripped the play bare in the same way. ${filler('comparison', 5)} This “Crucible” is louder and less sure of itself. ${filler('witch trial', 4)}`;
  assert.equal(planMultiShowFanout(base({ showId: 'the-crucible-2016', publishDate: '2016-04-01', fullText: text }), shows), null);
});

test('an old production named in passing ("Our Class", 2023) never becomes a section', () => {
  const plan = planMultiShowFanout(base({ showId: 'delirium-off-broadway-2026', publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN }), SHOWS);
  const ids = [plan.ownSection, ...plan.otherSections].map((s) => s.showId);
  assert.ok(!ids.includes('our-class-2023'));
});

test('same-title productions resolve to the file\'s own market, closest opening', () => {
  const own = SHOWS.find((s) => s.id === 'delirium-off-broadway-2026');
  const cands = dedupeProductions(candidateShows(SHOWS, own, '2026-09-29'), own.id, '2026-09-29');
  const cherry = cands.filter((s) => s.title === 'The Cherry Orchard');
  assert.deepEqual(cherry.map((s) => s.id), ['the-cherry-orchard-park-avenue-armory-off-broadway-2026']);
});

test('separator capsules: the second capsule may name its show once', () => {
  const plan = planMultiShowFanout(base({ showId: 'pre-existing-condition-off-broadway-2026', publishDate: '2026-09-25', fullText: CAPSULES }), SHOWS);
  assert.ok(plan);
  assert.equal(plan.otherSections[0].showId, 'the-body-of-mary-a-play-in-three-acts-of-god-off-broadway-2026');
  assert.match(plan.otherSections[0].sectionText, /^Don’t be misled/);
  assert.doesNotMatch(plan.ownSection.sectionText, /—{3,}/);
});

test('caption strategy (Vulture double review) still delegates to multi-show-splitter', () => {
  const shows = [
    { id: 'how-shakespeare-saved-my-life-off-broadway-2026', title: 'How Shakespeare Saved My Life', category: 'off-broadway', openingDate: '2026-09-27' },
    { id: 'arias-with-a-twist-off-broadway-2026', title: 'Arias with a Twist', category: 'off-broadway', openingDate: '2026-09-23' },
  ];
  const text = `Joey Arias in Arias With a Twist, at the HERE Arts Center.\n Photo: Someone\n ${filler('cabaret', 8)}\n\nJacob Ming-Trent in How Shakespeare Saved My Life, at the Public Theater.\n Photo: Someone\n ${filler('solo show', 10)}`;
  const plan = planMultiShowFanout(base({ showId: 'how-shakespeare-saved-my-life-off-broadway-2026', publishDate: '2026-09-28', fullText: text }), shows);
  assert.ok(plan);
  assert.equal(plan.strategy, 'caption');
  assert.equal(plan.otherSections[0].showId, 'arias-with-a-twist-off-broadway-2026');
});

test('a single review with one quoted comparison is not split', () => {
  const text = `The highlight of the fall season was Robert Icke’s gripping “Oedipus,” which reimagined Sophocles. ${filler('comparison', 3)} Mr. Zeldin’s “The Other Place” would hardly be recognizable to Sophocles. ${filler('kitchen', 10)} “The Other Place,” like its enigmatic title, keeps its secrets.`;
  assert.equal(planMultiShowFanout(base({ showId: 'the-other-place-off-broadway-2026', publishDate: '2026-02-12', fullText: text }), SHOWS), null);
});

test('a possessive ("Sting’s") is not a quoted title', () => {
  const text = `The Last Ship docks at Drury Lane with a big heart. ${filler('shipyard', 6)} Read the full review: Sting’s shipyard musical is deeply heartfelt. ${filler('chorus', 6)}`;
  assert.equal(planMultiShowFanout(base({ showId: 'the-last-ship-west-end-2026', publishDate: '2026-09-25', fullText: text }), SHOWS), null);
});

test('guards: truncated text, aggregator round-up, wrong production, old article', () => {
  const ok = base({ showId: 'delirium-off-broadway-2026', publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN });
  assert.ok(planMultiShowFanout(ok, SHOWS));
  assert.equal(planMultiShowFanout({ ...ok, contentTier: 'truncated' }, SHOWS), null);
  assert.equal(planMultiShowFanout({ ...ok, isRoundupArticle: true }, SHOWS), null);
  assert.equal(planMultiShowFanout({ ...ok, wrongProduction: true }, SHOWS), null);
  assert.equal(planMultiShowFanout({ ...ok, publishDate: '2024-10-19' }, SHOWS), null);
  assert.equal(planMultiShowFanout({ ...ok, multiShowSplitProcessed: '2026-09-30' }, SHOWS), null);
});

test('childWriteDecision: create, fill a textless stub for the same URL, else skip', () => {
  const parent = { url: 'https://example.com/a?x=1' };
  assert.equal(childWriteDecision(null, parent), 'create');
  assert.equal(childWriteDecision({ url: 'https://example.com/a', fullText: '' }, parent), 'fill');
  assert.equal(childWriteDecision({ url: 'https://example.com/other', fullText: '' }, parent), 'skip');
  assert.equal(childWriteDecision({ url: 'https://example.com/a', fullText: 'x'.repeat(400) }, parent), 'skip');
});

test('applyMultiShowFanoutToFile writes the sibling, trims the parent, and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
  const own = path.join(dir, 'delirium-off-broadway-2026');
  fs.mkdirSync(own);
  const file = path.join(own, 'newyorker--emily-nussbaum.json');
  fs.writeFileSync(file, JSON.stringify(base({
    showId: 'delirium-off-broadway-2026', outletId: 'newyorker', criticName: 'Emily Nussbaum',
    publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN, llmScore: { score: 70 },
  })));
  const r1 = applyMultiShowFanoutToFile(file, { shows: SHOWS, reviewTextsDir: dir });
  assert.equal(r1.applied, true);
  assert.deepEqual(r1.children.map((c) => [c.showId, c.action]), [['the-cherry-orchard-park-avenue-armory-off-broadway-2026', 'create']]);
  const child = JSON.parse(fs.readFileSync(path.join(dir, 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', 'newyorker--emily-nussbaum.json'), 'utf8'));
  assert.equal(child.showId, 'the-cherry-orchard-park-avenue-armory-off-broadway-2026');
  assert.equal(child.criticName, 'Emily Nussbaum');
  assert.equal(child.multiShowSplitChild, true);
  assert.equal(child.needsRescore, true);
  const parent = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parent.multiShowSplitParent, true);
  assert.equal(parent.llmScore, undefined, 'stale whole-article score cleared');
  assert.equal(parent.needsRescore, true);
  assert.ok(parent.fullText.length < TWO_SHOW_COLUMN.length);
  // Second pass: parent already processed, child already exists.
  const r2 = applyMultiShowFanoutToFile(file, { shows: SHOWS, reviewTextsDir: dir });
  assert.equal(r2.applied, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applyMultiShowFanoutToFile fills a textless discovery stub for the same article', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
  fs.mkdirSync(path.join(dir, 'delirium-off-broadway-2026'));
  const childDir = path.join(dir, 'the-cherry-orchard-park-avenue-armory-off-broadway-2026');
  fs.mkdirSync(childDir);
  const url = 'https://www.newyorker.com/magazine/2026/10/05/gut-renos-of-ionesco-and-chekhov';
  fs.writeFileSync(path.join(childDir, 'newyorker--emily-nussbaum.json'), JSON.stringify({ showId: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', url, source: 'outlet-listing-poller', contentTier: 'stub' }));
  const file = path.join(dir, 'delirium-off-broadway-2026', 'newyorker--emily-nussbaum.json');
  fs.writeFileSync(file, JSON.stringify(base({ showId: 'delirium-off-broadway-2026', url, publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN })));
  const r = applyMultiShowFanoutToFile(file, { shows: SHOWS, reviewTextsDir: dir });
  assert.equal(r.children[0].action, 'fill');
  const filled = JSON.parse(fs.readFileSync(path.join(childDir, 'newyorker--emily-nussbaum.json'), 'utf8'));
  assert.equal(filled.contentTier, 'complete');
  assert.equal(filled.source, 'outlet-listing-poller', 'keeps the discovery source');
  assert.match(filled.fullText, /Cherry Orchard/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fan-out honours the child show blocklist and never trims a parent when no sibling was written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
  const url = 'https://www.newyorker.com/magazine/2026/10/05/gut-renos';
  const cherry = 'the-cherry-orchard-park-avenue-armory-off-broadway-2026';
  fs.mkdirSync(path.join(dir, 'delirium-off-broadway-2026'));
  fs.mkdirSync(path.join(dir, cherry));
  fs.writeFileSync(path.join(dir, cherry, '_blocklist.json'), JSON.stringify({ urls: [{ url, reason: 'operator deleted' }] }));
  const file = path.join(dir, 'delirium-off-broadway-2026', 'newyorker--emily-nussbaum.json');
  fs.writeFileSync(file, JSON.stringify(base({ showId: 'delirium-off-broadway-2026', url, publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN, llmScore: { score: 70 } })));
  const r = applyMultiShowFanoutToFile(file, { shows: SHOWS, reviewTextsDir: dir });
  assert.equal(r.children[0].action, 'blocked');
  assert.equal(r.parentRewritten, false);
  assert.equal(fs.existsSync(path.join(dir, cherry, 'newyorker--emily-nussbaum.json')), false);
  const parent = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parent.fullText, TWO_SHOW_COLUMN, 'parent kept whole');
  assert.equal(parent.llmScore.score, 70);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a processed parent whose full article was re-collected is trimmed again', () => {
  const trimmed = planMultiShowFanout(base({ showId: 'delirium-off-broadway-2026', publishDate: '2026-09-29', fullText: 'x'.repeat(900), multiShowSplitProcessed: '2026-09-30', multiShowSplitParent: true, multiShowSplitTextLength: 900 }), SHOWS);
  assert.equal(trimmed, null, 'unchanged trimmed text is left alone');
  const recollected = planMultiShowFanout(base({ showId: 'delirium-off-broadway-2026', publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN, multiShowSplitProcessed: '2026-09-30', multiShowSplitParent: true, multiShowSplitTextLength: 900 }), SHOWS);
  assert.ok(recollected && recollected.otherSections.length === 1);
});

test('split siblings sharing a URL are not cross-production copies; unrelated copies still are', () => {
  const { multiShowSplitGroup, isMultiShowSplitSibling } = require('./review-guards.js');
  const parent = { showId: 'delirium-off-broadway-2026', multiShowSplitParent: true };
  const child = { showId: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', multiShowSplitChild: true, multiShowSplitParentShowId: 'delirium-off-broadway-2026' };
  const other = { showId: 'the-cherry-orchard-1977' };
  assert.ok(isMultiShowSplitSibling(multiShowSplitGroup(parent), multiShowSplitGroup(child)));
  assert.equal(isMultiShowSplitSibling(multiShowSplitGroup(child), multiShowSplitGroup(other)), false);
  assert.equal(isMultiShowSplitSibling(null, null), false);
  // Every cross-show URL judge uses it.
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const f of ['rebuild-all-reviews.js', 'cleanup-dedup-comprehensive.js']) {
    assert.match(fs.readFileSync(path.join(root, f), 'utf8'), /isMultiShowSplitSibling\(/, f);
  }
  assert.match(fs.readFileSync(path.join(root, 'gather-reviews.js'), 'utf8'), /multiShowSplitChildShowIds\.includes\(showId\)/);
  assert.match(fs.readFileSync(path.join(root, 'audit-cross-show-url-collisions.js'), 'utf8'), /data\.multiShowSplitChild === true/);
});

test('New Yorker extractor reads every body block (second show was dropped before)', () => {
  const block = (t) => `<div class="body__inner-container"><p class="x">${t}</p></div>`;
  const first = `Igor Golyak’s “Delirium” opens on a crushed man. ${filler('Delirium', 4)}`;
  const second = `Simon Stone’s “The Cherry Orchard” moves to Seoul. ${filler('orchard', 4)}`;
  const html = `<html><body><article>${block(first)}<div class="ad"><div></div></div>${block(second)}<aside>more</aside></article></body></html>`;
  const text = extractArticleText(html, 'www.newyorker.com');
  assert.match(text, /Delirium/);
  assert.match(text, /Cherry Orchard/);
});

test('every review-text writer calls the fan-out (collector, URL ingest, backfill)', () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  for (const f of ['collect-review-texts.js', 'ingest-review-from-url.js', 'split-multi-show-roundups.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.match(src, /applyMultiShowFanoutToFile\(/, `${f} must call applyMultiShowFanoutToFile`);
  }
});

// ---------------------------------------------------------------------------
// Paywalled tier-1/2 stubs get the rating we can see (BRO-4431 part 2)
// ---------------------------------------------------------------------------
const { aggregatorStarsPatch, pageStarPatch, relayBlockReason } = require('./paywall-stub-score.js');
const { getBestScore } = require('./rebuild-helpers.js');
const { isIncludableForRebuild } = require('./review-guards.js');

const timesStub = () => ({
  showId: 'cleansed-off-west-end-2026', outletId: 'times-uk', outlet: 'The Times', criticName: 'Clive Davis',
  url: null, publishDate: '2026-07-31', contentTier: 'stub', fullText: null, _showCategory: 'off-west-end',
});

test('relayed TR stars land on a textless T1 stub and the scorer uses them', () => {
  const stub = timesStub();
  const patch = aggregatorStarsPatch(stub, { stars: 1, source: 'theatre-reviews' });
  assert.equal(patch.aggregatorStars, '1/5');
  const scored = { ...stub, ...patch };
  assert.ok(isIncludableForRebuild(scored));
  const best = getBestScore(scored, { stats: {}, flagForHumanReview: () => {} });
  assert.equal(best.source, 'aggregatorStars-relay');
  assert.equal(best.score, 20);
  // Without the relay the stub has no score and never reaches the site.
  assert.equal(getBestScore(stub, { stats: {}, flagForHumanReview: () => {} }), null);
});

test('relay is refused for full texts, scored/cleared files, exclusions and non-star outlets', () => {
  const r = (over) => relayBlockReason({ ...timesStub(), ...over }, 3);
  assert.equal(r({}), null);
  assert.equal(r({ fullText: 'x'.repeat(2000) }), 'has-body');
  assert.equal(r({ originalScore: '4/5 stars' }), 'already-scored');
  assert.equal(r({ originalScoreCleared: true }), 'already-scored');
  assert.equal(r({ wrongProduction: true }), 'excluded');
  assert.equal(r({ outletId: 'wsj' }), 'not-major-star-outlet');
  assert.equal(r({ outletId: 'thestage' }), 'not-major-star-outlet', 'Stage has its own walled-page path');
  assert.equal(relayBlockReason(timesStub(), null), 'no-stars');
  // A 113-word paywall teaser is still a stub for this purpose.
  assert.equal(r({ fullText: 'teaser '.repeat(113), contentTier: 'truncated' }), null);
});

test('pageStarPatch reads a walled page\'s own schema.org review rating, in-window only', () => {
  const show = { id: 'cleansed-off-west-end-2026', title: 'Cleansed', openingDate: '2026-07-30', closingDate: '2026-09-20' };
  const html = '<script type="application/ld+json">{"@type":"Review","reviewRating":{"@type":"Rating","ratingValue":"3"}}</script><h1>Cleansed review</h1><p>Subscribe to read</p>';
  const patch = pageStarPatch(timesStub(), html, { show });
  assert.equal(patch.originalScore, '3/5 stars');
  assert.equal(patch.originalScoreNormalized, 60);
  assert.equal(patch.scoreExtractedFrom, 'paywalled-page-structured-data');
  // Stale article filed under a later production: stays unscored.
  assert.equal(pageStarPatch({ ...timesStub(), publishDate: '2019-05-01' }, html, { show }), null);
  // A bare ratingValue with no Review declaration is not trusted.
  assert.equal(pageStarPatch(timesStub(), '<div>"ratingValue": 4</div>', { show }), null);
  // Glyphs in teaser text are not structured data.
  assert.equal(pageStarPatch(timesStub(), '<p>★★★★☆</p>', { show }), null);
});

const { extractReviews: extractTR } = require('../scrape-theatre-reviews.js');
const { pickTheatreReviewsRoundup } = require('./theatre-reviews-discovery.js');

test('TR parser keeps unlinked paywalled rows ("Times’", "The i’s"), drops guessed and unrated stars', () => {
  const html = `<div class="entry-content">
    <p>Intro text about the play.</p>
    <p>3 stars ⭑⭑⭑</p>
    <p>The Financial Times’ Sarah Hemming pointed out: ‘It is still an incredibly tough watch for anyone.’</p>
    <p><a href="https://www.theguardian.com/stage/x">The Guardian</a>’s Arifa Akbar said: ‘an extraordinary evening at the theatre.’</p>
    <p>1 star ⭑</p>
    <p>The Times’ Clive Davis had no truck with it: ‘there is no depth or hinterland to any of it.’</p>
    <p>(1 star assumed) The i’s Fiona Mountford regretted her decision: ‘Kane enthusiasts will find much to admire.’</p>
    <p>0 stars –</p>
    <p>The Mail‘s Patrick Marmion seemed to have some appreciation of the play: ‘it often feels relentless and random.’</p>
  </div>`;
  const rows = extractTR(html, 'cleansed-off-west-end-2026');
  const by = Object.fromEntries(rows.map((r) => [r.outletId, r]));
  assert.equal(by.financialtimes.critic, 'Sarah Hemming');
  assert.equal(by.financialtimes.stars, 3);
  assert.equal(by.financialtimes.url, '');
  assert.equal(by.guardian.stars, 3);
  assert.equal(by['times-uk'].critic, 'Clive Davis');
  assert.equal(by['times-uk'].stars, 1);
  assert.equal(by['i-paper'].critic, 'Fiona Mountford');
  assert.equal(by['i-paper'].stars, null, 'TR guessed this rating');
  assert.equal(by['daily-mail'].stars, null, '"0 stars" tier = critic published no rating');
});

test('TR round-up discovery uses the WP search API result, not just the homepage', () => {
  const posts = [
    { link: 'https://theatre.reviews/review/theatre-review-cleansed/', slug: 'theatre-review-cleansed', title: { rendered: 'Theatre review: Cleansed' } },
    { link: 'https://theatre.reviews/reviews-roundup/cleansed-almeida-reviews/', slug: 'cleansed-almeida-reviews', title: { rendered: 'Cleansed &#8211; Almeida reviews' } },
  ];
  assert.equal(pickTheatreReviewsRoundup(posts, 'Cleansed'), 'https://theatre.reviews/reviews-roundup/cleansed-almeida-reviews/');
  assert.equal(pickTheatreReviewsRoundup(posts, 'Golden Boy'), null);
  assert.equal(pickTheatreReviewsRoundup(null, 'Cleansed'), null);
  const src = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /pickTheatreReviewsRoundup\(/, 'gather-reviews must use the API discovery');
});

// ---------------------------------------------------------------------------
// Reader submissions whose page can't be read are retried, not dropped (part 3)
// ---------------------------------------------------------------------------
const { buildRetryStubFields, isQueuedRetryStub } = require('./submission-retry-stub.js');
const { checkSubmissionLanded } = require('./submission-landing.js');

test('a failed submission becomes a queued-retry stub that counts as pending, not a dead end', () => {
  const fields = buildRetryStubFields('fetch failed: All scraping methods failed', { publishDate: '2026-09-19' });
  assert.equal(fields.contentTier, 'stub');
  assert.equal(fields.submissionRetryQueued, true);
  assert.ok(isQueuedRetryStub(fields));
  // Once any recovery path fills the text it is no longer a queued stub.
  assert.equal(isQueuedRetryStub({ ...fields, fullText: 'x'.repeat(500) }), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sub-'));
  const showId = 'golden-boy-off-west-end-2026';
  const url = 'https://www.thetimes.com/culture/theatre-dance/article/golden-boy-review-8dnqk7c6l';
  fs.mkdirSync(path.join(dir, showId));
  fs.writeFileSync(path.join(dir, showId, 'times-uk--unknown.json'), JSON.stringify({ showId, outletId: 'times-uk', url, ...fields }));
  const res = checkSubmissionLanded({ showId, url, reviews: [], reviewTextsDir: dir, show: { id: showId, title: 'Golden Boy', openingDate: '2026-09-15' } });
  assert.equal(res.landed, false);
  assert.equal(res.pendingScore, true, 'goes to the awaiting-score sweep (close when live, escalate after 36h)');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Outlet-listing ground truth (part 4)
// ---------------------------------------------------------------------------
const gt = require('./outlet-ground-truth.js');

test('ground truth: a TheaterMania review post is matched to its show and flagged when we lack it', () => {
  const show = { id: 'beyond-the-stardust-off-broadway-2026', title: 'Beyond the Stardust', category: 'off-broadway', openingDate: '2026-09-10' };
  const tm = gt.WP_SEARCH_SOURCES.find((s) => s.id === 'theatermania');
  const posts = [
    { link: 'https://www.theatermania.com/news/review-beyond-the-stardust-an-afrofuturist-dance-party_1854359/', date: '2026-09-18T12:43:42', title: { rendered: 'Review: Beyond the Stardust Is an Afrofuturist Dance Party' } },
    { link: 'https://www.theatermania.com/news/the-flea-announces-cast-for-immersive-musical-beyond-the-stardust_1845492/', date: '2026-07-13T11:00:45', title: { rendered: 'The Flea Announces Cast' } },
    { link: 'https://www.theatermania.com/news/review-something-else_1/', date: '2026-09-18', title: { rendered: 'Review: Something Else' } },
  ];
  const rows = gt.reviewPostsForShow(posts, show, tm);
  assert.deepEqual(rows.map((r) => r.url), ['https://www.theatermania.com/news/review-beyond-the-stardust-an-afrofuturist-dance-party_1854359/']);
  assert.equal(gt.hasReviewFor([], { url: rows[0].url }), false);
  assert.equal(gt.hasReviewFor([{ outletId: 'theatermania', url: 'https://theatermania.com/news/review-beyond-the-stardust-an-afrofuturist-dance-party_1854359' }], { url: rows[0].url }), true, 'www/trailing slash differences are the same review');
});

test('ground truth: NYT sitemap rows, TR rows without a link, eligibility window', () => {
  const html = '<a href="https://www.nytimes.com/2026/09/30/theater/degenerates-review-the-longing.html">x</a><a href="https://www.nytimes.com/2026/09/30/theater/broadway-news-roundup.html">y</a>';
  const rows = gt.parseNytSitemapDay(html);
  assert.equal(rows.length, 1);
  const shows = [{ id: 'degenerates-off-broadway-2026', title: 'Degenerates', category: 'off-broadway', openingDate: '2026-09-28' }];
  assert.deepEqual(gt.nytShowsForSlug(rows[0].slug, shows).map((s) => s.id), ['degenerates-off-broadway-2026']);
  // Paywalled TR row: matched by outlet + critic, including a URL-less file.
  const files = [{ outletId: 'times-uk', criticName: 'Ann Treneman' }];
  assert.equal(gt.hasReviewFor(files, { outletId: 'times-uk', critic: 'Clive Davis' }), false);
  assert.equal(gt.hasReviewFor([...files, { outletId: 'times-uk', criticName: 'Clive Davis', url: null }], { outletId: 'times-uk', critic: 'Clive Davis' }), true);
  const now = Date.parse('2026-09-30T12:00:00Z');
  const all = [...shows, { id: 'old', title: 'Old', category: 'broadway', openingDate: '2026-01-01' }, { id: 'reg', title: 'Reg', category: 'regional', openingDate: '2026-09-29' }];
  assert.deepEqual(gt.eligibleShows(all, { now, days: 21 }).map((s) => s.id), ['degenerates-off-broadway-2026']);
});

test('ground truth audit is scheduled (audit-aggregator-gap.yml) with ingest + alert', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/audit-aggregator-gap.yml', import.meta.url), 'utf8');
  assert.match(wf, /node scripts\/audit-outlet-ground-truth\.js [^\n]*--ingest[^\n]*--alert/);
});

test('process-review-submission retries once, then falls back to the retry stub', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/process-review-submission.yml', import.meta.url), 'utf8');
  assert.match(wf, /sleep 60\s*\n\s*node scripts\/ingest-review-from-url\.js [^\n]*--stub-on-failure/);
  const ingest = fs.readFileSync(new URL('../ingest-review-from-url.js', import.meta.url), 'utf8');
  assert.match(ingest, /hasFlag\('stub-on-failure'\)/);
  assert.match(ingest, /writeRetryStubAndExit\(fetchFailure\)/);
});
