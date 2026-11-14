// BRO-7491: the visual-approval email must be readable on a phone: one small working picture, a plain question,
// honest option copy, a short footer. Class guard: an email image over the size/height cap fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const link = require('../../src/lib/owner-decision-link.js');
const va = require('./visual-approval.js');
const { buildDecisionEmail } = require('./owner-decision-email.js');

const S = 'test-secret';
const SHA = 'a0e7b1d4c7a59b41192e4259625fd77e255ca9c3';
const base = `https://raw.githubusercontent.com/thomaspryor/Broadwayscore/${SHA}`;
const mk = (evidence) => va.buildBlock({ what: 'the rating panel that opens when you tap a show', patch: 'a'.repeat(40), verdict: 'b'.repeat(16), hold: 'visual-hold/bro-7', evidence });
const emailFor = (description) => {
  const q = link.markerLines(description)[0].question;
  return buildDecisionEmail({ decision: { identifier: 'BRO-7', title: 'Rating panel', url: 'https://linear.app/x', question: q }, description, secret: S });
};
const imgSrcs = (html) => [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

test('thumbnail of a 360 x 20,000 px full-page shot is a small JPEG under the caps', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'va-thumb-'));
  const src = path.join(dir, 'tall.png');
  await sharp({ create: { width: 360, height: 20000, channels: 3, background: '#223344' } })
    .composite([{ input: Buffer.from(Array.from({ length: 360 * 400 * 3 }, (_, i) => (i * 7919) % 251)), raw: { width: 360, height: 400, channels: 3 }, top: 100, left: 0 }])
    .png().toFile(src);
  const out = path.join(dir, va.thumbName('tall.png'));
  await va.makeEmailThumb(src, out);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.ok(statSync(out).size <= va.THUMB_MAX_BYTES, `thumb ${statSync(out).size} bytes`);
  assert.ok(meta.height <= va.THUMB_MAX_HEIGHT, `thumb height ${meta.height}`);
});

test('email shows one thumbnail image, at most two links, and the links open the full-size shot', () => {
  const ev = ['a', 'b', 'c', 'd'].map((n) => ({ label: `Shot ${n}`, url: `${base}/thumb_${n}.png.jpg` }));
  const { html } = emailFor(mk(ev));
  const imgs = imgSrcs(html);
  assert.equal(imgs.length, 1);
  assert.match(imgs[0], /\/thumb_[^/]+\.jpg$/);
  assert.ok(html.includes(`href="${base}/a.png"`), 'picture opens the full-size file');
  assert.equal((html.match(/Shot [a-d]<\/a>/g) || []).length, 2);
  assert.equal((link.parseDecisionBlock(mk(ev)).evidence || []).length, 3, 'card carries at most 3 shots');
});

test('class guard: every email image is a thumbnail JPEG, never a raw PNG screenshot', () => {
  const { html } = emailFor(mk([{ label: 'Browse 360', url: `${base}/thumb_browse_360.png.jpg` }]));
  for (const src of imgSrcs(html)) assert.match(src, /thumb_.+\.jpg$/, src);
});

test('question shows no ref hash, but the stored question and token hash are unchanged (old emails keep verifying)', () => {
  const d = mk([{ label: 'x', url: `${base}/thumb_x.png.jpg` }]);
  const stored = link.markerLines(d)[0].question;
  assert.match(stored, /\(ref [0-9a-f]{32}\)$/);
  const { html, subject, tokenHash } = emailFor(d);
  assert.doesNotMatch(html, /\bref [0-9a-f]{12,}/);
  assert.doesNotMatch(subject, /ref [0-9a-f]/);
  assert.match(html, /<h2[^>]*>Does the change to the rating panel that opens when you tap a show look right\?<\/h2>/);
  assert.equal(tokenHash, link.questionHash(stored));
  assert.ok(link.visualBindingFor(d, stored));
});

test('option copy has real upsides and downsides; recommendation says what was checked', () => {
  const { html } = emailFor(mk([]));
  assert.match(html, /Upside: the change goes live by itself in about 20 minutes/);
  assert.match(html, /Downside: if something looks off, it stays live until it is fixed/);
  assert.match(html, /Upside: nothing changes on the site/);
  assert.match(html, /Downside: the fix waits/);
  assert.doesNotMatch(html, /nothing else for you to do|in your own words<\/div>|Downside: tell me/);
  assert.match(html, /Approve, because the automatic visual check passed at phone, tablet and desktop widths/);
});

test('footer is one short line plus the list link', () => {
  const { html } = emailFor(mk([]));
  assert.doesNotMatch(html, /ANSWER:|record my answer/);
  assert.match(html, /See everything waiting on you/);
  assert.ok((html.match(/font-size:13px/g) || []).length <= 1);
});

test('whatProblem rejects jargon, semicolons, refs and too-short text; accepts a plain phrase', () => {
  assert.ok(va.whatProblem('show page rating panel and watchlist plan sheet now load on demand code splitting ; no visual change'));
  assert.ok(va.whatProblem('the header (ref 68ae830c)'));
  assert.ok(va.whatProblem('hydration fix on the home page'));
  assert.ok(va.whatProblem('header'));
  assert.ok(va.whatProblem('the header with no visual change'));
  assert.equal(va.whatProblem('the star rating panel on a show page'), null);
  assert.equal(va.whatProblem('the score badge next to each show title'), null);
});

test('cropCoverageProblem: whole-page shots alone are refused, an element crop passes', () => {
  assert.ok(va.cropCoverageProblem(['a/browse_west_end_shows_360.png', 'a/show_hamilton_1440.png']));
  assert.equal(va.cropCoverageProblem(['a/show_hamilton__rating-panel_360.png']), null);
});

test('fullUrlForThumb maps a thumbnail back to its original, and ignores non-thumbnails', () => {
  assert.equal(va.fullUrlForThumb(`${base}/thumb_a.png.jpg`), `${base}/a.png`);
  assert.equal(va.fullUrlForThumb(`${base}/a.png`), null);
});

test('flatName keeps the extension when it cuts a long name, so the thumbnail maps back to the full shot', () => {
  const f = va.flatName('d', `d/${'x'.repeat(200)}.png`);
  assert.ok(f.endsWith('.png') && f.length <= 120);
  assert.equal(va.fullUrlForThumb(`${base}/${va.thumbName(f)}`), `${base}/${f}`);
  assert.equal(va.labelFor(va.thumbName('show_hamilton_360.png')), 'show hamilton 360');
});

test('plain words that merely look technical are accepted in --what', () => {
  assert.equal(va.whatProblem('the fallback poster image on a show card'), null);
  assert.equal(va.whatProblem('the props gallery on the show page'), null);
});

