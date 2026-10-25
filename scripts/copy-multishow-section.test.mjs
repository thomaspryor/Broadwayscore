// BRO-5325: end-to-end run of scripts/copy-multishow-section.js on fixture
// review-texts. Shapes follow the card's three cases: venus-in-fur-2011 (a short
// own WSJ row, the section in godspell-2011's column), of-mice-and-men-2014 (no
// Teachout row, the section in act-one-2014's column) and 9-to-5-2009 (its box
// sits in a cluster in waiting-for-godot-2009's column, so the copy refuses).
// Invented placeholder prose, not review text. Pure rules: tests/unit/multishow-section-copy.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'copy-multishow-section.js');

const SHOWS = [
  { id: 'godspell-2011', title: 'Godspell', venue: 'Circle in the Square Theatre', openingDate: '2011-11-07' },
  { id: 'venus-in-fur-2011', title: 'Venus in Fur', venue: 'Samuel J. Friedman Theatre', openingDate: '2011-11-08' },
  { id: 'act-one-2014', title: 'Act One', venue: 'Vivian Beaumont Theater', openingDate: '2014-04-17' },
  { id: 'of-mice-and-men-2014', title: 'Of Mice and Men', venue: 'Longacre Theatre', openingDate: '2014-04-16' },
  { id: 'waiting-for-godot-2009', title: 'Waiting for Godot', venue: 'Studio 54', openingDate: '2009-04-30' },
  { id: '9-to-5-2009', title: '9 to 5', venue: 'Marquis Theatre', openingDate: '2009-04-30' },
];
const P = (s, n) => (s + ' ').repeat(n);
const VENUS = 'Venus in Fur opens on a rainy night and the actress arrives late for her audition. '
  + P('Venus in Fur is sharp and funny and the two actors are superb together.', 6)
  + P('The staging is taut and the evening never sags for a moment.', 8) + 'Go early and stay for the curtain call.';
const GODSPELL = P('Godspell is back in a round staging that never settles on a tone.', 6) + P('The band is loud and the jokes are dated.', 10);
const MICE = 'Of Mice and Men returns with a pair of strong leads and a plain set. '
  + P('Of Mice and Men moves slowly but the final scene lands hard.', 6)
  + P('The supporting cast is uneven and the lighting is dim.', 8) + 'It is worth the trip for the ending.';
const ACTONE = P('Act One is a long memoir play that sprawls over three hours.', 6) + P('The design is lavish and the pacing drags.', 10);
const NINE = P('9 to 5 is a loud office musical with a thin book.', 6) + P('The songs blur together and the set is busy.', 8);
const GODOT = P('Waiting for Godot is a fine revival with two great clowns.', 6) + P('The tree is bare and the waiting is funny.', 8);
const BOX = {
  venus: 'Samuel J. Friedman Theatre, 261 W. 47th St. ($57-$121), 212-239-6200, closes Dec. 18',
  godspell: 'Circle in the Square Theatre, 235 W. 50th St. ($69-$145), 212-239-6200',
  mice: 'Longacre Theatre, 220 W. 48th St. ($37-$149), 212-239-6200, closes July 27',
  actone: 'Vivian Beaumont Theater, 150 W. 65th St. ($75-$135), 212-239-6200, closes June 15',
  nine: 'Marquis Theatre, 1535 Broadway ($41-$126), 877-250-2929',
  godot: 'Studio 54, 254 W. 54th St. ($41-$111), 212-719-1300, closes July 5',
};
// Each column is dated inside its shows' runs: safeWriteReview quarantines a
// row dated far from the show's opening (date_implausible) when shows.json exists, as in CI.
const column = (showId, fullText, publishDate) => ({
  showId, outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'Terry Teachout',
  url: `https://www.wsj.com/articles/${showId}-column`, publishDate, contentTier: 'complete', fullText,
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-multishow-'));
  const root = path.join(dir, 'review-texts');
  const put = (rel, obj) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(obj, null, 2));
  };
  put('godspell-2011/wsj--terry-teachout.json', column('godspell-2011', `${BOX.godspell} ${GODSPELL} ${BOX.venus} ${VENUS}`, '2011-11-11'));
  put('venus-in-fur-2011/wsj--terry-teachout.json', {
    showId: 'venus-in-fur-2011', outletId: 'wsj', outlet: 'The Wall Street Journal', criticName: 'Terry Teachout',
    url: 'https://www.wsj.com/articles/godspell-2011-column', publishDate: '2011-11-11', contentTier: 'truncated', fullText: VENUS.slice(0, 220),
  });
  put('act-one-2014/wsj--terry-teachout.json', column('act-one-2014', `${BOX.actone} ${ACTONE} ${BOX.mice} ${MICE}`, '2014-04-18'));
  // The 9 to 5 box sits in a cluster before both reviews: ambiguous, not splittable.
  put('waiting-for-godot-2009/wsj--terry-teachout.json', column('waiting-for-godot-2009', `${BOX.godot} ${BOX.nine} ${GODOT} ${NINE}`, '2009-05-01'));
  const showsPath = path.join(dir, 'show-list-fixture.json');
  fs.writeFileSync(showsPath, JSON.stringify({ shows: SHOWS }));
  return { dir, root, showsPath };
}

