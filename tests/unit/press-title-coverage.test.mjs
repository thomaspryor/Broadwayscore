// BRO-7778: every show opening in the next 90 days must have its short title (the part before a subtitle) matched by
// the lane and the old poller, or at least raise the near-miss alert. Generated from data/shows.json, plus fixed cases
// that run without core data. Red with the matcher fix reverted: "Review: It's a Wonderful Life" matched nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { shortTitleCoverage, subtitleLead } = require(path.join(ROOT, 'scripts/lib/press-title-coverage.js'));
const { setPressNameShows } = require(path.join(ROOT, 'scripts/lib/show-names.js'));
const { titleMatchesShow } = require(path.join(ROOT, 'scripts/lib/rss-discovery.js'));

const FIXTURE = [
  { id: 'iawl', title: 'It’s A Wonderful Life: A Live Radio Play' },
  { id: 'eno', title: 'Adriana Mater - English National Opera' },
  { id: 'dolly', title: 'Dolly: A True Original Musical' },
  { id: 'hello-dolly', title: 'Hello, Dolly!' },
  { id: 'diana', title: 'Diana: The Untold and Untrue Story' },
  { id: 'diana-musical', title: 'Diana, The Musical' },
  { id: 'aoc', title: 'August: Osage County' },
  { id: 'carol', title: 'Charles Dickens’ “A Christmas Carol”' },
];

test('fixed cases: subtitle shows are matched or near-missed', () => {
  setPressNameShows(FIXTURE);
  try {
    const titles = FIXTURE.map((s) => s.title);
    const status = Object.fromEntries(FIXTURE.map((s) => [s.id, shortTitleCoverage(s, titles).status]));
    assert.equal(status.iawl, 'matched');
    assert.equal(status.eno, 'matched');
    assert.equal(status.dolly, 'near-miss'); // shared with Hello, Dolly!: alert only
    assert.equal(status.diana, 'near-miss');
    assert.equal(status.aoc, 'near-miss'); // "August" alone is never a title
    assert.equal(status['hello-dolly'], 'no-subtitle');
    assert.equal(subtitleLead(FIXTURE[7].title), null); // author credit, not a short title
  } finally { setPressNameShows(null); }
});

test('acceptance: tonight’s headline matches on the lane and the poller paths', () => {
  setPressNameShows(FIXTURE);
  try {
    const titles = FIXTURE.map((s) => s.title);
    const t = FIXTURE[0].title;
    assert.ok(titleMatchesShow("Review: It's a Wonderful Life", t, { fuzzy: true, mainTitle: true, allShowTitles: titles }));
    assert.ok(titleMatchesShow("Review: It's a Wonderful Life", t, { mainTitle: true, allShowTitles: titles }));
    // the film, with no review cue, stays out
    assert.ok(!titleMatchesShow("It's a Wonderful Life turns 80: where to stream it", t, { mainTitle: true, allShowTitles: titles }));
  } finally { setPressNameShows(null); }
});

const SHOWS_PATH = path.join(ROOT, 'data/shows.json');
const shows = fs.existsSync(SHOWS_PATH) ? (JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows || []) : null;

test('every show opening in the next 90 days: short title matched or near-missed', { skip: !shows && 'no data/shows.json' }, () => {
  setPressNameShows(null);
  const titles = shows.map((s) => s.title).filter(Boolean);
  const now = Date.now();
  const upcoming = shows.filter((s) => s.title && s.openingDate
    && Date.parse(s.openingDate) >= now - 86400000 && Date.parse(s.openingDate) <= now + 90 * 86400000);
  const gaps = [];
  let checked = 0;
  for (const s of upcoming) {
    const c = shortTitleCoverage(s, titles);
    if (c.status === 'no-subtitle') continue;
    checked++;
    if (c.status === 'gap') gaps.push(`${s.id} ("${c.lead}"): ${c.missed.slice(0, 2).join('; ')}`);
  }
  assert.deepEqual(gaps, [], `short titles nothing catches:\n${gaps.join('\n')}`);
  console.log(`# ${checked} subtitle shows of ${upcoming.length} opening in 90 days: none uncaught`);
});
