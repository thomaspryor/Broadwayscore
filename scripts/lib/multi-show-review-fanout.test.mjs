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

test('ALL-CAPS capsule headings split a flattened round-up; untracked capsules are cut out', () => {
  const shows = [
    { id: 'arias-with-a-twist-off-broadway-2026', title: 'Arias with a Twist', category: 'off-broadway', openingDate: '2026-09-23' },
    { id: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', title: 'The Cherry Orchard', category: 'off-broadway', openingDate: '2026-09-17' },
  ];
  const text = `Our critic reviews a few shows Off-Broadway right now: ARIAS WITH A TWIST ${filler('puppet', 8)} DON JUAN IN SOHO ${filler('rake', 8)} THE CHERRY ORCHARD ${filler('estate', 8)}`;
  const plan = planMultiShowFanout(base({ showId: 'arias-with-a-twist-off-broadway-2026', publishDate: '2026-09-26', fullText: text }), shows);
  assert.ok(plan);
  assert.doesNotMatch(plan.ownSection.sectionText, /DON JUAN|rake/, 'untracked capsule cut out');
  assert.match(plan.otherSections[0].sectionText, /^THE CHERRY ORCHARD/);
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

test('caption strategy (clean captioned halves) still delegates to multi-show-splitter', () => {
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
  assert.equal(childWriteDecision({ url: 'https://example.com/a', fullText: 'x'.repeat(400) }, parent), 'held', 'same article already filed there');
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

test('re-ingesting the article under a missing sibling show keeps only that section', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-'));
  const url = 'https://www.newyorker.com/magazine/2026/10/05/gut-renos';
  const cherry = 'the-cherry-orchard-park-avenue-armory-off-broadway-2026';
  fs.mkdirSync(path.join(dir, 'delirium-off-broadway-2026'));
  fs.mkdirSync(path.join(dir, cherry));
  // Delirium already holds its (trimmed) section from an earlier split.
  fs.writeFileSync(path.join(dir, 'delirium-off-broadway-2026', 'newyorker--emily-nussbaum.json'), JSON.stringify(base({ showId: 'delirium-off-broadway-2026', url, fullText: 'Delirium section '.repeat(80), multiShowSplitParent: true, multiShowSplitProcessed: 'x' })));
  const file = path.join(dir, cherry, 'newyorker--emily-nussbaum.json');
  fs.writeFileSync(file, JSON.stringify(base({ showId: cherry, url, publishDate: '2026-09-29', fullText: TWO_SHOW_COLUMN })));
  const r = applyMultiShowFanoutToFile(file, { shows: SHOWS, reviewTextsDir: dir });
  assert.equal(r.children[0].action, 'held');
  assert.equal(r.parentRewritten, true);
  assert.doesNotMatch(JSON.parse(fs.readFileSync(file, 'utf8')).fullText, /Delirium/);
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
  const url = 'https://www.newyorker.com/magazine/2026/10/05/gut-renos-of-ionesco-and-chekhov';
  const parent = { showId: 'delirium-off-broadway-2026', url, multiShowSplitParent: true };
  const child = { showId: 'the-cherry-orchard-park-avenue-armory-off-broadway-2026', url: url + '?utm=x', multiShowSplitChild: true, multiShowSplitParentShowId: 'delirium-off-broadway-2026' };
  const other = { showId: 'the-cherry-orchard-1977', url };
  // A section re-ingested later is also a sibling (both split-flagged, same article).
  const later = { showId: 'x', url: 'http://newyorker.com/magazine/2026/10/05/gut-renos-of-ionesco-and-chekhov/', multiShowSplitParent: true };
  assert.ok(isMultiShowSplitSibling(multiShowSplitGroup(later), multiShowSplitGroup(parent)));
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

test('review-texts push ownership gate keeps split siblings, still drops an unrelated cross-show copy', () => {
  const { execFileSync } = require('node:child_process');
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'validate-added-review-ownership.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owngate-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const w = (rel, obj) => { fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj)); };
  const url = 'https://www.vulture.com/article/reviews-how-shakespeare-saved-my-life-arias-with-a-twist.html';
  const text = 'x'.repeat(3000);
  w('how-shakespeare-saved-my-life-off-broadway-2026/vulture--sara-holdren.json', { showId: 'how-shakespeare-saved-my-life-off-broadway-2026', outletId: 'vulture', criticName: 'Sara Holdren', url, fullText: text });
  w('other-show-2026/placeholder.json', { showId: 'other-show-2026', outletId: 'x', url: 'https://example.com/y', fullText: text });
  git('add', '-A'); git('commit', '-qm', 'base');
  // The split: parent marked, child added — plus an unrelated copy of the URL.
  w('how-shakespeare-saved-my-life-off-broadway-2026/vulture--sara-holdren.json', { showId: 'how-shakespeare-saved-my-life-off-broadway-2026', outletId: 'vulture', criticName: 'Sara Holdren', url, fullText: text, multiShowSplitParent: true });
  w('arias-with-a-twist-off-broadway-2026/vulture--sara-holdren.json', { showId: 'arias-with-a-twist-off-broadway-2026', outletId: 'vulture', criticName: 'Sara Holdren', url, fullText: text, multiShowSplitChild: true, multiShowSplitParentShowId: 'how-shakespeare-saved-my-life-off-broadway-2026' });
  git('add', '-A'); git('commit', '-qm', 'split');
  execFileSync('node', [script, `--base=${git('rev-parse', 'HEAD~1').toString().trim()}`], { cwd: dir, stdio: 'pipe' });
  assert.ok(fs.existsSync(path.join(dir, 'arias-with-a-twist-off-broadway-2026/vulture--sara-holdren.json')), 'split sibling kept');
  // A later, unrelated copy of the URL under a third show is still a leak.
  w('unrelated-show-2026/vulture--sara-holdren.json', { showId: 'unrelated-show-2026', outletId: 'vulture', criticName: 'Sara Holdren', url, fullText: text });
  git('add', '-A'); git('commit', '-qm', 'leak');
  execFileSync('node', [script, `--base=${git('rev-parse', 'HEAD~1').toString().trim()}`], { cwd: dir, stdio: 'pipe' });
  assert.equal(fs.existsSync(path.join(dir, 'unrelated-show-2026/vulture--sara-holdren.json')), false, 'unrelated cross-show copy still dropped');
  assert.ok(fs.existsSync(path.join(dir, 'arias-with-a-twist-off-broadway-2026/vulture--sara-holdren.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writer Guard I lets a split article be re-created under a section show it names, not under others', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const { _resetUrlOwnershipIndex } = require('./url-ownership.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardi-'));
  const url = 'https://www.vulture.com/article/reviews-how-shakespeare-saved-my-life-arias-with-a-twist.html';
  fs.mkdirSync(path.join(dir, 'how-shakespeare-saved-my-life-off-broadway-2026'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'how-shakespeare-saved-my-life-off-broadway-2026', 'vulture--sara-holdren.json'), JSON.stringify({
    showId: 'how-shakespeare-saved-my-life-off-broadway-2026', outletId: 'vulture', criticName: 'Sara Holdren', url,
    fullText: 'x'.repeat(3000), multiShowSplitParent: true, multiShowSplitChildShowIds: ['arias-with-a-twist-off-broadway-2026'],
  }));
  _resetUrlOwnershipIndex();
  const ok = createOrMergeReviewFile('arias-with-a-twist-off-broadway-2026', { outletId: 'vulture', outlet: 'Vulture', criticName: 'Sara Holdren', url, source: 'submit-review-form', fields: {} }, { reviewTextsDir: dir });
  assert.equal(ok.action, 'new', JSON.stringify(ok));
  _resetUrlOwnershipIndex();
  const refused = createOrMergeReviewFile('delirium-off-broadway-2026', { outletId: 'vulture', outlet: 'Vulture', criticName: 'Sara Holdren', url, source: 'submit-review-form', fields: {} }, { reviewTextsDir: dir });
  assert.equal(refused.action, 'skipped');
  assert.match(refused.reason, /cross-show-url-owned/);
  _resetUrlOwnershipIndex();
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

test('session-authored pending-fix plans can ingest a URL, re-split an article and re-read TR', () => {
  const exec = fs.readFileSync(new URL('../execute-approved-fix.js', import.meta.url), 'utf8');
  for (const s of ['ingest-review-from-url.js', 'split-multi-show-roundups.js', 'scrape-theatre-reviews.js']) {
    assert.match(exec, new RegExp(`'${s.replace(/\./g, '\\.')}'`), s);
  }
  const wf = fs.readFileSync(new URL('../../.github/workflows/execute-approved-fix.yml', import.meta.url), 'utf8');
  assert.match(wf, /BRIGHTDATA_TOKEN: \$\{\{ secrets\.BRIGHTDATA_TOKEN \}\}/);
});

test('process-review-submission retries once, then falls back to the retry stub', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/process-review-submission.yml', import.meta.url), 'utf8');
  assert.match(wf, /sleep 60\s*\n\s*node scripts\/ingest-review-from-url\.js [^\n]*--stub-on-failure/);
  const ingest = fs.readFileSync(new URL('../ingest-review-from-url.js', import.meta.url), 'utf8');
  assert.match(ingest, /hasFlag\('stub-on-failure'\)/);
  assert.match(ingest, /writeRetryStubAndExit\(fetchFailure\)/);
});

// ── Stuck submissions 908 / 913 (Golden Boy) ──

const GB = 'golden-boy-off-west-end-2026';
const DM_URL = 'https://newspaper.dailymail.com/edition/showbiz/theatre/472292/nicely-ripped-josh-swaps-the-crown-for-swing-at-boxing';
const DM_OPEN = 'JOSH O’Connor has an unusual conflict of interest in Clifford Odets’ 1937 drama Golden Boy: play the violin or become a prize boxer. ';
const DM_MORE = 'Rupert Goold stages the fight scenes with a crunching physicality that makes the ring feel dangerous, and the Almeida is packed tight around it. '
  + 'The supporting cast are sharp throughout, and the design keeps the gym smells almost tangible from the stalls, bell to bell. ';

test('a longer copy of the same article replaces a truncated body on an explicit ingest (issue 908)', () => {
  const { isSameArticleBodyUpgrade } = require('./stale-merge-check.js');
  const stored = { fullText: DM_OPEN + DM_MORE.slice(0, 180) + '\n\nAssociated Newspapers Limited', contentTier: 'truncated' };
  const fuller = DM_OPEN + DM_MORE.repeat(12);
  assert.equal(isSameArticleBodyUpgrade(stored, fuller), true);
  assert.equal(isSameArticleBodyUpgrade({ ...stored, contentTier: 'complete' }, fuller), false, 'a complete body is never swapped');
  assert.equal(isSameArticleBodyUpgrade(stored, 'An entirely different page about ticket offers. '.repeat(30)), false, 'different article');
  assert.equal(isSameArticleBodyUpgrade(stored, DM_OPEN + DM_MORE.slice(0, 200)), false, 'not meaningfully longer');
  assert.equal(isSameArticleBodyUpgrade({ ...stored, manualContentTier: 'truncated' }, fuller), false, 'manual tier lock wins');

  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4431-908-'));
  fs.mkdirSync(path.join(dir, GB));
  const file = path.join(dir, GB, 'daily-mail--patrick-marmion.json');
  fs.writeFileSync(file, JSON.stringify({ showId: GB, outletId: 'daily-mail', outlet: 'Daily Mail', criticName: 'Patrick Marmion', url: DM_URL, publishDate: '2026-09-16', ...stored }, null, 2));
  const input = { outletId: 'daily-mail', outlet: 'Daily Mail', criticName: 'Patrick Marmion', url: DM_URL, source: 'submit-review-form', fields: { fullText: fuller } };
  createOrMergeReviewFile(GB, { ...input }, { reviewTextsDir: dir });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fullText, stored.fullText, 'scraper merges still never overwrite a body');
  createOrMergeReviewFile(GB, { ...input, replaceBadBody: true }, { reviewTextsDir: dir });
  const landed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(landed.fullText, fuller);
  assert.equal(landed.replaceBadBody, undefined, 'the flag is not persisted');
  const ingest = fs.readFileSync(new URL('../ingest-review-from-url.js', import.meta.url), 'utf8');
  assert.match(ingest, /replaceBadBody: true/);
  // The real stored shape: one lede sentence, then the sign-up wall.
  const wall = '\n\nAssociated Newspapers Limited is a company registered in England and Wales (Company No. 084121). '
    + 'By continuing you agree that your information will be used in line with our Privacy Policy. '.repeat(3);
  const ledeOnly = { fullText: DM_OPEN + wall, contentTier: 'truncated' };
  assert.equal(isSameArticleBodyUpgrade(ledeOnly, DM_OPEN + DM_MORE.repeat(5)), true, 'same lede');
  assert.equal(isSameArticleBodyUpgrade(ledeOnly, DM_MORE.repeat(8)), false, 'lede absent');

  // The real 908 re-fetch: same lede, then "Continue reading" and a list of
  // other headlines. Longer, same article, and still a paywall page: the
  // writer keeps the stored body.
  const wallFetch = DM_OPEN + 'Continue reading Get unlimited digital access, first month free Subscribe Already a subscriber? Sign in Topics Showbiz Theatre More Theatre '
    + 'Theatre Economics on the stage? It sounds dry but this adds up to a night of fun Theatre Brassy Eighties romp still has a caustic edge '.repeat(4);
  fs.writeFileSync(file, JSON.stringify({ showId: GB, outletId: 'daily-mail', outlet: 'Daily Mail', criticName: 'Patrick Marmion', url: DM_URL, publishDate: '2026-09-16', ...ledeOnly }, null, 2));
  createOrMergeReviewFile(GB, { ...input, replaceBadBody: true, fields: { fullText: wallFetch } }, { reviewTextsDir: dir });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fullText, ledeOnly.fullText, 'a paywall page is not an upgrade');
});

test('a record classified "not a review" gives up its slot to the real review url (issue 913)', () => {
  const { isStaleNonReviewSlot } = require('./review-slot-guards.js');
  const news = {
    showId: GB, outletId: 'west-end-best-friend', criticName: 'News Desk',
    url: 'https://www.westendbestfriend.co.uk/news/almeida-theatre-golden-boy-broadcast-cinemas-national-theatre-live',
    wrongProduction: true, isNonReview: true, contentTier: 'invalid', incompleteReason: 'wrong_content',
  };
  const review = 'https://www.westendbestfriend.co.uk/news/review-golden-boy-almeida-theatre';
  assert.equal(isStaleNonReviewSlot(news, review), true);
  // Same /news/ url shape but only a wrongProduction verdict: a prior
  // production's REVIEW, which must keep blocking.
  const { isNonReview, ...prior } = news; // eslint-disable-line no-unused-vars
  assert.equal(isStaleNonReviewSlot(prior, review), false);
  // isNonReview mis-set by CV promotion on a real prior-production review
  // (no wrong_content verdict) keeps blocking.
  assert.equal(isStaleNonReviewSlot({ ...news, incompleteReason: undefined }, review), false);

  // End to end through the writer: the slot moves AND keeps the new text.
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4431-913-'));
  fs.mkdirSync(path.join(dir, GB));
  const file = path.join(dir, GB, 'west-end-best-friend--unknown.json');
  fs.writeFileSync(file, JSON.stringify({ ...news, criticName: 'News Desk', criticEnrichedFrom: 'html-extraction', publishDate: '2026-08-13', fullText: 'National Theatre Live has announced a broadcast. '.repeat(40) }, null, 2));
  const body = 'Josh O\u2019Connor is magnetic as Joe Bonaparte in this Golden Boy revival at the Almeida. '.repeat(25);
  const res = createOrMergeReviewFile(GB, { outletId: 'west-end-best-friend', outlet: 'West End Best Friend', criticName: 'Unknown', url: review, source: 'submit-review-form', fields: { fullText: body, publishDate: '2026-09-17' } }, { reviewTextsDir: dir });
  assert.equal(res.action, 'updated');
  const landed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(landed.url, review);
  assert.equal(landed.fullText, body);
  assert.equal(landed.publishDate, '2026-09-17');
  assert.notEqual(landed.isNonReview, true);
  assert.notEqual(landed.wrongProduction, true);
  assert.equal(landed.criticName, 'Unknown', 'the old page\'s byline goes with it');
});

// ── Captions inside one essay about both shows (Vulture, BRO-4431) ──

const VULTURE_SHOWS = [
  { id: 'how-shakespeare-saved-my-life-off-broadway-2026', title: 'How Shakespeare Saved My Life', category: 'off-broadway', openingDate: '2026-09-27' },
  { id: 'arias-with-a-twist-off-broadway-2026', title: 'Arias with a Twist', category: 'off-broadway', openingDate: '2026-09-23' },
];
const ESSAY = `Joey Arias in Arias With a Twist, at the HERE Arts Center.\n Photo: Someone\n How do you tell a life story onstage? Two shows this month, How Shakespeare Saved My Life and Arias With a Twist, try it. ${filler('memory', 8)}\n\n`
  + `Jacob Ming-Trent in How Shakespeare Saved My Life, at the Public Theater.\n Photo: Someone\n ${filler('solo show', 10)} It is an irony that Arias With a Twist flips inside out. ${filler('cabaret', 10)}\n\n`
  + 'How Shakespeare Saved My Life is at the Public Theater through October 25. Arias With a Twist is at HERE Arts Center through November 1.';

test('captions inside one essay about both shows do not split it', () => {
  const plan = planMultiShowFanout(base({ showId: 'how-shakespeare-saved-my-life-off-broadway-2026', publishDate: '2026-09-28', fullText: ESSAY }), VULTURE_SHOWS);
  assert.equal(plan, null);
  const { captionSectionsCrossTalk } = require('./multi-show-review-fanout.js');
  // Closing run listings alone are not cross-talk.
  const clean = [
    { showId: VULTURE_SHOWS[0].id, sectionText: `${filler('solo show', 6)} How Shakespeare Saved My Life is at the Public Theater through October 25.` },
    { showId: VULTURE_SHOWS[1].id, sectionText: `${filler('cabaret', 6)} Arias With a Twist is at HERE Arts Center through November 1. How Shakespeare Saved My Life is at the Public Theater through October 25.` },
  ];
  assert.equal(captionSectionsCrossTalk(clean, VULTURE_SHOWS), false);
});

test('a wrong split is undone when the whole article comes back (re-ingest)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4431-unsplit-'));
  const [hs, arias] = VULTURE_SHOWS.map((s) => s.id);
  const url = 'https://www.vulture.com/article/reviews-how-shakespeare-saved-my-life-arias-with-a-twist.html';
  const hsSection = ESSAY.slice(ESSAY.indexOf('Jacob Ming-Trent'));
  const common = { outletId: 'vulture', outlet: 'Vulture', criticName: 'Sara Holdren', url, publishDate: '2026-09-28', contentTier: 'complete' };
  fs.mkdirSync(path.join(dir, hs));
  fs.mkdirSync(path.join(dir, arias));
  const parentPath = path.join(dir, hs, 'vulture--sara-holdren.json');
  const childPath = path.join(dir, arias, 'vulture--sara-holdren.json');
  fs.writeFileSync(parentPath, JSON.stringify({ ...common, showId: hs, fullText: hsSection, assignedScore: 45,
    multiShowSplitProcessed: '2026-09-30T00:00:00Z', multiShowSplitParent: true, multiShowSplitChildShowIds: [arias],
    multiShowSplitAnchorKind: 'caption', multiShowSplitTextLength: hsSection.length }, null, 2));
  fs.writeFileSync(childPath, JSON.stringify({ ...common, showId: arias, fullText: ESSAY.slice(0, ESSAY.indexOf('Jacob Ming-Trent')),
    multiShowSplitChild: true, multiShowSplitParentShowId: hs, multiShowSplitProcessed: '2026-09-30T00:00:00Z' }, null, 2));

  // The re-ingest: an explicit ingest may put the whole article back on a
  // split parent (same lede), which a scraper merge never does.
  const { isSameArticleBodyUpgrade } = require('./stale-merge-check.js');
  const parentBefore = JSON.parse(fs.readFileSync(parentPath, 'utf8'));
  assert.equal(isSameArticleBodyUpgrade(parentBefore, ESSAY), true);
  assert.equal(isSameArticleBodyUpgrade(parentBefore, filler('other', 40)), false);
  fs.writeFileSync(parentPath, JSON.stringify({ ...parentBefore, fullText: ESSAY }, null, 2));

  const res = applyMultiShowFanoutToFile(parentPath, { shows: VULTURE_SHOWS, reviewTextsDir: dir });
  assert.equal(res.applied, false);
  assert.deepEqual(res.unsplit.children, [arias]);
  for (const [p, other] of [[parentPath, arias], [childPath, hs]]) {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.equal(d.fullText, ESSAY, p);
    assert.equal(d.multiShowSplitParent, undefined);
    assert.equal(d.multiShowSplitChild, undefined);
    assert.equal(d.isCombinedReview, true);
    assert.deepEqual(d.combinedWith, [other]);
    assert.equal(d.needsRescore, true);
  }
  // A correctly split parent is untouched by the undo path.
  const { isWholeArticleBackOnBadSplit } = require('./multi-show-review-fanout.js');
  assert.equal(isWholeArticleBackOnBadSplit({ ...parentBefore }), false);
});

// ── Second-opinion findings (BRO-4431 follow-up review) ──

test('body upgrade tier order: complete > truncated > excerpt, strictly better unless complete', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4431-tier-'));
  fs.mkdirSync(path.join(dir, GB));
  const file = path.join(dir, GB, 'daily-mail--patrick-marmion.json');
  const stored = DM_OPEN + DM_MORE.repeat(2);
  const seed = { showId: GB, outletId: 'daily-mail', outlet: 'Daily Mail', criticName: 'Patrick Marmion', url: DM_URL, publishDate: '2026-09-16', fullText: stored, contentTier: 'truncated' };
  const input = { outletId: 'daily-mail', outlet: 'Daily Mail', criticName: 'Patrick Marmion', url: DM_URL, source: 'submit-review-form', replaceBadBody: true };
  // A longer copy that still classifies truncated (no ending) is not taken.
  fs.writeFileSync(file, JSON.stringify(seed, null, 2));
  const stillCut = DM_OPEN + DM_MORE.repeat(3) + 'And then the second act';
  createOrMergeReviewFile(GB, { ...input, fields: { fullText: stillCut } }, { reviewTextsDir: dir });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  const { classifyContentTier } = require('./content-quality.js');
  const candTier = classifyContentTier({ ...seed, fullText: stillCut, contentTier: undefined }).contentTier;
  if (candTier !== 'complete') assert.equal(after.fullText, stored, `a ${candTier} copy does not replace a truncated body`);
});

test('a correct split that gets its whole article back re-trims; it is never undone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4431-retrim-'));
  const [hs, arias] = VULTURE_SHOWS.map((s) => s.id);
  const clean = `Joey Arias in Arias With a Twist, at the HERE Arts Center.\n Photo: Someone\n ${filler('cabaret', 8)}\n\nJacob Ming-Trent in How Shakespeare Saved My Life, at the Public Theater.\n Photo: Someone\n ${filler('solo show', 10)}`;
  const own = clean.slice(clean.indexOf('Jacob Ming-Trent'));
  fs.mkdirSync(path.join(dir, hs));
  const p = path.join(dir, hs, 'vulture--sara-holdren.json');
  const rec = { showId: hs, outletId: 'vulture', outlet: 'Vulture', criticName: 'Sara Holdren', url: 'https://www.vulture.com/x.html', publishDate: '2026-09-28', contentTier: 'complete',
    fullText: clean, multiShowSplitProcessed: '2026-09-30T00:00:00Z', multiShowSplitParent: true, multiShowSplitChildShowIds: [arias], multiShowSplitTextLength: own.length };
  const { isWholeArticleBackOnBadSplit } = require('./multi-show-review-fanout.js');
  assert.equal(isWholeArticleBackOnBadSplit(rec, VULTURE_SHOWS), false);
  // Planner null for another reason (a partial tier) is not evidence either.
  assert.equal(isWholeArticleBackOnBadSplit({ ...rec, fullText: ESSAY, contentTier: 'truncated', humanReviewScore: 70 }, VULTURE_SHOWS), false);
  fs.writeFileSync(p, JSON.stringify(rec, null, 2));
  const res = applyMultiShowFanoutToFile(p, { shows: VULTURE_SHOWS, reviewTextsDir: dir });
  assert.equal(res.unsplit, undefined);
  // An undone split stays whole.
  assert.equal(planMultiShowFanout({ ...rec, multiShowSplitParent: undefined, multiShowSplitProcessed: undefined, multiShowUnsplitAt: '2026-09-30' }, VULTURE_SHOWS), null);
});

