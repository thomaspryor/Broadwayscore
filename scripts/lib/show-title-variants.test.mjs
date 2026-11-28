// LIVE-DATA-LANE: reads data/shows.json (read by the test). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
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

// BRO-4584: a Phantom tour review that says only "Phantom" was flagged
// showNotMentioned and never scored. Short names come from the curated
// show-short-names.json, never from a generic first-word rule.
test('curated short name: "Phantom" mentions The Phantom of the Opera only', () => {
  const text = `If you have lived here long enough, you have probably seen a touring Phantom. Isaiah Bailey gives a Phantom who is not all posture.${FILLER}`;
  assert.equal(textMentionsTitle(text, 'The Phantom of the Opera'), 'phantom');
  assert.equal(validateShowMentioned(text, 'The Phantom of the Opera', 'the-phantom-of-the-opera-tour-2025').valid, true);
  // Same text, unrelated show: "Phantom" is not a mention of it.
  assert.equal(textMentionsTitle(text, 'Love Never Dies'), null);
  assert.equal(validateShowMentioned(text, 'Love Never Dies', 'love-never-dies-2025').valid, false);
});

// BRO-5895: a joint review section about ANON calls it "Anon", and the 4-letter
// pre-subtitle prefix is below the generic 5-char floor, so the split row was
// judged garbage and never scored. "Anonymous" must not count as "Anon".
test('curated short name: "Anon" mentions ANON, never Anonymous', () => {
  const title = 'ANON \u2013 a tempest at our kitchen table';
  const text = `Anon is a quiet family piece. The cast of Anon carries it well.${FILLER}`;
  assert.equal(textMentionsTitle(text, title), 'anon');
  assert.equal(validateShowMentioned(text, title, 'anon-a-tempest-at-our-kitchen-table-off-broadway-2026').valid, true);
  const other = `Anonymous is a quiet family piece. The cast of Anonymous carries it well.${FILLER}`;
  assert.equal(textMentionsTitle(other, title), null);
});

test('short names apply to every production title form and subtitles', () => {
  assert.ok(buildShowTitleVariants('Les Mis\u00e9rables').includes('les miz'));
  assert.ok(buildShowTitleVariants('Les Miserables').includes('les mis'));
  assert.ok(buildShowTitleVariants('Harry Potter And The Cursed Child: Both Parts').includes('cursed child'));
  // includePrefix:false (base-token count in validateContentMentionsShow) keeps them out.
  assert.ok(!buildShowTitleVariants('The Phantom of the Opera', { includePrefix: false }).includes('phantom'));
});

test('no bare first-name short names ("Joseph" matched reviews of Joseph Charlton\'s Anna X)', () => {
  assert.equal(textMentionsTitle(`Joseph Charlton's play Anna X opens.${FILLER}`, 'Joseph and the Amazing Technicolor Dreamcoat'), null);
});

test('no generic "The Musical" strip: only curated titles lose the suffix', () => {
  assert.ok(buildShowTitleVariants('Kinky Boots The Musical').includes('kinky boots'));
  assert.ok(!buildShowTitleVariants('MJ The Musical').includes('mj'));
  assert.ok(!buildShowTitleVariants('Ghost The Musical').includes('ghost'));
  assert.ok(!buildShowTitleVariants('Motown The Musical').includes('motown'));
  assert.equal(textMentionsTitle(`The ghost of her mother haunts this Hamlet.${FILLER}`, 'Ghost The Musical'), null);
});

test('idioms are not short names', () => {
  assert.equal(textMentionsTitle(`A funny thing happened on the way to the theatre.${FILLER}`, 'A Funny Thing Happened on the Way to the Forum'), null);
  assert.equal(textMentionsTitle(`She rides the streetcar home.${FILLER}`, 'A Streetcar Named Desire'), null);
  assert.equal(textMentionsTitle(`How to succeed as an actor.${FILLER}`, 'How to Succeed in Business Without Really Trying'), null);
});

test('show-short-names.json loads, normalizes, and every value is at least 4 chars', () => {
  const { loadShortNames } = require('./show-title-variants.js');
  const raw = JSON.parse(readFileSync(join(__dirname, 'show-short-names.json'), 'utf8'));
  const map = loadShortNames(raw);
  assert.deepEqual(map.get('phantom of the opera'), ['phantom']);
  for (const [k, vals] of map) for (const v of vals) assert.ok(v.length >= 4, `${k}: "${v}" is too short to ever match`);
  assert.deepEqual([...loadShortNames({ shortNames: { 'The Foo': ['Foo Bar!'] } })], [['foo', ['foo bar']]]);
});

