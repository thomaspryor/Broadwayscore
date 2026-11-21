// BRO-7694: next 16.3.0 to 16.4.4 is affected by GHSA-mfr8-8qww-v76h. Fail if the pin rolls back into that range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

function parse(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v));
  assert.ok(m, `cannot parse version from "${v}"`);
  return m.slice(1).map(Number);
}

function atLeast(v, floor) {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== floor[i]) return v[i] > floor[i];
  }
  return true;
}

test('next is pinned at 16.4.5 or later (GHSA-mfr8-8qww-v76h)', () => {
  const spec = pkg.dependencies?.next ?? pkg.devDependencies?.next;
  assert.ok(spec, 'next is not declared in package.json');
  assert.ok(atLeast(parse(spec), [16, 4, 5]), `next ${spec} is in the advisory range (< 16.4.5)`);
});

test('package-lock.json resolves next at 16.4.5 or later', () => {
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  const resolved = lock.packages?.['node_modules/next']?.version;
  assert.ok(resolved, 'package-lock.json has no node_modules/next entry');
  assert.ok(atLeast(parse(resolved), [16, 4, 5]), `lockfile resolves next ${resolved} (< 16.4.5)`);
});

test('version comparator rejects the advisory range', () => {
  assert.equal(atLeast(parse('16.4.3'), [16, 4, 5]), false);
  assert.equal(atLeast(parse('16.4.4'), [16, 4, 5]), false);
  assert.equal(atLeast(parse('16.4.5'), [16, 4, 5]), true);
  assert.equal(atLeast(parse('^17.0.0'), [16, 4, 5]), true);
});
