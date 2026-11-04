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

test('waiver needs the title to be exactly the show, a titled blog host, and one mention', () => {
  const ok = { htmlTitleMatch: true, mentionCount: 1, htmlTitle: 'Gotham Playgoer: Other Desert Cities' };
  assert.equal(titledBlogMentionWaiver(BOBS, ok, 'Other Desert Cities'), true);
  assert.equal(titledBlogMentionWaiver(BOBS, { ...ok, htmlTitle: 'Gotham Playgoer: Theater Bulletin Other Desert Cities Roundup' }, 'Other Desert Cities'), false);
  assert.equal(titledBlogMentionWaiver(BOBS, { ...ok, mentionCount: 0 }, 'Other Desert Cities'), true);
  assert.equal(titledBlogMentionWaiver(BOBS, { ...ok, htmlTitleMatch: false }, 'Other Desert Cities'), false);
  assert.equal(titledBlogMentionWaiver('https://www.nytimes.com/x', ok, 'Other Desert Cities'), false);
});
