/**
 * BRO-7204 class guard. "slug-mismatch lifetime sweep" was filed six times
 * (BRO-4697/5438/5536/5693/6524/7121) because the check treated "URL and text
 * never say the title" as contamination, so each new outlet URL shape needed a
 * new special case. Contamination is text about ANOTHER show. This pins:
 *  - a review whose saved text is about this show clears for ANY URL shape;
 *  - text about a different show still flags, for the same URL shapes;
 *  - generic title words never clear on their own.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const check = require('../../scripts/lib/opening-night-checks/slug-mismatch.check.js');

const DOLLY = { id: 'hello-dolly-regional-2022', title: 'Hello, Dolly!', slug: 'hello-dolly' };
const MURDER = { id: 'dial-m-for-murder-regional-2023', title: 'Dial M For Murder', slug: 'dial-m-for-murder' };
const RIVAL = { id: 'wicked-2003', title: 'Wicked Spells Of Oz', slug: 'wicked-spells-of-oz' };
const OTHER1 = { id: 'murder-ballad-2013', title: 'Murder Ballad', slug: 'murder-ballad' };
const OTHER2 = { id: 'murder-on-the-orient-express-2017', title: 'Murder on the Orient Express', slug: 'murder-on-the-orient-express' };
const OTHER3 = { id: 'a-murder-is-announced-2020', title: 'A Murder Is Announced', slug: 'a-murder-is-announced' };
const OTHER4 = { id: 'murder-for-two-2013', title: 'Murder for Two', slug: 'murder-for-two' };
const SHOWS = [DOLLY, MURDER, RIVAL, OTHER1, OTHER2, OTHER3, OTHER4];

// The URL shapes that each earlier card had to special-case, plus headline URLs.
const URL_SHAPES = [
  'https://www.chicagotheatrereview.com/2022/09/it-takes-a-woman-2/',
  'https://www.ft.com/content/214ad92c-cafd-4a8d-9f10-2b1f7e0c1c11',
  'https://www.londontheatrereviews.co.uk/post.cfm?p=29349',
  'https://www.talkinbroadway.com/page/ob/02_24_26b.html',
  'https://www.nydailynews.com/columnists/dziemianowicz/index.html',
  'https://stageandcinema.com/2026/09/19/something-unrelated-review/',
];
const OPAQUE = new Set([URL_SHAPES[1], URL_SHAPES[2], URL_SHAPES[3]]);
const filler = 'The evening unfolds with brisk pacing and a warm house. '.repeat(20);
const TEXT = {
  own: `${filler} Dolly Levi sweeps in. ${filler} Dolly returns to the stage. ${filler}`,
  // about another show: names it 3x, mentions Dolly twice in passing
  other: `${filler} Wicked Spells Of Oz opens. ${filler} Wicked Spells Of Oz again. Wicked Spells Of Oz ends. Dolly Levi once. Dolly twice.`,
  generic: `${filler} A murder occurs. ${filler} Another murder follows. ${filler}`,
};
// One fresh corpus per case so no test shares state.
function run(show, url, text, withShows = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-competing-'));
  try {
    fs.mkdirSync(path.join(root, show.id));
    fs.writeFileSync(path.join(root, show.id, 'r.json'), JSON.stringify({ url, fullText: text }));
    return check.run(show, {
      reviewTextsRoot: root,
      ...(withShows ? { shows: SHOWS } : {}),
      reviewsDoc: { [show.id]: [{ outletId: 'o', criticName: 'c', url }] },
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('competing-show attribution (BRO-7204)', () => {
  for (const url of URL_SHAPES) {
    it(`clears text about this show regardless of URL shape: ${url}`, () => {
      assert.strictEqual(run(DOLLY, url, TEXT.own).ok, true);
    });
    // Opaque-id URLs (FT uuid, ?p=id, date-only pages) are deliberately skipped
    // by the URL tests; only slugged URLs reach the text test.
    if (OPAQUE.has(url)) continue;
    it(`still flags text that is about another show: ${url}`, () => {
      assert.strictEqual(run(DOLLY, url, TEXT.other).ok, false);
    });
  }
  it('a generic title word ("murder") never clears on its own', () => {
    assert.strictEqual(run(MURDER, URL_SHAPES[0], TEXT.generic).ok, false);
  });
  it('without context.shows the rule is inert (back-compat)', () => {
    assert.strictEqual(run(DOLLY, URL_SHAPES[0], TEXT.own, false).ok, false);
    assert.strictEqual(run(DOLLY, URL_SHAPES[0], TEXT.own, true).ok, true);
  });
});
