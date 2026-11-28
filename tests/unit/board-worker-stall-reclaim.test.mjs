import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('board worker stall instructions use the existing lookup-free reclaim', () => {
  const doc = readFileSync('docs/cloud-routines/board-workers.md', 'utf8');
  const section = doc.split('## 1b.')[1].split('## 2.')[0];
  assert.doesNotMatch(section, /call `get_session`|--stall-act/);
  assert.match(section, /48h/);
  const workflow = readFileSync('.github/workflows/land-retry-cancelled.yml', 'utf8');
  assert.match(workflow, /run: node scripts\/linear-reclaim-abandoned\.js\s*$/m);
});