const run = (fx, args) => spawnSync(process.execPath, [CLI, `--dir=${fx.root}`, `--shows=${fx.showsPath}`, ...args], { encoding: 'utf8' });
// Every file under the fixture root, path -> content: a refusal or dry run must leave it identical.
const snapshot = (fx) => Object.fromEntries(fs.readdirSync(fx.root, { recursive: true })
  .filter((rel) => fs.statSync(path.join(fx.root, rel)).isFile()).sort()
  .map((rel) => [rel, fs.readFileSync(path.join(fx.root, rel), 'utf8')]));
const read = (fx, rel) => JSON.parse(fs.readFileSync(path.join(fx.root, rel), 'utf8'));

const VENUS_ARGS = ['--from=godspell-2011/wsj--terry-teachout.json', '--to-show=venus-in-fur-2011',
  '--expect-start=Venus_in_Fur_opens_on', '--expect-end=stay_for_the_curtain_call'];
const MICE_ARGS = ['--from=act-one-2014/wsj--terry-teachout.json', '--to-show=of-mice-and-men-2014',
  '--expect-start=Of_Mice_and_Men_returns', '--expect-end=trip_for_the_ending'];

test('venus-in-fur-2011: the short own row is filled from the godspell column, with provenance', (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const before = snapshot(fx);
  const dry = run(fx, VENUS_ARGS);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /WOULD COPY/);
  assert.deepEqual(snapshot(fx), before, 'dry run writes nothing');

  const r = run(fx, [...VENUS_ARGS, '--apply']);
  assert.equal(r.status, 0, r.stderr);
  const row = read(fx, 'venus-in-fur-2011/wsj--terry-teachout.json');
  assert.ok(row.fullText.length >= 800, `fullText is ${row.fullText.length} chars`);
  assert.equal(row.fullText, VENUS.trim(), 'exactly the Venus section, nothing of the Godspell review');
  assert.ok(row.multiShowSource, 'multiShowSource written');
  assert.equal(row.multiShowSectionCopy.fromShowId, 'godspell-2011');
  assert.equal(row.publishDate, '2011-11-11');
  const parent = read(fx, 'godspell-2011/wsj--terry-teachout.json');
  assert.match(parent.fullText, /Godspell is back/, 'the column row keeps its own text');

  // Re-running is a no-op refresh, not a second copy or a refusal.
  const again = run(fx, [...VENUS_ARGS, '--apply']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(read(fx, 'venus-in-fur-2011/wsj--terry-teachout.json').fullText, row.fullText);
});

test('of-mice-and-men-2014: a Teachout row is created from the act-one column, with provenance', (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const r = run(fx, [...MICE_ARGS, '--apply']);
  assert.equal(r.status, 0, r.stderr);
  const row = read(fx, 'of-mice-and-men-2014/wsj--terry-teachout.json');
  assert.equal(row.showId, 'of-mice-and-men-2014');
  assert.equal(row.criticName, 'Terry Teachout');
  assert.ok(row.fullText.length >= 800, `fullText is ${row.fullText.length} chars`);
  assert.equal(row.fullText, MICE.trim(), 'exactly the Of Mice and Men section');
  assert.ok(row.multiShowSource, 'multiShowSource written');
  assert.equal(row.multiShowSectionCopy.fromShowId, 'act-one-2014');
  assert.equal(row.publishDate, '2014-04-18');
});

test('9-to-5-2009: a clustered venue box refuses and writes nothing', (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const before = snapshot(fx);
  const r = run(fx, ['--from=waiting-for-godot-2009/wsj--terry-teachout.json', '--to-show=9-to-5-2009',
    '--expect-start=9_to_5_is_a', '--expect-end=the_set_is_busy', '--apply']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED 9-to-5-2009\/wsj--terry-teachout\.json: no unambiguous section: (section also names boxed show|.*cluster|.*ambiguous)/);
  assert.equal(fs.existsSync(path.join(fx.root, '9-to-5-2009')), false);
  assert.deepEqual(snapshot(fx), before);
});

test('marker mismatch refuses: a plan can not file the wrong stretch of the column', (t) => {
  const fx = fixture();
  t.after(() => fs.rmSync(fx.dir, { recursive: true, force: true }));
  const before = snapshot(fx);
  const r = run(fx, ['--from=act-one-2014/wsj--terry-teachout.json', '--to-show=of-mice-and-men-2014',
    '--expect-start=Act_One_is_a', '--expect-end=trip_for_the_ending', '--apply']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED of-mice-and-men-2014\/wsj--terry-teachout\.json: section does not start with the expected words/);
  assert.equal(fs.existsSync(path.join(fx.root, 'of-mice-and-men-2014')), false);
  assert.deepEqual(snapshot(fx), before);
});
