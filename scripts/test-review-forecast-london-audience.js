// BRO-7380 guard: the London/out-of-town audience results stay aggregate-only and the summary reproduces.
const fs = require('fs'); const { execFileSync } = require('child_process'); const assert = require('assert');
const d = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'data/audit/review-forecast-london-audience.json'), 'utf8'));
assert.strictEqual(d.paidFetches, 0, 'sweep must stay on free direct fetches');
const BAD = /"(text|body|reviewText|excerpt|author|username|name)"\s*:/i;
assert.ok(!BAD.test(JSON.stringify(d.shows)), 'results must hold aggregates only (no text or names)');
const out = execFileSync('node', ['scripts/research/review-forecast-london-audience.mjs', '--summary'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const s = JSON.parse(out.slice(out.indexOf('{')));
assert.ok(s.cohorts.londonFirst >= 15 && s.cohorts.londonFirstPathStartsLondon <= s.cohorts.londonFirst);
for (const sh of Object.values(d.shows)) for (const src of (sh.sources || [])) { if (src.newest && src.cutoff) assert.ok(src.newest <= src.cutoff, 'no rating dated after the cutoff'); }
assert.ok(s.backtest.rows.every((r) => r.n >= 15), 'rows below the 15-show floor must not be reported as fits');
console.log('ok london-audience guard');
