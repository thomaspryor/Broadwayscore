// BRO-5557: promote-ob-venue-candidates.js re-minted the Il Cimento duplicate three days
// after it was retired because only promote-owe-* consulted data/retired-show-ids.json.
// Every script that promotes candidates into shows.json must read the registry; a new
// promote-*.js that forgets fails here instead of re-adding a retired row in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
// Every promote-*.js, plus the other writers that push new rows into shows.json (the reviewer found
// add-show-action and discover-historical-shows with the same hole).
const promoters = [
  ...fs.readdirSync(scriptsDir).filter((f) => /^promote-.*\.js$/.test(f)),
  'lib/add-show-action.js',
  'discover-historical-shows.js',
];

test('there are promoters to check', () => {
  assert.ok(promoters.length >= 5, `found ${promoters.join(', ')}`);
});

for (const f of promoters) {
  test(`${f} refuses a retired show id before minting a row`, () => {
    // Strip comments first: a mention in a comment is not a call.
    const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // A real call probes with the id the row would be minted under, and the hit must stop the row.
    assert.match(src, /matchesRetired\(\s*\{\s*id:\s*(?:entry|show)\.id|isRetiredId\(\s*(?:entry|show)\.id/, `${f} never probes the retired registry with the minted entry id`);
    assert.match(src, /retired(?:Hit)?\b[\s\S]{0,400}?(continue|return)/, `${f} does not skip the candidate when the registry matches`);
  });
}
