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

test('intro strategy works from either show and with paragraph breaks collapsed', () => {
  const fromCherry = planMultiShowFanout(base({ showId: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN }), SHOWS);
  assert.equal(fromCherry.otherSections[0].showId, 'delirium-off-broadway-2026');
  const flat = planMultiShowFanout(base({ showId: 'delirium-off-broadway-2026', publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN.replace(/\n\n/g, ' ') }), SHOWS);
  assert.equal(flat.otherSections[0].showId, 'the-cherry-orchard-park-avenue-armory-off-broadway-2026');
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
