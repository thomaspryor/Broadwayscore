// BRO-7053: subject names that are also show titles must not mark a real review
// as multi-show junk. Requires the real detector (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectMultiShowContent, CURRENT_BROADWAY_SHOWS } = require('../../scripts/lib/content-quality.js');

const SHOW = 'speculations-off-west-end-2026';
const filler = 'The staging is spare and the cast of five holds the room for ninety minutes without a wasted gesture. ';

// Pick distinct, multi-letter single-word titles to play the "subject names".
const singleWord = CURRENT_BROADWAY_SHOWS.filter(t => /^[a-z]{6,}$/.test(t)).slice(0, 14);

function subjectReview(names) {
  // Each name recurs 6 times across the whole body, like Monroe/Kilgallen.
  let text = '';
  for (let round = 0; round < 6; round++) {
    text += names.map(n => `${n[0].toUpperCase()}${n.slice(1)} is pursued by the plot.`).join(' ') + ' ';
    // Uneven runs of prose between rounds, the way real mentions bunch up.
    for (let i = 0; i < [10, 3, 20, 7, 25, 10][round]; i++) text += filler;
  }
  return text;
}

test('subject names that are show titles, repeated through the body, are not multi-show', () => {
  assert.ok(singleWord.length >= 12, 'need enough single-word titles for the fixture');
  const text = subjectReview(singleWord);
  const result = detectMultiShowContent(text, SHOW);
  assert.equal(result.detected, false, JSON.stringify(result));
});

test('a listing page naming the same titles once each is still multi-show', () => {
  const text = 'More reviews this week: ' + singleWord.map(n => `${n[0].toUpperCase()}${n.slice(1)} - read the review.`).join(' ') + ' ' + filler.repeat(3);
  const result = detectMultiShowContent(text, SHOW);
  assert.equal(result.detected, true, JSON.stringify(result));
});

test('a card that repeats each title in a cluster (headline, link, alt) is still multi-show', () => {
  const text = singleWord.map(n => { const t = `${n[0].toUpperCase()}${n.slice(1)}`; return `${t} ${t} ${t} read more.`; }).join(' ') + ' ' + filler.repeat(3);
  const result = detectMultiShowContent(text, SHOW);
  assert.equal(result.detected, true, JSON.stringify(result));
});

test('nav header + one body card + footer nav repeating the same titles is still multi-show', () => {
  const cap = (n) => `${n[0].toUpperCase()}${n.slice(1)}`;
  const nav = singleWord.map(cap).join(' | ');
  const text = nav + ' ' + filler.repeat(8) + singleWord.map((n) => `${cap(n)} - a new review.`).join(' ') + ' ' + filler.repeat(8) + nav;
  const result = detectMultiShowContent(text, SHOW);
  assert.equal(result.detected, true, JSON.stringify({ n: result.showsFound.length, len: text.length }));
});

test('a schedule grid repeating each title down the page is still multi-show', () => {
  const cap = (n) => `${n[0].toUpperCase()}${n.slice(1)}`;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const text = days.map((d) => `${d}: ` + singleWord.map((n) => `${cap(n)} 7pm`).join(', ')).join('. ');
  const result = detectMultiShowContent(text, SHOW);
  assert.equal(result.detected, true, JSON.stringify({ n: result.showsFound.length, len: text.length }));
  const long = (text + ' ').repeat(3);
  assert.equal(detectMultiShowContent(long, SHOW).detected, true);
});
