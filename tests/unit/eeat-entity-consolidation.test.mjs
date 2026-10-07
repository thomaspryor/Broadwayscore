/**
 * E-E-A-T entity consolidation (card #206): Tom Pryor bylines <-> /about <-> Person schema.
 *
 * Runs in the tsx unit batch (test.yml) — imports src TS directly per the
 * gate-logic/commercial-display precedent, since generateAuthorPersonSchema
 * lives in src/lib/seo.ts and reads src/config/author.ts + src/config/branding.ts.
 *
 * Background: content audit (2026-07-19) found /about said "I'm Tom" (no
 * surname/credentials) while /reviews/* bylines said "Tom Pryor" with a bare
 * Person schema (no sameAs/url, no link to /about) — Google couldn't
 * consolidate the author entity into one recognized Person.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { generateAuthorPersonSchema, BASE_URL } = await import('../../src/lib/seo.ts');
const { AUTHOR } = await import('../../src/config/author.ts');
const { SOCIAL_ACCOUNTS } = await import('../../src/config/branding.ts');

test('generateAuthorPersonSchema: url points at /about and carries a stable @id', () => {
  const schema = generateAuthorPersonSchema();
  assert.equal(schema['@type'], 'Person');
  assert.equal(schema.name, AUTHOR.name);
  assert.equal(schema.url, `${BASE_URL}/about`);
  assert.equal(schema['@id'], `${BASE_URL}/about#person`);
});

test('generateAuthorPersonSchema: is deterministic (/about and /reviews/[slug] emit the identical entity)', () => {
  const a = generateAuthorPersonSchema();
  const b = generateAuthorPersonSchema();
  assert.deepEqual(a, b);
});

test('generateAuthorPersonSchema: sameAs carries Bluesky, X, and Instagram profiles', () => {
  const schema = generateAuthorPersonSchema();
  assert.ok(Array.isArray(schema.sameAs) && schema.sameAs.length >= 3);

  const bluesky = SOCIAL_ACCOUNTS.find(a => a.platform === 'bluesky');
  const twitter = SOCIAL_ACCOUNTS.find(a => a.platform === 'twitter');
  const instagram = SOCIAL_ACCOUNTS.find(a => a.platform === 'instagram');
  assert.ok(bluesky && schema.sameAs.includes(bluesky.url), 'sameAs must include the Bluesky profile');
  assert.ok(twitter && schema.sameAs.includes(twitter.url), 'sameAs must include the X/Twitter profile');
  assert.ok(instagram && schema.sameAs.includes(instagram.url), 'sameAs must include the Instagram profile');
});

test('generateAuthorPersonSchema: sameAs matches the Organization node\'s social accounts (no drift)', () => {
  const schema = generateAuthorPersonSchema();
  for (const url of schema.sameAs) {
    assert.ok(
      SOCIAL_ACCOUNTS.some(a => a.url === url),
      `${url} must come from the single SOCIAL_ACCOUNTS source of truth shared with the Organization schema`
    );
  }
});

test('AUTHOR config: has a jobTitle and /about url for schema + byline linking', () => {
  assert.equal(AUTHOR.name, 'Tom Pryor');
  assert.equal(AUTHOR.url, '/about');
  assert.ok(AUTHOR.jobTitle && AUTHOR.jobTitle.length > 0);
});

test('/about page: displays the full name (surname) and a qualifying credential line', () => {
  const src = readFileSync(new URL('../../src/app/about/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /Tom Pryor/, '/about must display the surname, not just "Tom"');
  assert.match(src, /AUTHOR\.jobTitle/, '/about must render a qualifying credential line (job title)');
});

test('/about page: renders the same Person JSON-LD the byline links to (closes the consolidation loop)', () => {
  const src = readFileSync(new URL('../../src/app/about/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /generateAuthorPersonSchema/, '/about must emit Person JSON-LD, not just prose — otherwise a crawler following the byline lands on an unconsolidated page');
  assert.match(src, /application\/ld\+json/);
});

test('ReviewCard: byline renders as a real anchor to /about (crawlable, not a JS-only click handler)', () => {
  const src = readFileSync(new URL('../../src/components/reviews/ReviewCard.tsx', import.meta.url), 'utf8');
  assert.match(src, /import\s*\{\s*AUTHOR\s*\}\s*from\s*'@\/config\/author'/);
  assert.match(src, /<Link\s+href=\{AUTHOR\.url\}/, 'byline must be a Link (renders to a real <a href="/about">)');
});

test('reviews/[slug] page: JSON-LD author uses generateAuthorPersonSchema (url + sameAs), not a bare Person stub', () => {
  const src = readFileSync(new URL('../../src/app/reviews/[slug]/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /generateAuthorPersonSchema/);
  assert.doesNotMatch(
    src,
    /author:\s*\{\s*'@type':\s*'Person',\s*name:\s*AUTHOR\.name,?\s*\}/,
    'author should no longer be a bare {@type: Person, name} stub with no url/sameAs'
  );
  assert.match(src, /<Link\s+href=\{AUTHOR\.url\}/, 'visible byline must also link to /about');
});
