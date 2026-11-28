// BRO-5456: audit-url-critic-slug-filenames.js filename classifier (BRO-2938's acceptance check).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasUrlCriticSlug } = require('./audit-url-critic-slug-filenames.js');
const { isSafeCheckCommand } = require('./lib/check-paths.js');

test('flags a URL where the critic slug belongs (https and http forms)', () => {
  assert.equal(hasUrlCriticSlug('chicago-sun-times--httpschicagosuntimescomcatey-sullivan-for-the-sun-times.json'), true);
  assert.equal(hasUrlCriticSlug('nytimes--httpwwwnytimescombycharles-isherwood.json'), true);
});

test('leaves normal critic slugs and non-json files alone', () => {
  assert.equal(hasUrlCriticSlug('nytimes--jesse-green.json'), false);
  assert.equal(hasUrlCriticSlug('nytimes--httpx.txt'), false);
  assert.equal(hasUrlCriticSlug('http--critic.json'), false); // outlet part, not critic part
  assert.equal(hasUrlCriticSlug('nytimes--hugh-thompson.json'), false);
});

test('safe-form gate admits the bare command', () => {
  assert.equal(isSafeCheckCommand('node scripts/audit-url-critic-slug-filenames.js'), true);
});