test('an ordinary url upgrade keeps an enriched byline (only a stale-slot move resets it)', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4431-byline-'));
  fs.mkdirSync(path.join(dir, GB));
  const file = path.join(dir, GB, 'guardian--arifa-akbar.json');
  fs.writeFileSync(file, JSON.stringify({ showId: GB, outletId: 'guardian', outlet: 'The Guardian', criticName: 'Arifa Akbar', criticEnrichedFrom: 'html-override:jsonld-person',
    url: 'https://amp.theguardian.com/stage/2026/sep/17/golden-boy-review-almeida', publishDate: '2026-09-17', fullText: 'Short cut text of the review.', contentTier: 'truncated' }, null, 2));
  createOrMergeReviewFile(GB, { outletId: 'guardian', outlet: 'The Guardian', criticName: 'Arifa Akbar', url: 'https://www.theguardian.com/stage/2026/sep/17/golden-boy-review-almeida', source: 'submit-review-form', fields: {} }, { reviewTextsDir: dir });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).criticName, 'Arifa Akbar');
});

test('stale-slot isNonReview: wrongShow + wrong_content moves, wrongShow alone blocks', () => {
  const { isStaleNonReviewSlot } = require('./review-slot-guards.js');
  const rec = { url: 'https://www.westendbestfriend.co.uk/news/some-news-post', isNonReview: true, wrongShow: true, criticName: 'Unknown' };
  const review = 'https://www.westendbestfriend.co.uk/news/review-golden-boy-almeida-theatre';
  assert.equal(isStaleNonReviewSlot({ ...rec, incompleteReason: 'wrong_content' }, review), true);
  assert.equal(isStaleNonReviewSlot(rec, review), false);
});

