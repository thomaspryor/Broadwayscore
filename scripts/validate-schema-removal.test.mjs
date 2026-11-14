/**
 * BRO-5967 acceptance check: the JSON-LD generators must not emit markup that
 * breaks Google's review-snippet policy. Reads the generator source, so it runs
 * under plain `node --test` with no TypeScript loader. Behavior tests live in
 * tests/unit/seo-review-snippet-policy.test.mjs (tsx manifest).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const seo = read('src/lib/seo.ts');

function body(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);
  const end = src.indexOf(endMarker, start + startMarker.length);
  return src.slice(start, end > start ? end : undefined);
}

test('no per-critic Review nodes with a site-assigned reviewRating', () => {
  assert.ok(!/reviewRating/.test(seo), 'reviewRating must not appear in src/lib/seo.ts');
  assert.ok(!/export function generateCriticReviewsSchema/.test(seo));
  assert.ok(!/generateCriticReviewsSchema/.test(read('src/app/show/[slug]/page.tsx')));
});

test('ItemList items carry no aggregateRating', () => {
  const list = body(seo, 'export function generateItemListSchema', '\nexport function ');
  assert.ok(!/aggregateRating\s*[:=]/.test(list), 'generateItemListSchema must not set aggregateRating');
});

test('show-level aggregateRating on TheaterEvent is kept', () => {
  const show = body(seo, 'export function generateShowSchema', '\nexport function ');
  assert.match(show, /schema\.aggregateRating\s*=/);
});

test('EventScheduled is dropped for closed or ended runs', () => {
  const helper = body(seo, 'export function eventStatusField', '\n}\n');
  assert.match(helper, /closed/);
  assert.match(helper, /EventScheduled/);
  // Remaining literals: tour stops (already filtered to end >= today) and a theater's currentShow.
  const tour = body(seo, 'export function tourSubEvents', '\nexport function ');
  assert.match(tour, /filter\(s => s\.end >= today\)/);
  assert.match(body(seo, 'export function generateShowSchema', '\nexport function '), /eventStatusField\(/);
  assert.match(body(seo, 'export function generateItemListSchema', '\nexport function '), /eventStatusField\(/);
});

test('editorial reviews omit eventStatus for attended performances', () => {
  const review = body(read('src/app/reviews/[slug]/page.tsx'), 'const reviewSchema = {', '\n  const breadcrumbSchema');
  assert.doesNotMatch(review, /eventStatus\s*:/);
});

test('Offers are only emitted with a real price', () => {
  assert.ok(!/price:\s*null/.test(seo));
  assert.match(seo, /filter\(link => link\.priceFrom\)/);
  const guides = read('src/app/guides/[slug]/page.tsx');
  assert.match(guides, /primaryTicket\?\.priceFrom/);
});
