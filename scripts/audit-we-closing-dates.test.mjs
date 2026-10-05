// BRO-3792: the WE closing-date audit only audits status==='open' west-end
// shows. A show that closed (one-night run) must carry status=closed AND a
// closingDate, otherwise it is flagged POSSIBLY_CLOSED forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'shows.json');
const have = fs.existsSync(file);
const shows = have ? JSON.parse(fs.readFileSync(file, 'utf8')).shows : [];

test('BRO-3792 one-night WE show is closed with closingDate (not audited)', { skip: !have }, () => {
  const s = shows.find(x => x.id === 'why-i-stuck-a-flare-up-my-arse-for-england-west-end-2026');
  assert.ok(s, 'show present');
  assert.equal(s.status, 'closed');
  assert.equal(s.closingDate, '2026-06-22');
});

test('closed West End shows always carry a closingDate', { skip: !have }, () => {
  const bad = shows.filter(s => s.category === 'west-end' && s.status === 'closed' && !s.closingDate).map(s => s.id);
  assert.deepEqual(bad, []);
});
