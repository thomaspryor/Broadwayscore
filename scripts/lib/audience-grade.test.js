// Parity: scripts/lib/audience-grade.js must match src/lib/audience-grade-utils.ts exactly.
const fs = require('fs'), path = require('path'), assert = require('assert');
const { BANDS, getAudienceGrade, MIN_AUDIENCE_REVIEWS } = require('./audience-grade');
const src = fs.readFileSync(path.join(__dirname, '../../src/lib/audience-grade-utils.ts'), 'utf8');
const ts = [...src.matchAll(/score >= (\d+)\) return \{ grade: '([^']+)'[^}]*color: '(#[0-9a-f]+)', textColor: '(#[0-9a-f]+)'/g)].map(m => [Number(m[1]), m[2], m[3], m[4]]);
assert.strictEqual(ts.length, BANDS.length, 'band count differs from the TS source');
BANDS.forEach((b, i) => assert.deepStrictEqual(b, ts[i], `band ${i} differs from the TS source`));
assert.strictEqual(Number(src.match(/MIN_AUDIENCE_REVIEWS = (\d+)/)[1]), MIN_AUDIENCE_REVIEWS);
assert.strictEqual(getAudienceGrade(92.57).grade, 'A+');
assert.strictEqual(getAudienceGrade(47).grade, 'F');
assert.strictEqual(getAudienceGrade(null), null);
console.log('audience-grade parity OK (' + BANDS.length + ' bands)');
