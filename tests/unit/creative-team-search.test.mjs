import test from 'node:test';
import assert from 'node:assert/strict';
import { creativeTeamSearchText } from '../../src/lib/creative-team-search.ts';

test('slim live shows use creativeTeamNames', () => {
  assert.equal(creativeTeamSearchText({ creativeTeamNames: 'A, B' }), 'A, B');
});
test('archive entries (full creativeTeam array) stay searchable by name', () => {
  assert.equal(creativeTeamSearchText({ creativeTeam: [{ name: 'Lynn Nottage' }, { name: 'X' }] }), 'Lynn Nottage, X');
});
test('real west-end archive entries yield search text', async () => {
  const { readFileSync } = await import('node:fs');
  const a = JSON.parse(readFileSync(new URL('../../public/data/west-end-archive.json', import.meta.url)));
  const withTeam = a.filter(s => s.creativeTeam?.length);
  assert.ok(withTeam.length > 0);
  for (const s of withTeam.slice(0, 20)) assert.ok(creativeTeamSearchText(s).length > 0);
  assert.equal(creativeTeamSearchText({}), '');
});
