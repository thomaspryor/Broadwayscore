import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  selectFresherCookieTier,
  loadEnvMeta,
  loadCookieMeta,
  loadCookiesForDomain,
  loadCookiesByFileKey,
  clearCache,
} = require('./cookie-loader.js');

// ============================================================================
// selectFresherCookieTier — pure decision function (task #881)
// ============================================================================

test('selectFresherCookieTier: env strictly newer than bundle -> env wins', () => {
  const bundleMeta = { extractedAtUnix: 1000 };
  const envMeta = { extractedAtUnix: 2000 };
  assert.equal(selectFresherCookieTier(bundleMeta, envMeta), 'env');
});

test('selectFresherCookieTier: bundle newer than env -> bundle wins (no regression)', () => {
  const bundleMeta = { extractedAtUnix: 2000 };
  const envMeta = { extractedAtUnix: 1000 };
  assert.equal(selectFresherCookieTier(bundleMeta, envMeta), 'bundle');
});

test('selectFresherCookieTier: equal timestamps -> bundle wins (tie defaults to historical order)', () => {
  const bundleMeta = { extractedAtUnix: 1500 };
  const envMeta = { extractedAtUnix: 1500 };
  assert.equal(selectFresherCookieTier(bundleMeta, envMeta), 'bundle');
});

test('selectFresherCookieTier: no meta on either side -> bundle wins (historical default)', () => {
  assert.equal(selectFresherCookieTier(null, null), 'bundle');
});

test('selectFresherCookieTier: bundle has no meta, env does -> bundle wins (can\'t compare, no regression)', () => {
  assert.equal(selectFresherCookieTier(null, { extractedAtUnix: 1000 }), 'bundle');
});

test('selectFresherCookieTier: env has no meta, bundle does -> bundle wins', () => {
  assert.equal(selectFresherCookieTier({ extractedAtUnix: 1000 }, null), 'bundle');
});

test('selectFresherCookieTier: falls back to parsing extractedAt ISO strings when extractedAtUnix absent', () => {
  const bundleMeta = { extractedAt: '2026-01-01T00:00:00.000Z' };
  const envMeta = { extractedAt: '2026-06-01T00:00:00.000Z' };
  assert.equal(selectFresherCookieTier(bundleMeta, envMeta), 'env');
});

test('selectFresherCookieTier: unparseable extractedAt treated as unknown -> bundle wins', () => {
  const bundleMeta = { extractedAtUnix: 1000 };
  const envMeta = { extractedAt: 'not-a-date' };
  assert.equal(selectFresherCookieTier(bundleMeta, envMeta), 'bundle');
});

// ============================================================================
// loadEnvMeta — Tier-2 companion `${envVar}_META` env var
// ============================================================================

test('loadEnvMeta: reads and decodes a companion _META env var', () => {
  const meta = { extractedAt: '2026-08-02T00:00:00.000Z', extractedAtUnix: 1785700800 };
  process.env.TEST_OUTLET_COOKIES_META = Buffer.from(JSON.stringify(meta)).toString('base64');
  try {
    assert.deepEqual(loadEnvMeta('TEST_OUTLET_COOKIES'), meta);
  } finally {
    delete process.env.TEST_OUTLET_COOKIES_META;
  }
});

test('loadEnvMeta: returns null when the companion var is absent', () => {
  delete process.env.TEST_OUTLET_COOKIES_META;
  assert.equal(loadEnvMeta('TEST_OUTLET_COOKIES'), null);
});

test('loadEnvMeta: returns null on malformed base64/JSON rather than throwing', () => {
  process.env.TEST_OUTLET_COOKIES_META = 'not-valid-base64-json!!!';
  try {
    assert.equal(loadEnvMeta('TEST_OUTLET_COOKIES'), null);
  } finally {
    delete process.env.TEST_OUTLET_COOKIES_META;
  }
});

// ============================================================================
// loadCookiesForDomain / loadCookiesByFileKey — end-to-end tier selection
// ============================================================================
// wsj.com / WSJ_COOKIES / fileKey 'wsj' is a real entry in COOKIE_DOMAIN_MAP,
// so these exercise the actual production wiring, not a stand-in domain.

const BUNDLE_ENV_VAR = 'COOKIES_BUNDLE_TEST881';

function setBundle(fileKey, cookies, meta) {
  process.env[BUNDLE_ENV_VAR] = Buffer.from(
    JSON.stringify({ _meta: meta, [fileKey]: cookies })
  ).toString('base64');
}

function resetEnv() {
  delete process.env[BUNDLE_ENV_VAR];
  delete process.env.WSJ_COOKIES;
  delete process.env.WSJ_COOKIES_META;
  clearCache();
}

test('loadCookiesForDomain: fresher Tier-2 secret wins over a stale Tier-1 bundle entry', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'stale', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 1000 });
    process.env.WSJ_COOKIES = Buffer.from(
      JSON.stringify([{ name: 'fresh', value: '2', domain: 'wsj.com' }])
    ).toString('base64');
    process.env.WSJ_COOKIES_META = Buffer.from(
      JSON.stringify({ extractedAtUnix: 2000 })
    ).toString('base64');

    const cookies = loadCookiesForDomain('wsj.com');
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, 'fresh');
  } finally {
    resetEnv();
  }
});

