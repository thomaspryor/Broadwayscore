// BRO-5243: AP wire reviews filed under WSJ (online.wsj.com/article/AP<id>)
// were scored as WSJ Tier-1 reviews; two had no fullText for the text signals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { detectAPContent } = require('../../scripts/lib/ap-wire-detect.js');

// Invented placeholder prose, not review text.
const BODY = 'The revival opens on a bare stage and the cast works hard all night long. '.repeat(10);

test('an AP wire id in the URL marks AP copy, even with no fullText', () => {
  assert.equal(detectAPContent(null, 'https://online.wsj.com/article/AP216f8806ddad4b8b9837a6702e4abcde.html'), true);
  assert.equal(detectAPContent('', 'http://online.wsj.com/article/AP0f81b3d24e44422db6feb5b187e37a66.html?mod=x'), true);
});

test('real WSJ URLs and ordinary text are not AP', () => {
  for (const url of [
    'https://www.wsj.com/articles/leopoldstadt-review-tom-stoppard-eb586d98',
    'https://online.wsj.com/article/SB10001424052702304185104579435110384195896.html',
    'https://www.wsj.com/articles/review-of-wolf-hall-now-on-broadway-1428631502',
  ]) assert.equal(detectAPContent(BODY + 'Mr. Critic is the paper’s drama critic.', url), false, url);
  assert.equal(detectAPContent(null, null), false);
});

test('existing byline signal still fires', () => {
  assert.equal(detectAPContent('By Mark Kennedy, AP\n' + BODY), true);
});
