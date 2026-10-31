// Tests for scripts/lib/bww-thumb-pairing.js (BRO-5674). Requires the real module.
// Run: node --test scripts/lib/bww-thumb-pairing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractBwwThumbIcons, pairBwwThumbsByCritic } = require('./bww-thumb-pairing.js');

const icon = (f) => `<p><img alt="x" src="https://cloudimages.broadwayworld.com/${f}?width=800" srcset="https://c/${f}?w=400 400w, https://c/${f}?w=800 800w, https://c/${f}?w=1200 1200w" style="float:left">`;
const entry = (f, critic, outlet) => `${icon(f)}${critic}, <a href="https://x">${outlet}</a>: excerpt text.</p>`;

test('one icon per <img> (srcset repeats collapse), lead text captured', () => {
  const html = entry('uptrans2.png', 'Aramide Tinubu', 'Variety') + '<img src="/logo.png">' + entry('middletrans2.png', 'Adam Feldman', 'Time Out');
  const icons = extractBwwThumbIcons(html);
  assert.deepEqual(icons.map(i => i.thumb), ['Up', 'Meh']);
  assert.ok(icons[0].lead.startsWith('aramide tinubu variety'));
  assert.deepEqual(extractBwwThumbIcons(''), []);
});

test('pairs by critic name, not by order (ODC 2026: JSON-LD order != page order, trailing Average Rating icon)', () => {
  const html = entry('middletrans2.png', 'Helen Shaw', 'New York Times')
    + entry('uptrans2.png', 'Aramide Tinubu', 'Variety')
    + entry('middletrans2.png', 'Adam Feldman', 'TimeOut New York')
    + entry('uptrans2.png', 'Juan A. Ramírez', 'The Guardian')
    + `${icon('middletrans2.png')}Average Rating: 70.0%</p>`;
  const reviews = [
    { criticName: 'Adam Feldman' }, { criticName: 'Aramide Tinubu' },
    { criticName: 'Juan A. Ramirez' }, { criticName: 'Helen Shaw' },
    { criticName: 'Unknown' }, { criticName: null }, { criticName: 'Madonna' },
  ];
  assert.deepEqual(pairBwwThumbsByCritic(extractBwwThumbIcons(html), reviews), ['Meh', 'Up', 'Up', 'Meh', null, null, null]);
});

test('ambiguous name (two icons) gets no thumb', () => {
  const html = entry('uptrans2.png', 'Frank Scheck', 'NYSR') + entry('downtrans2.png', 'Frank Scheck', 'THR');
  assert.deepEqual(pairBwwThumbsByCritic(extractBwwThumbIcons(html), [{ criticName: 'Frank Scheck' }]), [null]);
});

test('legacy BigThumbs filenames', () => {
  const html = '<img src="/BigThumbs_MEH.gif"> Jane Doe, Outlet: x <img src="/BigThumbs_DOWN.png"> John Roe, Other: y';
  assert.deepEqual(pairBwwThumbsByCritic(extractBwwThumbIcons(html), [{ criticName: 'John Roe' }, { criticName: 'Jane Doe' }]), ['Down', 'Meh']);
});

test('gather-reviews never assigns bwwThumb by index', () => {
  const src = fs.readFileSync(new URL('../gather-reviews.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('reviews[i].bwwThumb = thumbMatches[i]'));
  assert.ok(src.includes('pairBwwThumbsByCritic(thumbIcons, reviews)'));
});

test('no names after any icon: order fallback only on exact count (Average Rating set aside)', () => {
  const bare = (f) => `<img src="https://c/${f}"><p><a href="u">Outlet review</a></p>`;
  const html = bare('uptrans2.png') + bare('middletrans2.png') + `<img src="https://c/downtrans2.png"><p>Average Rating: 60%</p>`;
  const icons = extractBwwThumbIcons(html);
  assert.deepEqual(pairBwwThumbsByCritic(icons, [{ criticName: 'A B' }, { criticName: 'C D' }]), ['Up', 'Meh']);
  assert.deepEqual(pairBwwThumbsByCritic(icons, [{ criticName: 'A B' }, { criticName: 'C D' }, { criticName: 'E F' }]), [null, null, null]);
});

test('HTML entities decode before matching; whole-word names; agreeing duplicates accepted', () => {
  const html = entry('uptrans2.png', 'Aidan O&#039;Connor', 'BroadwayWorld')
    + entry('middletrans2.png', 'Ren&eacute;e Smith', 'Outlet')
    + entry('downtrans2.png', 'Bob Smithson', 'X')
    + entry('uptrans2.png', 'Thom Geier', 'NYTG') + entry('uptrans2.png', 'Thom Geier', 'Culture Sauce');
  const icons = extractBwwThumbIcons(html);
  assert.deepEqual(pairBwwThumbsByCritic(icons, [
    { criticName: "Aidan O'Connor" }, { criticName: 'Renée Smith' }, { criticName: 'Bob Smith' },
    { criticName: 'Thom Geier' }, { criticName: 'Thom Geier' },
  ]), ['Up', 'Meh', null, 'Up', 'Up']);
});

test('order fallback refuses lists with Method 2/3 entries', () => {
  const bare = (f) => `<img src="https://c/${f}"><p><a href="u">Outlet review</a></p>`;
  const icons = extractBwwThumbIcons(bare('uptrans2.png') + bare('middletrans2.png'));
  assert.deepEqual(pairBwwThumbsByCritic(icons, [{ criticName: 'A B', source: 'bww-roundup' }, { criticName: 'C D', source: 'bww-roundup-domain-supplement' }]), [null, null]);
});