test('loadCookiesForDomain: fresher Tier-1 bundle still wins over a stale Tier-2 secret (no regression)', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'fresh-bundle', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 2000 });
    process.env.WSJ_COOKIES = Buffer.from(
      JSON.stringify([{ name: 'stale-env', value: '2', domain: 'wsj.com' }])
    ).toString('base64');
    process.env.WSJ_COOKIES_META = Buffer.from(
      JSON.stringify({ extractedAtUnix: 1000 })
    ).toString('base64');

    const cookies = loadCookiesForDomain('wsj.com');
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, 'fresh-bundle');
  } finally {
    resetEnv();
  }
});

test('loadCookiesForDomain: bundle present, no Tier-2 secret at all -> bundle used (unchanged behavior)', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'only-bundle', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 1000 });
    const cookies = loadCookiesForDomain('wsj.com');
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].name, 'only-bundle');
  } finally {
    resetEnv();
  }
});

test('loadCookiesForDomain: no bundle meta on the bundle entry, fresher env secret exists -> bundle still wins (can\'t compare)', () => {
  resetEnv();
  try {
    // setBundle with meta=undefined omits _meta entirely, matching bundles
    // produced without extraction metadata.
    setBundle('wsj', [{ name: 'no-meta-bundle', value: '1', domain: 'wsj.com' }], undefined);
    process.env.WSJ_COOKIES = Buffer.from(
      JSON.stringify([{ name: 'env-with-meta', value: '2', domain: 'wsj.com' }])
    ).toString('base64');
    process.env.WSJ_COOKIES_META = Buffer.from(
      JSON.stringify({ extractedAtUnix: 9999999999 })
    ).toString('base64');

    const cookies = loadCookiesForDomain('wsj.com');
    assert.equal(cookies[0].name, 'no-meta-bundle');
  } finally {
    resetEnv();
  }
});

test('loadCookiesByFileKey: mirrors loadCookiesForDomain freshness selection', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'stale', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 1000 });
    process.env.WSJ_COOKIES = Buffer.from(
      JSON.stringify([{ name: 'fresh', value: '2', domain: 'wsj.com' }])
    ).toString('base64');
    process.env.WSJ_COOKIES_META = Buffer.from(
      JSON.stringify({ extractedAtUnix: 2000 })
    ).toString('base64');

    const result = loadCookiesByFileKey('wsj');
    assert.equal(result.source, 'env');
    assert.equal(result.cookies[0].name, 'fresh');
  } finally {
    resetEnv();
  }
});

test('loadCookiesByFileKey: reverse case (bundle fresher) reports source bundle', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'fresh-bundle', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 2000 });
    process.env.WSJ_COOKIES = Buffer.from(
      JSON.stringify([{ name: 'stale-env', value: '2', domain: 'wsj.com' }])
    ).toString('base64');
    process.env.WSJ_COOKIES_META = Buffer.from(
      JSON.stringify({ extractedAtUnix: 1000 })
    ).toString('base64');

    const result = loadCookiesByFileKey('wsj');
    assert.equal(result.source, 'bundle');
    assert.equal(result.cookies[0].name, 'fresh-bundle');
  } finally {
    resetEnv();
  }
});

test('loadCookiesByFileKey: a fresher-but-EMPTY env secret must not discard a populated bundle', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'populated-bundle', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 1000 });
    process.env.WSJ_COOKIES = Buffer.from(JSON.stringify([])).toString('base64');
    process.env.WSJ_COOKIES_META = Buffer.from(
      JSON.stringify({ extractedAtUnix: 2000 })
    ).toString('base64');

    const result = loadCookiesByFileKey('wsj');
    assert.equal(result.source, 'bundle');
    assert.equal(result.cookies.length, 1);
    assert.equal(result.cookies[0].name, 'populated-bundle');
  } finally {
    resetEnv();
  }
});

test('loadCookieMeta: tier-aware — reports env source when env is the fresher, selected tier', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'stale', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 1000 });
    process.env.WSJ_COOKIES = Buffer.from(
      JSON.stringify([{ name: 'fresh', value: '2', domain: 'wsj.com' }])
    ).toString('base64');
    process.env.WSJ_COOKIES_META = Buffer.from(
      JSON.stringify({ extractedAtUnix: 2000 })
    ).toString('base64');

    const meta = loadCookieMeta('wsj');
    assert.equal(meta.source, 'env');
    assert.equal(meta.extractedAtUnix, 2000);
  } finally {
    resetEnv();
  }
});

test('loadCookieMeta: reverse case (bundle fresher) reports bundle source (matches loadCookiesByFileKey)', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'fresh-bundle', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 2000 });
    process.env.WSJ_COOKIES = Buffer.from(
      JSON.stringify([{ name: 'stale-env', value: '2', domain: 'wsj.com' }])
    ).toString('base64');
    process.env.WSJ_COOKIES_META = Buffer.from(
      JSON.stringify({ extractedAtUnix: 1000 })
    ).toString('base64');

    const meta = loadCookieMeta('wsj');
    assert.equal(meta.source, 'bundle');
    assert.equal(meta.extractedAtUnix, 2000);
  } finally {
    resetEnv();
  }
});

test('loadCookieMeta: no WSJ_COOKIES env var set at all -> falls back to bundle meta (unchanged behavior)', () => {
  resetEnv();
  try {
    setBundle('wsj', [{ name: 'only-bundle', value: '1', domain: 'wsj.com' }], { extractedAtUnix: 1000 });
    const meta = loadCookieMeta('wsj');
    assert.equal(meta.source, 'bundle');
    assert.equal(meta.extractedAtUnix, 1000);
  } finally {
    resetEnv();
  }
});
