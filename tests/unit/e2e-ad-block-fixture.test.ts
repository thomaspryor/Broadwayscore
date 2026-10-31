/**
 * Every e2e spec must take `test` from tests/e2e/helpers/test.ts (or
 * helpers/ugc-test.ts, which extends it), whose `context` override aborts requests
 * to Google's ad networks (BRO-5893, B-T4). Our e2e and post-deploy smoke runs
 * hit production; an ad impression from them is invalid traffic to AdSense.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AD_NETWORK_URL_RE } from '../e2e/helpers/test';

const e2eDir = join(__dirname, '..', 'e2e');
const RAW_TEST_IMPORT = /import\s*\{[^}]*\b(test|expect)\b[^}]*\}\s*from\s*'@playwright\/test'/;
const FIXTURE_IMPORT = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*'\.\/helpers\/(test|ugc-test)'/;

const specs = readdirSync(e2eDir)
  .filter((f) => f.endsWith('.spec.ts'))
  .map((f) => ({ f, src: readFileSync(join(e2eDir, f), 'utf-8') }));

test('specs are found', () => {
  assert.ok(specs.length >= 10, `found ${specs.length}`);
});

test('every e2e spec takes `test` from the ad-blocking fixture', () => {
  const bad = specs.filter(({ src }) => RAW_TEST_IMPORT.test(src) || !FIXTURE_IMPORT.test(src)).map((s) => s.f);
  assert.deepEqual(bad, [], `import { test, expect } from './helpers/test' in: ${bad.join(', ')}`);
});

test('ugc-test builds on the ad-blocking fixture', () => {
  const src = readFileSync(join(e2eDir, 'helpers', 'ugc-test.ts'), 'utf-8');
  assert.match(src, /from '\.\/test'/);
});

test('AD_NETWORK_URL_RE blocks Google ad hosts', () => {
  for (const u of [
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1',
    'https://tpc.googlesyndication.com/sodar/x.js',
    'https://googleads.g.doubleclick.net/pagead/ads?x=1',
    'https://ep1.adtrafficquality.google/getconfig/sodar',
    'https://www.googleadservices.com/pagead/conversion.js',
    'http://doubleclick.net',
  ]) {
    assert.ok(AD_NETWORK_URL_RE.test(u), u);
  }
});

test('AD_NETWORK_URL_RE leaves our own and analytics hosts alone', () => {
  for (const u of [
    'https://broadwayscorecard.com/show/wicked',
    'https://broadwayscorecard.com/?q=googlesyndication.com',
    'https://www.googletagmanager.com/gtag/js?id=G-1',
    'https://us.i.posthog.com/flags',
    'https://notgooglesyndication.com.evil.example/',
  ]) {
    assert.ok(!AD_NETWORK_URL_RE.test(u), u);
  }
});

test('scripts/visual-qa.mjs blocks the same ad hosts and sets the opt-out cookie', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'scripts', 'visual-qa.mjs'), 'utf-8');
  assert.ok(src.includes(`/${AD_NETWORK_URL_RE.source}/i`), 'AD_NETWORK_URL_RE drifted from tests/e2e/helpers/test.ts');
  assert.match(src, /name: 'bwsc_noads', value: '1'/);
});
