// BRO-7304 class guard: a URL-move wipe must not drop a live review from reviews.json.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert');
const { findUrlWipeHolds } = require('./lib/url-wipe-hold');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uwh-'));
const now = Date.parse('2026-11-10T20:00:00Z');
const stamp = (at) => ({ from: 'https://x.com/a', to: 'https://x.com/b', at, cleared: ['fullText', 'llmScore'] });
function put(show, name, d) {
  fs.mkdirSync(path.join(dir, show), { recursive: true });
  fs.writeFileSync(path.join(dir, show, name + '.json'), JSON.stringify(d));
}
const row = (show, outletId, critic, score = 60) => ({ showId: show, outletId, outlet: outletId, criticName: critic, assignedScore: score, url: 'https://x.com/a' });
const base = { outletId: 'observer', criticName: 'David Cote', needsRefetch: true };

put('s1', 'wiped', { ...base, _urlChangedClear: stamp('2026-11-10T15:39:00Z') });                       // hold
put('s1', 'old-stamp', { outletId: 'ny-post', criticName: 'A', _urlChangedClear: stamp('2026-10-01T00:00:00Z') }); // expired
put('s1', 'scored', { outletId: 'variety', criticName: 'B', llmScore: { score: 70 }, _urlChangedClear: stamp('2026-11-10T15:39:00Z') }); // has signal
put('s1', 'flagged', { outletId: 'vulture', criticName: 'C', wrongProduction: true, _urlChangedClear: stamp('2026-11-10T15:39:00Z') }); // intentional
put('s1', 'nostamp', { outletId: 'nyt', criticName: 'D' });                                              // no stamp

const prev = [row('s1', 'observer', 'David Cote'), row('s1', 'ny-post', 'A'), row('s1', 'variety', 'B'),
  row('s1', 'vulture', 'C'), row('s1', 'nyt', 'D'), row('s1', 'ghost', 'E')];
const r = findUrlWipeHolds({ previousRows: prev, newRows: [], reviewTextsDir: dir, nowMs: now });
assert.deepStrictEqual(r.held.map((x) => x.outletId), ['observer'], 'only the fresh, signal-less, unflagged wipe is held');
assert.strictEqual(r.skipped.get('stamp-expired'), 1);
assert.strictEqual(r.skipped.get('has-score-signal'), 1);
assert.strictEqual(r.skipped.get('exclusion-flag'), 1);
assert.strictEqual(r.skipped.get('no-url-change-stamp'), 1);
assert.strictEqual(r.skipped.get('no-source-file'), 1);

// Already present in the new build: nothing to hold.
assert.strictEqual(findUrlWipeHolds({ previousRows: prev, newRows: [row('s1', 'observer', 'David Cote')], reviewTextsDir: dir, nowMs: now }).held.length, 0);
// Leased show is never touched.
assert.strictEqual(findUrlWipeHolds({ previousRows: prev, newRows: [], reviewTextsDir: dir, nowMs: now, skipShowIds: new Set(['s1']) }).held.length, 0);
console.log('url-wipe-hold: all assertions passed');
