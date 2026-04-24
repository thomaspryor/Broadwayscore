/**
 * Unit tests for scripts/lib/critic-canonicalization.js.
 *
 * Root incident (Rocky Horror 2026-04-23): BWW Review Roundup credited a Cote
 * Notices post to "David Finkle, Cote Notices" — actual byline on
 * cotenotices.substack.com/p/rocky-horror-show is David Cote. David Finkle is
 * a real critic at NYSR/HuffPost, so "is critic known?" checks pass and the
 * wrong name persists unless this map catches it at extraction time.
 *
 * This is defense-in-depth. The primary fix (Session 3 #12) is URL dedup with
 * tracking-param stripping. If the URLs match, dedup catches it before this
 * map is consulted. The map only fires when the URLs differ (different crawls,
 * different mirror locations, same article attributed to the wrong person).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  canonicalizeCritic,
  normalizeCriticKey,
  CRITIC_CANONICAL_MAP,
} = require('../../scripts/lib/critic-canonicalization.js');

describe('canonicalizeCritic — Cote Notices mis-attribution (Rocky Horror 2026-04-23)', () => {
  test('cote-notices + David Finkle → David Cote', () => {
    const result = canonicalizeCritic('cote-notices', 'David Finkle');
    assert.strictEqual(result.canonicalized, true);
    assert.strictEqual(result.name, 'David Cote');
    assert.strictEqual(result.from, 'David Finkle');
  });

  test('cote-notices + david finkle (lower-case) still maps — normalization key is case-insensitive', () => {
    const result = canonicalizeCritic('cote-notices', 'david finkle');
    assert.strictEqual(result.canonicalized, true);
    assert.strictEqual(result.name, 'David Cote');
  });

  test('cote-notices + David  Finkle (extra whitespace) still maps', () => {
    const result = canonicalizeCritic('cote-notices', 'David  Finkle');
    assert.strictEqual(result.canonicalized, true);
    assert.strictEqual(result.name, 'David Cote');
  });

  test('cote-notices + David Cote (already correct) stays unchanged', () => {
    const result = canonicalizeCritic('cote-notices', 'David Cote');
    assert.strictEqual(result.canonicalized, false);
    assert.strictEqual(result.name, 'David Cote');
  });
});

describe('canonicalizeCritic — scope isolation', () => {
  test('David Finkle at a DIFFERENT outlet (nysr) is unchanged', () => {
    // David Finkle is a legitimate NYSR critic — we must not clobber that.
    const result = canonicalizeCritic('nysr', 'David Finkle');
    assert.strictEqual(result.canonicalized, false);
    assert.strictEqual(result.name, 'David Finkle');
  });

  test('David Finkle at huffpost (also his real outlet) is unchanged', () => {
    const result = canonicalizeCritic('huffpost', 'David Finkle');
    assert.strictEqual(result.canonicalized, false);
  });

  test('unknown outletId returns critic unchanged', () => {
    const result = canonicalizeCritic('made-up-outlet-123', 'David Finkle');
    assert.strictEqual(result.canonicalized, false);
    assert.strictEqual(result.name, 'David Finkle');
  });

  test('cote-notices + entirely unknown critic returns unchanged', () => {
    const result = canonicalizeCritic('cote-notices', 'Some Other Person');
    assert.strictEqual(result.canonicalized, false);
    assert.strictEqual(result.name, 'Some Other Person');
  });
});

describe('canonicalizeCritic — null / bad input robustness', () => {
  test('empty criticName returns shape without throwing', () => {
    const r = canonicalizeCritic('cote-notices', '');
    assert.strictEqual(r.canonicalized, false);
  });

  test('null outletId returns shape without throwing', () => {
    const r = canonicalizeCritic(null, 'David Finkle');
    assert.strictEqual(r.canonicalized, false);
    assert.strictEqual(r.name, 'David Finkle');
  });

  test('null criticName returns shape without throwing', () => {
    const r = canonicalizeCritic('cote-notices', null);
    assert.strictEqual(r.canonicalized, false);
  });

  test('undefined both returns shape without throwing', () => {
    const r = canonicalizeCritic(undefined, undefined);
    assert.strictEqual(r.canonicalized, false);
  });

  test('non-string criticName (number) returns shape without throwing', () => {
    const r = canonicalizeCritic('cote-notices', 123);
    assert.strictEqual(r.canonicalized, false);
  });
});

describe('normalizeCriticKey', () => {
  test('lowercases and strips non-alnum', () => {
    assert.strictEqual(normalizeCriticKey('David Finkle'), 'davidfinkle');
    assert.strictEqual(normalizeCriticKey("D'Addario"), 'daddario');
    assert.strictEqual(normalizeCriticKey('Jean-Paul'), 'jeanpaul');
  });

  test('empty / null produces empty string', () => {
    assert.strictEqual(normalizeCriticKey(''), '');
    assert.strictEqual(normalizeCriticKey(null), '');
    assert.strictEqual(normalizeCriticKey(undefined), '');
  });
});

describe('CRITIC_CANONICAL_MAP — integrity', () => {
  test('every entry uses the normalized key format', () => {
    for (const outletId of Object.keys(CRITIC_CANONICAL_MAP)) {
      const map = CRITIC_CANONICAL_MAP[outletId];
      for (const key of Object.keys(map)) {
        assert.strictEqual(
          key,
          normalizeCriticKey(key),
          `key "${key}" in ${outletId} is not in normalized form — ` +
          `use normalizeCriticKey() as the key so lookups match`
        );
      }
    }
  });

  test('every canonical value is a non-empty string', () => {
    for (const outletId of Object.keys(CRITIC_CANONICAL_MAP)) {
      const map = CRITIC_CANONICAL_MAP[outletId];
      for (const canonical of Object.values(map)) {
        assert.ok(typeof canonical === 'string' && canonical.length > 0,
          `canonical value for ${outletId} must be a non-empty string, got: ${JSON.stringify(canonical)}`);
      }
    }
  });
});
