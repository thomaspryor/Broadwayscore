// Week voice (BRO-3921) — the owner-approved subject/lede drafts from three
// real 2026 weeks, plus the lead rule (most reviews, then score) that decides
// which show they name first. Imports the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeWeekVoice } from './week-voice.mjs';
import { scoreCandidates } from './newsworthiness.mjs';
import { createRequire } from 'node:module';
const { compareOpeningStories, sortOpeningStoriesByNewsworthiness } = createRequire(import.meta.url)('../lib/opening-story-order.js');

const o = (title, raw, count, extra = {}) => ({
  show: { id: title.toLowerCase().replace(/\W+/g, '-'), slug: title.toLowerCase().replace(/\W+/g, '-'), title, category: extra.category || 'broadway' },
  agg: { raw, avg: Math.round(raw), count },
  ...extra,
});
const plain = (s) => s.replace(/<[^>]+>/g, '');

test('busy Broadway week (Apr 20): count in subject, packed opener, tie and the miss', () => {
  const v = composeWeekVoice({ bw: [
    o('Schmigadoon!', 79.2, 40), o("Joe Turner's Come and Gone", 78.8, 35), o('The Balusters', 79.1, 30),
    o('The Lost Boys', 70, 28), o('Some Show', 66, 20), o('Beaches', 44, 18),
  ] });
  assert.equal(v.subject, 'Schmigadoon! and 5 other shows open on Broadway this week');
  assert.equal(plain(v.sentences.join(' ')),
    "A packed week on Broadway, with six openings. Schmigadoon! opens to strong reviews, tied at 79 with Joe Turner's Come and Gone and The Balusters. Beaches lands at 44.");
  assert.deepEqual(v.showRefs.map(r => r.title), ['Schmigadoon!', "Joe Turner's Come and Gone", 'The Balusters', 'Beaches']);
});

test('Off-Broadway week (Aug 10): a weak most-reviewed lead never claims the best reviews', () => {
  const ob = (t, s, c) => o(t, s, c, { category: 'off-broadway' });
  const v = composeWeekVoice({ ob: [ob('An American Daughter', 47, 22), ob('Benevolent', 84, 9), ob("The Winter's Tale", 80, 8), ob('Marlise', 70, 5)] });
  assert.equal(v.subject, 'An American Daughter and 3 other shows open off-Broadway this week');
  assert.equal(plain(v.sentences.join(' ')),
    "A steady week for Off Broadway. An American Daughter draws the most reviews and a weak 47. Benevolent (84) and The Winter's Tale (80) are the ones to see.");
});

test('slow week (Aug 24): quiet-week subject, both markets named', () => {
  const v = composeWeekVoice({
    bw: [o('Paranormal Activity', 77.57, 30)],
    ob: [o('The Real Ivanov', 53, 6, { category: 'off-broadway' })],
  });
  assert.equal(v.subject, 'Paranormal Activity opens on Broadway in a quiet week');
  assert.equal(plain(v.sentences.join(' ')),
    'A slow week in New York, with just two openings. Paranormal Activity opens on Broadway to strong reviews (78). Off Broadway, The Real Ivanov lands at 53.');
});

test('a long lead title falls back to a shorter subject instead of cutting mid-word', () => {
  const v = composeWeekVoice({
    bw: [o('School Girls; Or, The African Mean Girls Play', 84, 30)],
    ob: [1, 2, 3, 4, 5].map(i => o(`OB ${i}`, 80 - i, 10 - i, { category: 'off-broadway' })),
  });
  assert.equal(v.subject, 'School Girls; Or, The African Mean Girls Play opens on Broadway this week');
  assert.ok(v.subject.length <= 80);
  assert.match(plain(v.sentences[0]), /^A busy week in New York, with six openings\.$/);
  assert.match(plain(v.sentences.at(-1)), /^Off Broadway, five shows opened, led by OB 1 \(79\)\.$/);
});