// BRO-4584 cousin: 2-3 letter titles never passed validateShowMentioned, so
// Tru (West End) reviews were all flagged showNotMentioned and never scored.
test('curated 2-3 letter titles count when written as a proper noun twice', () => {
  const { textMentionsShortTitle } = require('./show-title-variants.js');
  const tru = `Jay Presson Allen's Tru returns. As TRU, the actor holds the room; Tru is lonely.${FILLER}`;
  assert.equal(textMentionsShortTitle(tru, 'Tru'), 'tru');
  assert.equal(validateShowMentioned(tru, 'Tru', 'tru-off-west-end-2026').valid, true);
  // One proper-noun hit is not enough; lowercase prose never counts.
  assert.equal(textMentionsShortTitle(`While Tru is an intimate portrait.${FILLER}`, 'Tru'), null);
  assert.equal(textMentionsShortTitle(`Ink stains, ink spills, ink everywhere.${FILLER}`.toLowerCase(), 'Ink'), null);
  assert.equal(textMentionsShortTitle(`Inkwell and Wittgenstein.${FILLER}`, 'Ink'), null);
});

test('common-word short titles are not on the proper-noun list', () => {
  const { textMentionsShortTitle } = require('./show-title-variants.js');
  const text = `Act One drags. Act Two soars. Red lights. Red curtains. Art Garfunkel. Art Deco. Six actors. Six songs.${FILLER}`;
  for (const t of ['The Act', 'Act', 'Red', 'Art', 'Six', 'SIX', 'Big', 'Ann']) assert.equal(textMentionsShortTitle(text, t), null, t);
});

// BRO-5261 retro-review of BRO-5222: the censored-word fold covers the other
// two words shows.json titles censor, and leaves plain asterisks alone.
test('normalizeForMention reads asterisk-censored s**t and c*ck titles as the full word', () => {
  assert.equal(normalizeForMention('Meat Suit, or the s**tshow of motherhood'), normalizeForMention('Meat Suit, or the Shitshow of Motherhood'));
  assert.equal(normalizeForMention('Jordan Gray: Is That A C*ck In Your Pocket'), 'jordan gray is that a cock in your pocket');
  assert.equal(normalizeForMention('sh*t happens'), 'shit happens');
  assert.equal(normalizeForMention('a * b'), 'a b');
  assert.ok(!normalizeForMention('**s**tar of the show').includes('shit'), 'Markdown bold is not a censor');
});

test('City Center "Encores!" series prefix: the bare show title is a variant (BRO-6744)', () => {
  const v = buildShowTitleVariants('Encores! The Wild Party');
  assert.ok(v.includes('the wild party') && v.includes('wild party'), JSON.stringify(v));
  assert.ok(buildShowTitleVariants('Encores! Off-Center: Assassins').includes('assassins'));
  assert.ok(textMentionsTitle('At City Center, The Wild Party swings hard.' + FILLER, 'Encores! The Wild Party'));
  // The series name alone is never a variant, and a title without the prefix is untouched.
  assert.ok(!buildShowTitleVariants('Encores! The Wild Party').includes('encores'));
  assert.ok(!buildShowTitleVariants('The Wild Party').some((x) => /encores/.test(x)));
});

test('textMentionsShortTitle allowUncurated counts short alpha titles only when asked (BRO-7077)', () => {
  const { textMentionsShortTitle: tm } = require('./show-title-variants');
  assert.equal(tm('Red is bold. RED again.', 'Red', 2), null, 'uncurated stays off by default');
  assert.equal(tm('Red is bold. RED again.', 'Red', 2, { allowUncurated: true }), 'red');
  assert.equal(tm('Red is bold.', 'Red', 2, { allowUncurated: true }), null, 'one hit is not two');
  assert.equal(tm('On March 13, then May 13.', '13', 2, { allowUncurated: true }), null, 'digits never count');
  assert.equal(tm('G and G.', 'G', 2, { allowUncurated: true }), null, 'single letters never count');
});

