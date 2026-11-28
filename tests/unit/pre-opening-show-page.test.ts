/**
 * Pre-opening show page (BRO-7426). Owner report on Galileo in previews: the
 * desktop hero left a wide empty column beside the poster, a centered
 * "Awaiting reviews" box sat between left-aligned blocks, the predictor mixed
 * centered and left text, and nothing about the show (cast, creative team,
 * earlier productions) appeared until far down the page. Calls the real
 * helpers (CLAUDE.md rule 15) and pins the layout contract in the components.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isPreOpeningStatus } from '../../src/lib/pre-opening';
import { principalsFirst, isSupportingRole } from '../../src/lib/cast-order';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

test('isPreOpeningStatus: previews, upcoming, announced only', () => {
  for (const s of ['previews', 'upcoming', 'announced']) assert.equal(isPreOpeningStatus(s), true, s);
  for (const s of ['open', 'closed', '', null, undefined]) assert.equal(isPreOpeningStatus(s), false, String(s));
});

test('principalsFirst puts named roles before ensemble, swings, understudies (Galileo order)', () => {
  const cast = [
    { name: 'Bradley Dean', role: 'Bishop Grasso' },
    { name: 'Gabrielle Elisabeth', role: 'Ensemble' },
    { name: 'Raúl Esparza', role: 'Galileo Galilei' },
    { name: 'Swing Person', role: 'Swing' },
    { name: 'Alt Person', role: 'Galileo Galilei', flags: ['Alternate'] },
    { name: 'Jeremy Kushnier', role: 'Bishop Maffeo Barberini' },
  ];
  assert.deepEqual(principalsFirst(cast).map(m => m.name), [
    'Bradley Dean', 'Raúl Esparza', 'Jeremy Kushnier', 'Gabrielle Elisabeth', 'Swing Person', 'Alt Person',
  ]);
  assert.equal(isSupportingRole('Understudy for Galileo'), true);
  assert.equal(isSupportingRole('Dance Captain'), true);
  // Review follow-up: a character named for a swing, and a split role with a named part, stay principal.
  assert.equal(isSupportingRole('Girl on a Swing'), false);
  assert.equal(isSupportingRole('Sayu / Ensemble'), false);
  assert.equal(isSupportingRole('Dance Captain / Swing'), true);
  assert.equal(isSupportingRole('Swing'), true);
  assert.equal(isSupportingRole('Sister Celeste'), false);
  // Does not mutate the input.
  assert.equal(cast[1].name, 'Gabrielle Elisabeth');
});

test('hero: pre-opening drops the centered Awaiting box and fills the column beside the poster', () => {
  const hero = read('src/components/show-page/ShowHeroRedesign.tsx');
  assert.match(hero, /preOpening \? null : !hasEnoughCriticReviews \? \(\s*<AwaitingCard/, 'pre-opening must not render AwaitingCard');
  assert.match(hero, /\{preOpening && \(\s*<PreOpeningReviewStatus/, 'review status line lives in the title column');
  assert.match(hero, /preOpening \? 'lg:relative lg:pl-\[[^\]]+\][^']*'/, 'desktop pins the poster and indents the stack beside it');
  assert.match(hero, /preOpening \? 'lg:absolute lg:left-5 lg:top-5' : ''/);
  assert.match(hero, /preOpening \? 'lg:contents' : ''/);
});

test('predictor is left-aligned: no text-center or justify-center in CallTheScore', () => {
  const src = read('src/components/show-page/CallTheScore.tsx');
  const body = src.slice(src.indexOf('export default function CallTheScore'), src.indexOf('export function CallResultStrip'));
  assert.doesNotMatch(body, /text-center|justify-center/, 'mixed alignment came back in the predictor');
});

test('below the fold: show info leads and empty placeholder cards are skipped before opening', () => {
  const bf = read('src/components/show-page/ShowPageBelowFold.tsx');
  const ret = bf.indexOf('  return (\n    <>');
  assert.ok(ret > 0);
  const top = bf.slice(ret, ret + 200);
  assert.match(top, /\{preOpening && castAndCreative\}\s*\{preOpening && otherProductionsEl\}/, 'cast, creative team and other productions must render first pre-opening');
  for (const h of ['Audience Grade', 'Box Office', 'Profitability Scorecard']) {
    const i = bf.indexOf(`>${h}</h2>`);
    assert.ok(i > 0, h);
    assert.match(bf.slice(i - 400, i), /!preOpening && \(show\.status === 'previews'/, `${h} placeholder must be skipped pre-opening`);
  }
});

test('cast: one "Cast" list before opening instead of Current Cast + Original Cast twice', () => {
  const src = read('src/components/CastSection.tsx');
  assert.match(src, /const singleList = isOpen && isPreOpeningStatus\(showStatus\)/);
  assert.match(src, /\{hasOBC && !singleList && \(/);
  assert.match(src, /principalsFirst\(cast\)/);
});

test('credits read the role words our data uses (Composer, Lyricist, Book writer)', async () => {
  const { getCreditSentences } = await import('../../src/lib/show-credits');
  const out = getCreditSentences({ title: 'Some Show', creativeTeam: [
    { name: 'Ann Book', role: 'Book writer' }, { name: 'Cal Tune', role: 'Composer' }, { name: 'Lee Word', role: 'Lyricist' },
    { name: 'Max Both', role: 'Composer and Lyricist' }, { name: 'Dee Dance', role: 'Book & Choreography' },
  ] });
  assert.deepEqual(out, ['Book by Ann Book and Dee Dance.', 'Music by Cal Tune and Max Both.', 'Lyrics by Lee Word and Max Both.']);
  assert.deepEqual(getCreditSentences({ title: 'Chicago', creativeTeam: [{ name: 'John Kander', role: 'Music' }, { name: 'Fred Ebb', role: 'Book & Lyrics' }, { name: 'Bob Fosse', role: 'Book' }] }), ['Book by Fred Ebb and Bob Fosse.', 'Music by John Kander.', 'Lyrics by Fred Ebb.'], 'co-writers share one sentence');
});

test('credits: plays, slash and combined roles, no long-runner stars (ship-check BRO-7426)', async () => {
  const { getCreditSentences } = await import('../../src/lib/show-credits');
  assert.deepEqual(getCreditSentences({ title: 'The Mousetrap', type: 'play', creativeTeam: [{ name: 'Agatha Christie', role: 'Book' }] }), ['Written by Agatha Christie.']);
  assert.deepEqual(getCreditSentences({ title: 'X', type: 'musical', creativeTeam: [
    { name: 'Ann Smith', role: 'Book/Music/Lyrics' }, { name: 'Bo Lee', role: 'Writer & Director' }, { name: 'Cy Day', role: 'Co-Director' },
    { name: 'Di Fox', role: 'Director & Choreographer' }, { name: 'Ed Ray', role: 'Music Supervisor' },
  ] }), ['Written by Bo Lee.', 'Book, music and lyrics by Ann Smith.', 'Directed by Bo Lee, Cy Day and Di Fox.']);
  assert.deepEqual(getCreditSentences({ title: 'Chicago', castBilling: ['Reece Weaver', 'Lissa deGuzman'], openingCastIsCurrent: false, creativeTeam: [] }), [], 'no Starring from a long-runner billing list');
});

test('other productions stay out of the hero card (owner call, BRO-7426)', () => {
  const hero = readFileSync(path.join(process.cwd(), 'src/components/show-page/ShowHeroRedesign.tsx'), 'utf8');
  assert.doesNotMatch(hero, /other-productions|OtherProduction/i, 'the owner asked for other productions below the fold only');
  const fold = readFileSync(path.join(process.cwd(), 'src/components/show-page/ShowPageBelowFold.tsx'), 'utf8');
  assert.match(fold, /id="other-productions"/);
});

test('About credits come from our own data and never guess a star (BRO-7426)', async () => {
  const { getCreditSentences, titleRoleStar } = await import('../../src/lib/show-credits');
  const galileo = {
    title: 'Galileo',
    creativeTeam: [
      { name: 'Danny Strong', role: 'Book' }, { name: 'Zoe Sarnak', role: 'Music & Lyrics' },
      { name: 'Michael Weiner', role: 'Music & Lyrics' }, { name: 'Michael Mayer', role: 'Director' },
    ],
    openingCast: [{ name: 'Bradley Dean', role: 'Bishop Grasso' }, { name: 'Raúl Esparza', role: 'Galileo Galilei' }, { name: 'Raúl Esparza', role: 'Galileo Galilei' }],
    openingCastIsCurrent: true,
  };
  assert.equal(getCreditSentences(galileo).join(' '), 'Starring Raúl Esparza. Book by Danny Strong. Music and lyrics by Zoe Sarnak and Michael Weiner. Directed by Michael Mayer.');
  assert.equal(getCreditSentences({ ...galileo, openingCastIsCurrent: false })[0], 'Book by Danny Strong.', 'an old opening cast is not today\'s cast');
  assert.equal(getCreditSentences({ ...galileo, castBilling: ['A One', 'B Two', 'C Three'] })[0], 'Starring A One and B Two.', 'billing order wins');
  const lmm = [{ name: 'Lin-Manuel Miranda', role: 'Book' }, { name: 'Lin-Manuel Miranda', role: 'Music & Lyrics' }];
  assert.deepEqual(getCreditSentences({ title: 'Hamilton', creativeTeam: lmm }), ['Book, music and lyrics by Lin-Manuel Miranda.']);
  assert.deepEqual(getCreditSentences({ title: 'X', creativeTeam: [{ name: '{{plainlist | A B', role: 'Music' }, { name: 'Arthur Miller', role: 'Playwright' }] }), ['Written by Arthur Miller.'], 'markup names are dropped');
  assert.equal(titleRoleStar('Aladdin', [{ name: 'A', role: 'Aladdin' }, { name: 'B', role: 'Aladdin' }]), null, 'two people in the title role: no single star');
  assert.equal(titleRoleStar('Aladdin', [{ name: 'Adam Jacobs', role: 'Aladdin' }, { name: 'Ben Alt', role: 'Aladdin', flags: ['Alternate'] }]), 'Adam Jacobs');
  assert.equal(titleRoleStar('The Rocky Horror Show', [{ name: 'A', role: 'Rocky' }]), null, 'role must carry every title word');
});