test('calendar counts keep "slow week" / "N other shows" true when some openings are too thinly reviewed to name', () => {
  const v = composeWeekVoice({ bw: [o('Big Show', 80, 30)], counts: { bw: 3, ob: 0 } });
  assert.equal(v.subject, 'Big Show and 2 other shows open on Broadway this week');
  assert.doesNotMatch(plain(v.sentences.join(' ')), /slow week|just one/);
});

test('"draws the most reviews" is only said when strictly true (count tie → plain grade)', () => {
  const ob = (t, s, c) => o(t, s, c, { category: 'off-broadway' });
  const v = composeWeekVoice({ ob: [ob('Tied Lead', 50, 10), ob('Tied Other', 48, 10)] });
  const text = plain(v.sentences.join(' '));
  assert.doesNotMatch(text, /most reviews/);
  assert.match(text, /Tied Lead opens off-Broadway to a weak 50\./);
});

test('Free Shakespeare in the Park is never called off-Broadway', () => {
  const sitp = o('Twelfth Night', 82, 20, { category: 'off-broadway' });
  sitp.show.venue = 'Delacorte Theater';
  const w = composeWeekVoice({ ob: [sitp] });
  assert.equal(w.subject, 'Twelfth Night opens at Free Shakespeare in the Park in a quiet week');
  assert.doesNotMatch(w.subject + plain(w.sentences.join(' ')), /off-Broadway|Off Broadway/);
});

test('sentences are plain text (generate.mjs italicizes; the preheader must stay tag-free)', () => {
  const v = composeWeekVoice({ bw: [o('Paranormal Activity', 77.57, 30)], ob: [o('The Real Ivanov', 53, 6, { category: 'off-broadway' })] });
  assert.ok(v.sentences.every(s => !/[<>]/.test(s)));
});

test('no scored New York opening → null (caller keeps the old subject)', () => {
  assert.equal(composeWeekVoice({ bw: [], ob: [] }), null);
});

test('lead rule: most reviews first, then score — never a thinly reviewed gold show', () => {
  const marquee = { raw: 72, avg: 72, count: 30 };
  const small = { raw: 91, avg: 91, count: 6 };
  assert.ok(compareOpeningStories(marquee, small) < 0);
  assert.ok(compareOpeningStories({ raw: 80, count: 10 }, { raw: 70, count: 10 }) < 0);
  assert.deepEqual(sortOpeningStoriesByNewsworthiness([small, marquee], x => x), [marquee, small]);
});

test('subject scorer keeps input (most-reviewed) order even when a later show is gold', () => {
  const shows = { marquee: { id: 'm', slug: 'm', title: 'Marquee', category: 'broadway' }, small: { id: 's', slug: 's', title: 'Small', category: 'broadway' }, ob: { id: 'g', slug: 'g', title: 'OB Gold', category: 'off-broadway' } };
  const scores = { m: 72, s: 91, g: 95 };
  const c = scoreCandidates({
    bwOpenings: [{ show: shows.marquee }, { show: shows.small }],
    obOpenings: [{ show: shows.ob }],
    aggregateScore: (id) => ({ avg: scores[id] }),
  });
  assert.deepEqual(c.filter(x => /opening/.test(x.kind)).map(x => x.show.id), ['m', 's', 'g']);
  assert.equal(c[0].show.id, 'm');
});

test('a gold second opening still lifts the week above a score mover (the lead is never pushed down)', () => {
  const lead = { id: 'l', slug: 'l', title: 'Lead', category: 'off-broadway' };
  const gold = { id: 'g', slug: 'g', title: 'Gold', category: 'off-broadway' };
  const mover = { id: 'mv', slug: 'mv', title: 'Mover', category: 'broadway' };
  const scores = { l: 70, g: 92 };
  const c = scoreCandidates({
    obOpenings: [{ show: lead }, { show: gold }],
    topMover: { show: mover, before: 70, after: 73, delta: 3 },
    aggregateScore: (id) => ({ avg: scores[id] }),
  });
  assert.deepEqual(c.slice(0, 3).map(x => x.show.id), ['l', 'g', 'mv']);
});
