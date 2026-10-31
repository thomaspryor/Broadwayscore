import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fallbackOutletIdFromHost, resolveUnlabelledShowScoreOutlet } = require('../../scripts/lib/show-score-outlet-identity');
const { deriveOutletDisplayName, decideOutletAutoRegistration, STAGE_REASONS } = require('../../scripts/lib/outlet-auto-register');

test('unresolved hosts keep provisional IDs without inventing masthead names', () => {
  for (const [url, outletId] of [
    ['https://zzqtheatrecritic.com/review', 'zzqtheatrecritic'],
    ['https://zzq-stage-news.co.uk/review', 'zzq-stage-news'],
    ['https://zzqstagecritic.substack.com/p/review', 'zzqstagecritic'],
  ]) {
    const result = resolveUnlabelledShowScoreOutlet(url);
    assert.deepEqual(result, { outletId, displayName: '' });
  }
});

test('a run-together provisional ID is staged until its masthead is resolved', () => {
  const url = 'https://zzqtheatrecritic.com/review';
  const { outletId, displayName } = resolveUnlabelledShowScoreOutlet(url);
  const name = deriveOutletDisplayName({ outletId, reviewOutletNames: [displayName] });
  assert.equal(decideOutletAutoRegistration({
    outletId, domainHint: new URL(url).hostname, criticSlugs: new Set(), displayNameInferred: name.inferred,
  }).reason, STAGE_REASONS.NAME_UNRESOLVED);
});

test('registered outlets and editions retain canonical mastheads', () => {
  for (const [url, outletId, displayName] of [
    ['https://www.nytimes.com/theater/review', 'nytimes', 'The New York Times'],
    ['https://www.vulture.com/article/review', 'vulture', 'Vulture'],
    ['https://www.timeout.com/london/theatre/review', 'timeout-london', 'Time Out London'],
  ]) {
    assert.deepEqual(resolveUnlabelledShowScoreOutlet(url), { outletId, displayName });
  }
});

test('fallback IDs never override an outlet the registry declined', () => {
  for (const host of ['losangeles.timeout.com', 'news.yahoo.com']) {
    assert.equal(fallbackOutletIdFromHost(host), 'unknown');
    assert.deepEqual(resolveUnlabelledShowScoreOutlet(`https://${host}/review`), { outletId: 'unknown', displayName: '' });
  }
});

test('missing or invalid URLs do not produce a masthead', () => {
  for (const url of [null, undefined, '', 'not a URL']) {
    assert.deepEqual(resolveUnlabelledShowScoreOutlet(url), { outletId: 'unknown', displayName: '' });
  }
});
