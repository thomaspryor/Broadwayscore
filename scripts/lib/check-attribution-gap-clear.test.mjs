// BRO-4215: acceptance check for provider-spend attribution-gap cards, and the
// SAFE_CHECK_FORMS entry that lets the parked-card drain run it headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');

// The verdict logic itself is tested in provider-spend-core.test.mjs
// (attributionWindowVerdict); this file covers the CLI and its safe form.
test('CLI: --help exits 0, unknown provider exits 2', () => {
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'check-attribution-gap-clear.js');
  assert.equal(spawnSync(process.execPath, [cli, '--help']).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, '--provider=bogus']).status, 2);
});

test('the card VERIFY command is a safe check form; other providers or shell tails are not', () => {
  for (const p of ['scrapingbee', 'scrapingdog', 'brightdata']) {
    assert.equal(isSafeCheckCommand(`node scripts/check-attribution-gap-clear.js --provider=${p}`), true, p);
  }
  assert.equal(isSafeCheckCommand('node scripts/check-attribution-gap-clear.js --provider=browserbase'), false);
  assert.equal(isSafeCheckCommand('node scripts/check-attribution-gap-clear.js --provider=scrapingbee; rm -rf /'), false);
});
