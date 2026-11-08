/**
 * BRO-7121: a BroadwayWorld roundup row keeps the critic's own link, which may
 * be a columnist index (Red / NY Daily News) and cannot name the show. The
 * roundup URL is the provenance, but only a single-show roundup: the Waiting
 * for Godot "Double Review Roundup 9 to 5 and Waiting for Godot" also names the
 * show while its rows are 9 to 5 reviews, and must keep flagging.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');

const RED = { id: 'red-2010', title: 'Red', slug: 'red-2010' };
const GODOT = { id: 'waiting-for-godot-2009', title: 'Waiting for Godot', slug: 'waiting-for-godot-2009' };
const TIME = { id: 'time-stands-still-2010', title: 'Time Stands Still', slug: 'time-stands-still-2010' };
const COMPANY = { id: 'company-2006', title: 'Company', slug: 'company-2006' };
const RED_URL = 'https://www.nydailynews.com/entertainment/columnists/dziemianowicz/index.html';
const GODOT_URL = 'http://leisureblogs.chicagotribune.com/the_theater_loop/2009/04/dolly-parton-on-broadway-9-to-5-has-its-moments.html';
const BWW = 'https://www.broadwayworld.com/article/';

let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-roundup-'));
  const put = (show, name, obj) => {
    fs.mkdirSync(path.join(root, show.id), { recursive: true });
    fs.writeFileSync(path.join(root, show.id, name), JSON.stringify(obj));
  };
  put(RED, 'a.json', { url: RED_URL.replace('https://www.', 'http://www.'), bwwExcerpt: 'Logan\'s vivid play manages the same strokes.', bwwRoundupUrl: `${BWW}Broadway-Blog-RED-Review-Roundup-20100402` });
  put(GODOT, 'a.json', { url: GODOT_URL, bwwExcerpt: 'The show is wholly harmless.', bwwRoundupUrl: `${BWW}Broadway-Blog-Double-Review-Roundup-9-to-5-and-Waiting-for-Godot-20090501` });
  put(TIME, 'a.json', { url: 'https://example.com/a-column', bwwExcerpt: 'Moving.', bwwRoundupUrl: `${BWW}Broadway-Blog-Review-Roundup-Exit-the-King-and-More-Time-Stands-Still-20090327` });
  put(COMPANY, 'a.json', { url: 'https://example.com/a-column', bwwExcerpt: 'Fine.', bwwRoundupUrl: `${BWW}Review-Roundup-THE-COMPANY-MEN-20100101` });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const runOne = (show, url) => check.run(show, {
  reviewTextsRoot: root,
  reviewsDoc: { [show.id]: [{ outletId: 'o', criticName: 'c', url }] },
});

describe('review-text lookup ignores scheme and www', () => {
  it('urlKey folds http/https and www', () => {
    assert.strictEqual(check.urlKey('http://www.x.com/a'), check.urlKey('https://x.com/a'));
  });
});

describe('roundup provenance confirms a URL that cannot name the show', () => {
  it('clears the Red / NY Daily News columnist-index row', () => {
    assert.strictEqual(runOne(RED, RED_URL).ok, true);
  });
  it('a double roundup never confirms (Godot 9 to 5 row keeps flagging)', () => {
    assert.strictEqual(runOne(GODOT, GODOT_URL).ok, false);
  });
  it('an "and More" multi-show roundup never confirms', () => {
    assert.strictEqual(runOne(TIME, 'https://example.com/a-column').ok, false);
  });
  it('a one-word title is not confirmed by a different show\'s roundup URL', () => {
    assert.strictEqual(runOne(COMPANY, 'https://example.com/a-column').ok, false);
  });
  it('roundupNamesShow ignores a missing roundup URL', () => {
    assert.strictEqual(check.roundupNamesShow(undefined, ['red']), false);
  });
});
