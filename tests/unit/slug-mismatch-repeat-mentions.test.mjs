/**
 * BRO-6524: a correct regional review that names the show only after the
 * 1,500-char lede (headline URL) must not trip the slug-mismatch sweep, but a
 * single passing mention (column, roundup) must still flag.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');

const SHOW = { id: 'the-lifespan-of-a-fact-regional-2023', title: 'The Lifespan of a Fact', slug: 'the-lifespan-of-a-fact' };
const LATE = 'https://www.chicagotheatrereview.com/2023/11/a-can-of-worms/';
const ONCE = 'https://www.out.com/michael-musto/2017/4/03/queer-icon';
const ROUNDUP = 'https://example.com/2023/11/fall-roundup';
const filler = 'The company stages a gripping evening about an editor and a fact checker. '.repeat(30);
let root;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-repeat-'));
  const dir = path.join(root, SHOW.id);
  fs.mkdirSync(dir);
  const w = (n, o) => fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
  w('a.json', { url: LATE, fullText: filler + ' The Lifespan of a Fact is sharp. ' + filler + ' See The Lifespan of a Fact.' });
  w('b.json', { url: ONCE, fullText: filler + ' Also: The Lifespan of a Fact.' });
  w('c.json', { url: ROUNDUP, isRoundupArticle: true, fullText: filler + ' The Lifespan of a Fact. ' + filler + ' The Lifespan of a Fact.' });
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
const ctx = (urls) => ({
  reviewTextsRoot: root,
  reviewsDoc: { [SHOW.id]: urls.map((url, i) => ({ outletId: 'o', criticName: `c${i}`, url })) },
});

describe('repeated mentions beyond the lede', () => {
  it('clears a review naming the show twice past the lede', () => {
    assert.strictEqual(check.run(SHOW, ctx([LATE])).ok, true);
  });
  it('still flags a single passing mention', () => {
    assert.deepStrictEqual(check.run(SHOW, ctx([ONCE])).details.mismatches.map(m => m.url), [ONCE]);
  });
  it('still flags a roundup-flagged article', () => {
    assert.strictEqual(check.run(SHOW, ctx([ROUNDUP])).ok, false);
  });
});
