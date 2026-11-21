// BRO-4967: the site stamps the owner flag as an EVENT super-property
// (posthog.register in src/components/AnalyticsWrapper.tsx, no person
// profile), but the Real Users lens and two other queries filtered on
// person.properties.is_owner, which no person has. The owner exclusion was a
// no-op (2026-10-10: 56 owner-stamped events in 30 days, 0 persons). This
// pins every owner filter in scripts/ to the event property.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

test('the Real Users lens excludes the owner by the event property', () => {
  const { REAL_USERS_WHERE } = require('./posthog-query.js');
  assert.match(REAL_USERS_WHERE, /JSONExtractString\(properties,\s*'is_owner'\)/);
  assert.doesNotMatch(REAL_USERS_WHERE, /person\.properties[^)]*is_owner/);
});

test('the site really sets is_owner as an event super-property', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/components/AnalyticsWrapper.tsx'), 'utf8');
  assert.match(src, /posthog\.register\(\{\s*is_owner:\s*true\s*\}\)/,
    'if the site moves is_owner to a person property, flip the queries and this test together');
});

test('no script filters the owner on person.properties', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c?js|mjs|ts)$/.test(e.name) && !e.name.includes('owner-filter.test')) {
        const text = fs.readFileSync(p, 'utf8');
        if (/person\.properties\s*,\s*'is_owner'|person\.properties\.is_owner/.test(text)) offenders.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, []);
});