test('a split parent never takes a whole article the fan-out cannot act on', () => {
  const { createOrMergeReviewFile } = require('./review-file-writer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4431-splitswap-'));
  const hs = VULTURE_SHOWS[0].id;
  fs.mkdirSync(path.join(dir, hs));
  const p = path.join(dir, hs, 'vulture--sara-holdren.json');
  const section = `Jacob Ming-Trent in How Shakespeare Saved My Life, at the Public Theater. ${filler('solo show', 12)}`;
  // Whole article: same lede, then unrelated prose naming no other tracked
  // show -> neither a re-trim nor an undo is possible.
  const whole = section + ' ' + filler('epilogue', 30);
  fs.writeFileSync(p, JSON.stringify({ showId: hs, outletId: 'vulture', outlet: 'Vulture', criticName: 'Sara Holdren', url: 'https://www.vulture.com/x.html',
    publishDate: '2026-09-28', contentTier: 'complete', fullText: section, multiShowSplitProcessed: '2026-09-30T00:00:00Z', multiShowSplitParent: true,
    multiShowSplitChildShowIds: [VULTURE_SHOWS[1].id], multiShowSplitTextLength: section.length }, null, 2));
  createOrMergeReviewFile(hs, { outletId: 'vulture', outlet: 'Vulture', criticName: 'Sara Holdren', url: 'https://www.vulture.com/x.html', source: 'submit-review-form', replaceBadBody: true, fields: { fullText: whole } }, { reviewTextsDir: dir });
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).fullText, section);
});
