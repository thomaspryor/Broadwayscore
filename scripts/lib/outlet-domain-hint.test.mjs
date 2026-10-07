import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferOutletDomainHint } from './outlet-domain-hint.js';

test('no urls -> null', () => {
  assert.equal(inferOutletDomainHint([]), null);
  assert.equal(inferOutletDomainHint(undefined), null);
});

test('picks the hostname of a single valid, non-blocked url', () => {
  assert.equal(inferOutletDomainHint(['https://www.dailyecho.co.uk/news/some-review']), 'dailyecho.co.uk');
});

test('strips www.', () => {
  assert.equal(inferOutletDomainHint(['https://www.heraldscotland.com/review']), 'heraldscotland.com');
});

test('ignores blocked hosts (facebook, aggregators) even when they are the only urls', () => {
  assert.equal(inferOutletDomainHint(['https://www.facebook.com/SomeOutlet/posts/123']), null);
  assert.equal(inferOutletDomainHint(['https://westendtheatre.com/review/some-show']), null);
});

test('a blocked host encountered first does not win over a real host later in the list', () => {
  // This is the exact "first URL wins" bug this function replaces (task #766):
  // the naive version would have returned facebook.com here.
  const urls = [
    'https://www.facebook.com/SomeOutlet/posts/123',
    'https://www.dailyecho.co.uk/news/a-review',
    'https://www.dailyecho.co.uk/news/another-review',
  ];
  assert.equal(inferOutletDomainHint(urls), 'dailyecho.co.uk');
});

test('majority-votes when an outlet has urls on more than one non-blocked host', () => {
  const urls = [
    'https://www.walesonline.co.uk/review/one',
    'https://www.walesonline.co.uk/review/two',
    'https://theatreandartreviews.com/review/three',
  ];
  // theatreandartreviews.com is itself a blocked aggregator (task #766 evidence:
  // it's the wrong-host site two live rows got misattributed to) so it can never
  // win even as a majority of 1 against a minority-count real host.
  assert.equal(inferOutletDomainHint(urls), 'walesonline.co.uk');
});

test('malformed urls are ignored, not thrown', () => {
  assert.equal(inferOutletDomainHint(['not a url', 'https://www.oxfordshireguardian.co.uk/x']), 'oxfordshireguardian.co.uk');
});
