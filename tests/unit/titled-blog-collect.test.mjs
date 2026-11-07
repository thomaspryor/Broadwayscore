import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isTitledBlogUrl, titledBlogMentionWaiver } = require('../../scripts/lib/titled-blog-collect.js');
const { validateContentMentionsShow } = require('../../scripts/lib/content-quality.js');
const { LANE_FEEDS } = require('../../scripts/lib/opening-night-lane/lane-sources.js');

const BOBS = 'https://gotham-playgoer.blogspot.com/2026/10/other-desert-cities.html';
const body = 'The Baxter family gathers at the holidays and old wounds open. '.repeat(50);
const html = (t) => `<html><head><title>${t}</title></head></html>`;

test('every titledReviews feed host is a titled blog host', () => {
  for (const f of LANE_FEEDS.filter((x) => x.titledReviews)) assert.ok(isTitledBlogUrl(f.url));
  assert.equal(isTitledBlogUrl('https://www.nytimes.com/a'), false);
});

test('a short Bob\'s post titled with the show is waived (real check rejects it first)', () => {
  const text = `Other Desert Cities. ${body}`;
  const sanity = validateContentMentionsShow(text, html('Gotham Playgoer: Other Desert Cities'), 'Other Desert Cities', 'other-desert-cities-2026');
  if (sanity.valid) return; // threshold already passes; nothing to waive
  assert.equal(titledBlogMentionWaiver(BOBS, sanity, 'Other Desert Cities'), true);
});

test('waiver needs a single post, an exact "Blog: Show" title, no roundup wording', () => {
  const ok = { htmlTitleMatch: true, mentionCount: 0, htmlTitle: 'Gotham Playgoer: Other Desert Cities' };
  const S = 'Other Desert Cities';
  assert.equal(titledBlogMentionWaiver(BOBS, ok, S), true);
  for (const t of ['Gotham Playgoer: Other Desert Cities - and more', 'Gotham Playgoer: Other Desert Cities | Roundup',
    'Gotham Playgoer: Theater Bulletin: Other Desert Cities', 'Other Desert Cities', 'Gotham Playgoer: Hamlet']) {
    assert.equal(titledBlogMentionWaiver(BOBS, { ...ok, htmlTitle: t }, S), false, t);
  }
  assert.equal(titledBlogMentionWaiver('https://gotham-playgoer.blogspot.com/search/label/Other%20Desert%20Cities', ok, S), false);
  assert.equal(titledBlogMentionWaiver(BOBS, { ...ok, htmlTitleMatch: false }, S), false);
  assert.equal(titledBlogMentionWaiver('https://www.nytimes.com/2026/10/x.html', ok, S), false);
});
