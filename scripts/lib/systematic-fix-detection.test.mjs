import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectSystematicIssue } = require('./systematic-fix-detection.js');

const SHOWS = [
  { id: 'a', title: 'Show A', status: 'open', closingDate: '2026-09-07', venue: 'Shubert Theatre' },
  { id: 'b', title: 'Show B', status: 'open', closingDate: '2026-09-07', venue: 'Shubert Theatre' },
  { id: 'c', title: 'Show C', status: 'open', venue: 'Majestic Theatre' },
  { id: 'd', title: 'Show D', status: 'closed', venue: 'Majestic Theatre' },
  {
    id: 'e', title: 'Show E', status: 'open',
    creativeTeam: [{ name: 'Jane Doe', role: 'Director, Scenic Design' }],
  },
];

function planWith(action) {
  return { actions: [{ type: 'data-edit', file: 'shows.json', ...action }] };
}

// The 2026-07-31 incident: a status open→closed spot fix must NEVER
// generalize to closing every other open show.
test('status flip does not generalize to all shows sharing the status', () => {
  const plan = planWith({ showId: 'a', field: 'status', oldValue: 'open', newValue: 'closed' });
  assert.equal(detectSystematicIssue(plan, SHOWS), null);
});

test('date correction does not generalize to shows sharing the date', () => {
  const plan = planWith({ showId: 'a', field: 'closingDate', oldValue: '2026-09-07', newValue: '2026-06-07' });
  assert.equal(detectSystematicIssue(plan, SHOWS), null);
});

test('venue value match does not generalize (value equality is not a defect)', () => {
  const plan = planWith({ showId: 'a', field: 'venue', oldValue: 'Shubert Theatre', newValue: 'Sam S. Shubert Theatre' });
  assert.equal(detectSystematicIssue(plan, SHOWS), null);
});

test('combined creativeTeam roles still generalize via batch-transform', () => {
  const plan = planWith({
    showId: 'x',
    field: 'creativeTeam',
    oldValue: [{ name: 'Bob', role: 'Director, Choreographer' }],
    newValue: [{ name: 'Bob', role: 'Director' }, { name: 'Bob', role: 'Choreographer' }],
  });
  const result = detectSystematicIssue(plan, SHOWS);
  assert.ok(result, 'combined-roles pattern should be detected');
  assert.equal(result.totalMatches, 1);
  assert.equal(result.actions[0].type, 'batch-transform');
  assert.equal(result.actions[0].transform, 'split-comma-roles');
});

test('ADDING a credit (no split) does not trigger the batch transform', () => {
  const plan = planWith({
    showId: 'x',
    field: 'creativeTeam',
    oldValue: [{ name: 'Bob', role: 'Director' }],
    newValue: [{ name: 'Bob', role: 'Director' }, { name: 'Alice', role: 'Producer' }],
  });
  assert.equal(detectSystematicIssue(plan, SHOWS), null);
});

test('non-data-edit actions and empty plans return null', () => {
  assert.equal(detectSystematicIssue({ actions: [] }, SHOWS), null);
  assert.equal(detectSystematicIssue({ actions: [{ type: 'run-script', script: 'validate-data.js' }] }, SHOWS), null);
});
