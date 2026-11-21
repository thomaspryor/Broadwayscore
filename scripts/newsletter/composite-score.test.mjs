import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCompositeScoreLoader } from './composite-score.mjs';

test('newsletter resolves only published composite scores', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-composite-score-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (id, data) => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(data));
  write('published', { cs: 82.88, rc: 25, rv: [{ s: 40 }, { s: 60 }] });
  // Dog Show's incident: review scores exist but coverage withholds cs.
  write('withheld', { rc: 3, rv: [{ s: 78 }, { s: 84 }, { s: 75 }], cov: { state: 'incomplete' } });
  write('null-score', { cs: null, rc: 3 });
  write('no-count', { cs: 82.88 });
  write('null-file', null);
  write('zero', { cs: 0, rc: 3 });
  fs.writeFileSync(path.join(dir, 'corrupt.json'), '{');
  const aggregateScore = createCompositeScoreLoader(dir);

  assert.deepEqual(aggregateScore('published'), { avg: 83, count: 25, raw: 82.88 });
  for (const id of ['withheld', 'null-score', 'no-count', 'null-file', 'missing', 'corrupt']) {
    assert.equal(aggregateScore(id), null, `${id} must never produce a review mean`);
  }
  assert.deepEqual(aggregateScore('zero'), { avg: 0, count: 3, raw: 0 });

  // A single issue keeps one consistent snapshot per show.
  write('published', { cs: 90, rc: 30 });
  write('withheld', { cs: 79, rc: 3 });
  assert.deepEqual(aggregateScore('published'), { avg: 83, count: 25, raw: 82.88 });
  assert.equal(aggregateScore('withheld'), null);
  assert.deepEqual(createCompositeScoreLoader(dir)('published'), { avg: 90, count: 30, raw: 90 });
});
