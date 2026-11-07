// toDateMs: an ordinal date must parse to the same instant as its plain twin in
// any timezone (BRO-5280). The ordinal fallback used UTC midnight while the
// native parse uses local midnight, so they only agreed on a UTC machine and
// orphan-review-folders.test.mjs failed on any Mac outside UTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'lib', 'date-utils.js');

for (const tz of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo']) {
  test(`ordinal and plain dates agree in ${tz}`, () => {
    const out = execFileSync(process.execPath, ['-e', `
      const { toDateMs } = require(${JSON.stringify(LIB)});
      const pairs = [['November 17th, 2023', 'November 17, 2023'], ['January 1st, 2026', 'January 1, 2026'], ['March 22nd 2019', 'March 22 2019']];
      console.log(JSON.stringify(pairs.map(([a, b]) => [toDateMs(a), toDateMs(b)])));
    `], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    for (const [a, b] of JSON.parse(out)) {
      assert.ok(Number.isFinite(a), 'ordinal date parses');
      assert.equal(a, b);
    }
  });
}