test('numeric titles count only when printed as a title, quoted or "N The Musical" (BRO-8092)', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const { textMentionsNumericTitle } = req('./show-title-variants.js');
  const { validateShowMentioned } = req('./content-quality.js');
  const pad = ' The cast sings the score with energy and the staging moves along briskly through both acts.'.repeat(3);
  // real shapes from data/review-texts/44-off-broadway-2025 and 13-2008
  assert.equal(textMentionsNumericTitle('Review: 44—The Musical has arrived Off-Broadway.', '44'), '44');
  assert.equal(textMentionsNumericTitle('since I was seeing “44 The Musical” on Election Day', '44'), '44');
  assert.equal(textMentionsNumericTitle('the musical “13,” the other Broadway show. When “13” ends its run', '13'), '13');
  assert.equal(textMentionsNumericTitle('“13: The Musical” is a Netflix film', '13'), '13');
  // bare numbers are dates, ages, counts: never a mention
  assert.equal(textMentionsNumericTitle('beginning February 13, 2009, the 13 actors and 44 minutes', '13'), null);
  assert.equal(textMentionsNumericTitle('the 44th president and $44 tickets', '44'), null);
  assert.equal(textMentionsNumericTitle('“44” appears', 'Hamilton'), null);
  // review findings: lowercase "musical director", minutes-seconds, hashtag
  assert.equal(textMentionsNumericTitle('He was 13 the musical prodigy; she was 13 — the musical director', '13'), null);
  assert.equal(textMentionsNumericTitle('running time 1\'44" total', '44'), null);
  assert.equal(textMentionsNumericTitle('#13 The Musical trends', '13'), null);
  // one quoted number is an age or score, not a title (Codex review)
  assert.equal(textMentionsNumericTitle("He turned '44' in May.", '44'), null);
  const { countNumericTitleMentions } = req('./show-title-variants.js');
  assert.equal(countNumericTitleMentions('“44” opened. “44” is a parody. 44—The Musical runs.', '44'), 3);
  const t0 = Date.now(); textMentionsNumericTitle('44' + ' '.repeat(50000) + 'x', '44');
  assert.ok(Date.now() - t0 < 200, 'no quadratic whitespace scan');
  assert.equal(textMentionsNumericTitle('librettist Robert Horn (13 the Musical, TV)', '13'), '13');
  assert.equal(validateShowMentioned('In “44 – The Musical” the president sings.' + pad, '44', '44-off-broadway-2025').valid, true);
  assert.equal(validateShowMentioned('On February 13 the 13 kids sang.' + pad, '13', '13-2008').valid, false);
});

// BRO-8100 class guard: a numeric-title review passes EVERY identity gate.
test('numeric title: one helper + every gate accepts a real numeric-title review', () => {
  const { textMentionsShowTitle, isNumericTitle } = require('./show-title-variants.js');
  const { validateContentMentionsShow } = require('./content-quality.js');
  const { headlineIdentity } = require('./gap-acceptance.js');
  for (const t of ['44', '13']) {
    const text = t + ' The Musical lands at the Public with real swagger. “' + t + '” is bold, and “' + t + '” earns it. ' + t + ' The Musical closes strong.' + FILLER.repeat(8);
    assert.ok(isNumericTitle(t));
    assert.ok(textMentionsShowTitle(text, t), 'helper ' + t);
    assert.equal(validateShowMentioned(text, t, t + '-off-broadway-2025').valid, true, 'validateShowMentioned ' + t);
    const r = validateContentMentionsShow(text, null, t, t + '-off-broadway-2025');
    assert.equal(r.valid, true, 'url-content-mismatch ' + t + ': ' + JSON.stringify(r));
    const bare = 'Opened ' + t + ' years ago, tickets cost USD ' + t + '.' + FILLER.repeat(8);
    assert.equal(textMentionsShowTitle(bare, t), null, 'bare ' + t);
    assert.equal(validateContentMentionsShow(bare, null, t, t + '-off-broadway-2025').valid, false, 'bare gate ' + t);
    const hl = headlineIdentity({ outletId: 'thestage', headline: t + ' The Musical review', show: { title: t, id: t + '-x-2025' }, showTitle: t });
    assert.equal(hl.ok, true, 'headline ' + t + ': ' + JSON.stringify(hl));
    // review-found false accepts (BRO-8100 codex/panelist)
    assert.equal(validateContentMentionsShow('The score was \u201c' + t + '\u201d to nothing. ' + FILLER.repeat(8), null, t, t + '-x-2025').valid, false, 'one quoted');
    assert.equal(textMentionsShowTitle('B' + t + ' The Musical is new.', t), null, 'letter prefix');
    assert.equal(headlineIdentity({ outletId: 'thestage', headline: t + ' shows to see this summer', show: { title: t, id: t + '-x-2025' }, showTitle: t }).ok, false, 'bare headline');
    assert.equal(validateContentMentionsShow('Tickets cost ' + t + ' dollars, ' + t + ' seats, ' + t + ' rows.' + FILLER.repeat(8), null, t + '!', t + '-x-2025').valid, false, 'punct title bare');
  }
});
