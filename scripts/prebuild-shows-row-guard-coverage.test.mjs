// BRO-6016: every prebuild generator that reads data/shows.json must filter rows
// through show-row-guard (partitionShowRows) or be on the allowlist with a reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const prebuild = readFileSync(path.join(scriptsDir, 'prebuild.sh'), 'utf8');

// script -> why it may read shows.json without the row guard
const ALLOWLIST = {
  'build-slug-redirects.js': 'filters to rows with string id+slug, the only fields it reads (BRO-5954)',
};

const READS_SHOWS = /(?<![-\w])shows\.json|SHOWS_FILE|SHOWS_PATH/;

test('BRO-6016: prebuild generators reading shows.json use show-row-guard', () => {
  const names = [...new Set([...prebuild.matchAll(/node scripts\/([\w.-]+\.js)/g)].map((m) => m[1]))];
  assert.ok(names.length > 10, 'parsed prebuild.sh script list');
  const offenders = [];
  for (const name of names) {
    const f = path.join(scriptsDir, name);
    assert.ok(existsSync(f), `prebuild.sh names missing script ${name}`);
    if (ALLOWLIST[name]) continue;
    let src = readFileSync(f, 'utf8');
    // follow local lib requires one level (market archives load shows.json in a lib)
    for (const m of src.matchAll(/require\(['"]\.\/lib\/([\w.-]+)['"]\)/g)) {
      const lib = path.join(scriptsDir, 'lib', m[1].endsWith('.js') ? m[1] : m[1] + '.js');
      if (existsSync(lib) && !/show-row-guard\.js$/.test(lib)) src += '\n' + readFileSync(lib, 'utf8');
    }
    if (READS_SHOWS.test(src) && !/show-row-guard/.test(src)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `read shows.json without show-row-guard (wrap in partitionShowRows(...).valid or add to ALLOWLIST with a reason): ${offenders.join(', ')}`);
});
