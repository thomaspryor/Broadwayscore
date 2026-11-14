// BRO-4597: phone-shaped screenshot clipping for the Reddit post email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { clipRect, cleanCut, MAX_ASPECT, captureShowImages, SHOTS } = require('./reddit-post-screenshots.js');

test('a short card is padded and kept whole', () => {
  const c = clipRect({ x: 16, y: 100, width: 398, height: 300 }, 430);
  assert.deepEqual(c, { x: 4, y: 88, width: 422, height: 324 });
});

test('padding never leaves the page', () => {
  const c = clipRect({ x: 0, y: 0, width: 430, height: 200 }, 430);
  assert.equal(c.x, 0);
  assert.equal(c.y, 0);
  assert.equal(c.width, 430);
});

test('a tall card ends in a gap between sections, never through text', () => {
  const box = { x: 16, y: 100, width: 398, height: 1400 };
  const blocks = [
    { top: 100, bottom: 300 }, { top: 310, bottom: 420 },
    { top: 470, bottom: 560 }, // gap 420..470
    { top: 600, bottom: 900 }, // gap 560..600
    { top: 905, bottom: 1400 },
  ];
  const c = clipRect(box, 430, { blocks });
  assert.ok(c.height / c.width <= MAX_ASPECT + 1e-9, 'within 4:5');
  assert.equal(c.y + c.height, 580, 'cut at the midpoint of the lowest gap that fits');
});

test('no clean gap: falls back to the 4:5 limit', () => {
  const c = clipRect({ x: 16, y: 0, width: 398, height: 2000 }, 430, { blocks: [{ top: 0, bottom: 2000 }] });
  assert.equal(c.height, Math.floor(c.width * MAX_ASPECT));
});

test('a gap too near the top is ignored (would leave a tiny image)', () => {
  const blocks = [{ top: 0, bottom: 40 }, { top: 100, bottom: 2000 }];
  const c = clipRect({ x: 16, y: 0, width: 398, height: 2000 }, 430, { blocks });
  assert.equal(c.height, Math.floor(c.width * MAX_ASPECT));
});

test('cleanCut: overlapping blocks are not a gap; small gaps are ignored', () => {
  assert.equal(cleanCut([{ top: 0, bottom: 100 }, { top: 50, bottom: 200 }, { top: 210, bottom: 300 }], 1000), null, '10px gap < minGap');
  assert.equal(cleanCut([{ top: 0, bottom: 100 }, { top: 50, bottom: 200 }, { top: 240, bottom: 300 }], 1000), 220);
  assert.equal(cleanCut([{ top: 0, bottom: 100 }, { top: 200, bottom: 300 }], 120), null, 'gap midpoint below the limit');
  assert.equal(cleanCut([], 1000), null);
});

test('captureShowImages never throws: a broken browser gives no images', async () => {
  const logs = [];
  const chromium = { launch: async () => { throw new Error('no browser here'); } };
  const out = await captureShowImages('http://example.invalid', '/tmp/x-shots', { chromium, log: m => logs.push(m) });
  assert.deepEqual(out, []);
  assert.match(logs.join('\n'), /screenshots skipped \(no browser here\)/);
});

// BRO-4613: a stand-in browser that records styles added/removed and screenshots taken.
function fakeBrowser({ missing = [], failing = [] } = {}) {
  const styles = new Map();
  const shots = [];
  let n = 0;
  const el = sel => ({
    first: () => el(sel),
    count: async () => (missing.includes(sel) ? 0 : 1),
    waitFor: async () => { if (failing.includes(sel) || missing.includes(sel)) throw new Error(`waitFor timeout ${sel}`); },
    scrollIntoViewIfNeeded: async () => {},
    evaluate: async () => ({ box: { x: 0, y: 0, width: 430, height: 300 }, blocks: [] }),
  });
  const page = {
    goto: async () => {}, waitForTimeout: async () => {}, evaluate: async () => {},
    locator: el,
    addStyleTag: async ({ content }) => { const id = n++; styles.set(id, content); return { evaluate: async () => styles.delete(id) }; },
    screenshot: async ({ path }) => { shots.push({ path, live: [...styles.values()] }); },
  };
  const chromium = { launch: async () => ({ newContext: async () => ({ newPage: async () => page }), close: async () => {} }) };
  return { chromium, styles, shots };
}

test('SHOTS: scorecard, compact review list, audience card (optional)', () => {
  assert.deepEqual(SHOTS.map(s => s.name), ['scorecard.png', 'reviews.png', 'audience.png']);
  const reviews = SHOTS.find(s => s.name === 'reviews.png');
  assert.match(reviews.css, /\[class\*="pl-24"\] > p/, 'pull quotes hidden so many rows fit');
  assert.doesNotMatch(reviews.css, /\[class\*="pl-24"\]\s*[,{]/, 'the whole indented block would also hide the "earlier run" tag');
  assert.equal(SHOTS.find(s => s.name === 'audience.png').optional, true);
  // Placeholders ("Audience data will be added", "Reviews coming after press night") never match.
  assert.match(SHOTS.find(s => s.name === 'audience.png').selector, /audience-scorecard-heading/);
  assert.match(reviews.selector, /:has\(article\)/);
});

// The selectors and hide rules lean on site markup. A component change would
// not crash the capture, it would silently drop an image or bring the quotes
// back, so fail here instead.
test('site markup still carries what the screenshot selectors rely on', () => {
  const read = p => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
  const page = read('src/app/show/[slug]/page.tsx');
  const list = read('src/components/ReviewsList.tsx');
  const audience = read('src/components/AudienceBuzzCard.tsx');
  assert.match(page, /id="critic-reviews"/);
  assert.match(list, /<article\b/, 'review rows are <article>s');
  assert.match(list, /<p className="[^"]*\bleading-snug\b/, 'pull quote <p> has leading-snug');
  assert.match(list, /className="pl-24\b/, 'quote + byline block has pl-24');
  assert.match(list, /priorRunLabel && \(\s*<span/, '"earlier run" tag is a <span>, so the > p / > div rules keep it');
  assert.match(audience, /aria-labelledby="audience-scorecard-heading"/);
});

test('a page without an audience card still gets the other two images', async () => {
  const audience = SHOTS.find(s => s.name === 'audience.png').selector;
  const fb = fakeBrowser({ missing: [audience] });
  const logs = [];
  const out = await captureShowImages('http://x', '/tmp/x-shots', { chromium: fb.chromium, log: m => logs.push(m) });
  assert.deepEqual(out.map(o => o.name), ['scorecard.png', 'reviews.png']);
  assert.match(logs.join('\n'), /audience\.png skipped \(not on this page\)/);
});

test('a shot css applies to that shot only, and is removed even when the shot fails', async () => {
  const reviews = SHOTS.find(s => s.name === 'reviews.png');
  const ok = fakeBrowser();
  await captureShowImages('http://x', '/tmp/x-shots', { chromium: ok.chromium, log: () => {} });
  const live = Object.fromEntries(ok.shots.map(s => [s.path.split('/').pop(), s.live]));
  assert.ok(live['reviews.png'].includes(reviews.css));
  assert.ok(!live['audience.png'].includes(reviews.css), 'review css leaked into the audience shot');

  const bad = fakeBrowser({ failing: [reviews.selector] });
  const out = await captureShowImages('http://x', '/tmp/x-shots', { chromium: bad.chromium, log: () => {} });
  assert.deepEqual(out.map(o => o.name), ['scorecard.png', 'audience.png']);
  assert.ok(![...bad.styles.values()].includes(reviews.css), 'review css left on the page after a failure');
});
