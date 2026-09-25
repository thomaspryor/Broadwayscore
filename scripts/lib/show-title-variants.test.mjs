// Recurrence guard for punctuation-sensitive show-mention checks (2026-09-24).
// shows.json "Dog Man - The Musical" vs reviews' "Dog Man: The Musical" made
// every show-mention check count 0 mentions: real reviews were nulled as
// url_content_mismatch, flagged showNotMentioned (blocking LLM scoring), and the
// rebuild auto-clear never undid it. These tests require() the real functions.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  normalizeForMention, buildShowTitleVariants, countVariant, textMentionsTitle,
} = require('./show-title-variants.js');
const { validateShowMentioned, validateContentMentionsShow } = require('./content-quality.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOWS_PATH = join(__dirname, '..', '..', 'data', 'shows.json');

const FILLER = ' The cast is strong, the staging inventive, and the score lands with real warmth. '
  + 'Audiences of all ages responded to the humour and the heart of the evening. '.repeat(3);

test('Dog Man: colon in text matches " - " in shows.json', () => {
  const title = 'Dog Man - The Musical';
  const text = `Review: Dog Man: The Musical at the Southbank Centre.${FILLER}`;
  assert.ok(textMentionsTitle(text, title));
  assert.equal(validateShowMentioned(text, title, 'dog-man-the-musical-west-end-2026').valid, true);
  const r = validateContentMentionsShow(text, null, title, 'dog-man-the-musical-west-end-2026');
  assert.equal(r.valid, true, r.reason);
});

test('Dog Man: short pre-subtitle title "Dog Man" counts as a mention', () => {
  const title = 'Dog Man - The Musical';
  assert.deepEqual(buildShowTitleVariants(title), ['dog man the musical', 'dog man']);
  const text = `Dog Man is half man and half dog.${FILLER}`;
  assert.equal(validateShowMentioned(text, title, 'dog-man-the-musical-west-end-2026').valid, true);
});

test('"hotdog manager" is not a Dog Man mention (word boundaries)', () => {
  assert.equal(textMentionsTitle(`The hotdog manager spoke.${FILLER}`, 'Dog Man - The Musical'), null);
});

test('"Oh, Mary!" matches "Oh Mary!" and "Oh, Mary"', () => {
  for (const form of ['Oh Mary!', 'Oh, Mary', 'OH, MARY!', 'Oh Mary']) {
    const text = `Cole Escola's ${form} arrives in London.${FILLER}`;
    assert.equal(validateShowMentioned(text, 'Oh, Mary!', 'oh-mary-west-end-2025').valid, true, form);
  }
});

test('curly apostrophes and en dashes fold both ways', () => {
  const title = 'Joe Turner\'s Come and Gone';
  const text = `August Wilson’s Joe Turner’s Come and Gone opens.${FILLER}`;
  assert.ok(textMentionsTitle(text, title));
  assert.ok(textMentionsTitle(`School of Rock: The Musical.${FILLER}`, 'School of Rock – The Musical'));
  assert.ok(textMentionsTitle(`Hula-Hoopin' Queen — The Musical`, 'The Hula-Hoopin’ Queen – The Musical'));
  assert.ok(textMentionsTitle('Les Misérables returns', 'Les Miserables'));
});

test('comma prefix only for subtitle-like commas; generic/month prefixes never added', () => {
  assert.deepEqual(buildShowTitleVariants('Hello, Dolly!'), ['hello dolly']);
  assert.deepEqual(buildShowTitleVariants('Kiss Me, Kate'), ['kiss me kate']);
  assert.ok(buildShowTitleVariants('Beaches, A New Musical').includes('beaches'));
  assert.ok(!buildShowTitleVariants('August: Osage County').includes('august'));
  assert.ok(!buildShowTitleVariants('MJ: The Musical').includes('mj'));
});

test('normalizeForMention keeps intra-word hyphens and apostrophes', () => {
  assert.equal(normalizeForMention('Spider-Man — Turn Off the Dark'), 'spider-man turn off the dark');
  assert.equal(normalizeForMention('“It’s great,” she said'), "it's great she said");
  assert.equal(countVariant(normalizeForMention("Joe Turner's; Joe Turner."), 'joe turner'), 2);
});

test('unrelated text still fails', () => {
  const text = `A long article about a completely different play at the Old Vic.${FILLER}`;
  assert.equal(validateShowMentioned(text, 'Dog Man - The Musical', 'dog-man-the-musical-west-end-2026').valid, false);
  assert.equal(validateContentMentionsShow(text, null, 'Dog Man - The Musical', 'dog-man-the-musical-west-end-2026').valid, false);
});

// Swap the title's separator (' - ' ↔ ': ', en/em dash → ': ', ', ' → ' ') the
// way outlets rewrite it, then require every check to see the mention.
function swapSeparators(title) {
  if (/ [-–—] /.test(title)) return title.replace(/ [-–—] /g, ': ');
  if (/:\s/.test(title)) return title.replace(/:\s/g, ' - ');
  if (/,\s/.test(title)) return title.replace(/,\s/g, ' ');
  return null;
}

test('every shows.json title is still matched with its separator swapped', (t) => {
  if (!existsSync(SHOWS_PATH)) {
    t.skip('data/shows.json not present (core data not checked out)');
    return;
  }
  const raw = JSON.parse(readFileSync(SHOWS_PATH, 'utf8'));
  const shows = Array.isArray(raw) ? raw : (raw.shows || Object.values(raw));
  const failures = [];
  let checked = 0;
  for (const s of shows) {
    if (!s || typeof s.title !== 'string' || s.title.length <= 3) continue;
    const swapped = swapSeparators(s.title);
    if (!swapped) continue;
    // Titles whose separators are the whole title (e.g. "||: Girls :||") have no words to swap around.
    if (!/[a-z0-9]/i.test(swapped)) continue;
    checked++;
    const text = `Review: ${swapped} opened this week.${FILLER}`;
    const vm = validateShowMentioned(text, s.title, s.id);
    const vc = validateContentMentionsShow(text, null, s.title, s.id);
    if (!textMentionsTitle(text, s.title) || !vm.valid || !vc.valid) {
      failures.push(`${s.id}: "${s.title}" → "${swapped}" (helper=${!!textMentionsTitle(text, s.title)} validateShowMentioned=${vm.valid} validateContentMentionsShow=${vc.valid}: ${vc.reason || ''})`);
    }
  }
  assert.ok(checked > 100, `expected >100 titles with separators, got ${checked}`);
  assert.deepEqual(failures, [], `${failures.length}/${checked} titles fail:\n${failures.slice(0, 20).join('\n')}`);
});

test('common-phrase prefixes are not variants ("One Day \u2013 The Musical" is not "Just For One Day")', () => {
  assert.deepEqual(buildShowTitleVariants('One Day \u2013 The Musical'), ['one day the musical']);
  assert.equal(textMentionsTitle(`Theatre review: Just For One Day, Shaftesbury.${FILLER}`, 'One Day \u2013 The Musical'), null);
  assert.ok(textMentionsTitle(`One Day: The Musical opens.${FILLER}`, 'One Day \u2013 The Musical'));
});
