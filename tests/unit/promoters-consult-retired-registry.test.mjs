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
const promoters = fs.readdirSync(scriptsDir).filter((f) => /^promote-.*\.js$/.test(f));

test('there are promoters to check', () => {
  assert.ok(promoters.length >= 5, `found ${promoters.join(', ')}`);
});

for (const f of promoters) {
  test(`${f} refuses a retired show id before minting a row`, () => {
    const src = fs.readFileSync(path.join(scriptsDir, f), 'utf8');
    assert.match(src, /matchesRetired\(|isRetiredId\(/, `${f} never consults lib/retired-show-ids.js`);
  });
}
