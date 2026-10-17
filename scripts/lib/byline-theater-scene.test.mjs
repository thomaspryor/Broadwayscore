// BRO-5499: TheaterScene.net prints the real critic on "Posted on <date> by X in <category>"; the
// site editor (Victor Gluck) is credited by listing metadata on pages other critics wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractTheaterSceneByline, printedBylineOverride } = require('./byline-from-text');
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const TEXT = 'Midnight Todrick Hall’s ambitious, visually dazzling musical has talent to burn. Posted on October 15, 2026 by Samuel L. Leiter in Musicals , Off-Broadway , Still Open Share your thoughts. ' + 'The staging is busy and the score keeps arriving. '.repeat(30);

test('extracts the printed byline', () => {
  assert.deepEqual(extractTheaterSceneByline(TEXT), { name: 'Samuel L. Leiter', known: true });
  assert.equal(extractTheaterSceneByline('No byline line here at all.'), null);
});

const URL_OK = 'https://www.theaterscene.net/musicals/offbway/midnight/samuel-l-leiter/';

test('override applies to theater-scene only, and only when the url slug names the same critic', () => {
  assert.equal(printedBylineOverride('theater-scene', TEXT, URL_OK), 'Samuel L. Leiter');
  assert.equal(printedBylineOverride('vulture', TEXT, URL_OK), null);
  // "Posted by" can name the uploader: 5 of 129 corpus pages disagree with their own slug (pen-pals: lydia-singer vs "Lydia Rose")
  assert.equal(printedBylineOverride('theater-scene', TEXT, 'https://www.theaterscene.net/musicals/offbway/midnight/victor-gluck/'), null);
  assert.equal(printedBylineOverride('theater-scene', TEXT, undefined), null);
});

test('writer replaces the editor name with the printed byline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-byline-'));
  try {
    const r = createOrMergeReviewFile('midnight-off-broadway-2026', {
      outletId: 'theater-scene', outlet: 'Theater Scene', criticName: 'Victor Gluck',
      url: 'https://www.theaterscene.net/musicals/offbway/midnight/samuel-l-leiter/', source: 'playbill-verdict',
      fields: { fullText: TEXT, publishDate: '2026-10-15' },
    }, { reviewTextsDir: dir });
    assert.notEqual(r.action, 'skipped');
    const d = path.join(dir, 'midnight-off-broadway-2026');
    const files = fs.readdirSync(d);
    assert.equal(files.length, 1);
    const data = JSON.parse(fs.readFileSync(path.join(d, files[0]), 'utf8'));
    assert.equal(data.criticName, 'Samuel L. Leiter');
    assert.match(files[0], /samuel-l-leiter/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
