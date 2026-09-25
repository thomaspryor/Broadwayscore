// BRO-4141: score-only (paywalled) ingest's wrong-show guard. The old raw
// substring check refused The Stage's own Thelma & Louise review (issue #919).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { pageMentionsShowTitle } = createRequire(import.meta.url)('./submission-show-match.js');

test('pageMentionsShowTitle: entities, subtitles, parentheticals match', () => {
  assert.equal(pageMentionsShowTitle('<h1>Thelma &amp;amp; Louise review</h1>', 'Thelma & Louise: A New Musical'), true);
  assert.equal(pageMentionsShowTitle('<h1>Thelma &amp; Louise</h1>', 'Thelma & Louise: A New Musical'), true);
  assert.equal(pageMentionsShowTitle('Thelma and Louise at the Young Vic', 'Thelma & Louise'), true);
  assert.equal(pageMentionsShowTitle('Hamlet review at the Globe', 'Hamlet (Globe)'), true);
  assert.equal(pageMentionsShowTitle('Les Misérables returns', 'Les Miserables'), true);
});

test('pageMentionsShowTitle: still refuses the wrong show', () => {
  assert.equal(pageMentionsShowTitle('a mama story', 'Ma'), false);
  assert.equal(pageMentionsShowTitle('cinema review', 'Ma: The Play'), false);
  assert.equal(pageMentionsShowTitle('Louise alone', 'Thelma & Louise: A New Musical'), false);
  assert.equal(pageMentionsShowTitle('nothing here', 'Macbeth'), false);
  assert.equal(pageMentionsShowTitle('', 'Macbeth'), false);
});

test('ingest-review-from-url.js uses the shared guard, not an inline normalizer', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../ingest-review-from-url.js', import.meta.url), 'utf8');
  assert.match(src, /pageMentionsShowTitle\(html, show\.title\)/);
});
