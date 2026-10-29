import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseHeadline, groupProductions } = require('../uk-regional-census-productions.js');

const item = (headline, url, publishDate, outletId) => ({ headline, url, publishDate, outletId, itemMarket: 'regional-uk' });

test('a comma in the title stays; a house after the comma is cut', () => {
  assert.equal(parseHeadline(item('Hello, Dolly! review – Crucible Theatre', 'https://x.example/hello-dolly-review-crucible-theatre')).title, 'Hello, Dolly');
  assert.equal(parseHeadline(item('Review: Oh, What a Lovely War, Crucible Theatre', 'https://x.example/review-oh-what-a-lovely-war-crucible')).title, 'Oh, What a Lovely War');
  assert.equal(parseHeadline(item('Dear Young Monster, Tanya Moiseiwitsch Playhouse review – Crucible Theatre', 'https://x.example/dear-young-monster-tanya-moiseiwitsch-review')).title, 'Dear Young Monster');
});

test('two shows whose titles share a first word stay apart; "X the Musical" joins X', () => {
  const g = groupProductions([
    item('Jack review – Crucible Theatre', 'https://a.example/jack-review', '2024-02-01', 'a'),
    item('Jack and the Beanstalk review – Crucible Theatre', 'https://b.example/jack-and-the-beanstalk-review', '2024-03-01', 'b'),
    item('Grease review – Crucible Theatre', 'https://a.example/grease-review', '2024-05-01', 'a'),
    item('Grease the Musical review – Crucible Theatre', 'https://b.example/grease-the-musical-review', '2024-05-03', 'b'),
  ]);
  assert.deepEqual(g.map((x) => [x.title, x.items.length]).sort(), [['Grease', 2], ['Jack and the Beanstalk', 1], ['Jack', 1]]);
});

test('a British Theatre Guide slug cut to "the birthd" never joins "The Caretaker"', () => {
  const g = groupProductions([
    item('The Caretaker review – Chichester Festival Theatre', 'https://a.example/the-caretaker-review', '2024-06-14', 'a'),
    item('the birthd chichester festival theatre', 'https://www.britishtheatreguide.info/reviews/the-birthd-chichester-fest-1234', '2024-06-20', 'btg'),
  ]);
  assert.deepEqual(g.map((x) => [x.title, x.items.length]), [['The Caretaker', 1]]);
});
