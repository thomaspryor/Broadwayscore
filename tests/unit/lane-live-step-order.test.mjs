// BRO-6618: in night mode the lane keeps its lease until the review-texts push succeeded.
// Reads the real workflow and the real CLI; nothing is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const yml = fs.readFileSync(new URL('../../.github/workflows/opening-night-lane-live.yml', import.meta.url), 'utf8');
const cli = fs.readFileSync(new URL('../../scripts/opening-night-lane.js', import.meta.url), 'utf8');

// The night job's steps, split on step starts; the job ends at the next two-space-indented job key.
const night = yml.split(/^  night:\n/m)[1].split(/^  [a-z][\w-]*:\n/m)[0];
const steps = night.split(/^      - /m).slice(1).map((body) => ({
  body,
  name: (body.match(/name: (.+)/) || [])[1],
  id: (body.match(/^\s+id: (\S+)/m) || [])[1],
  cond: (body.match(/^\s+if: (.+)/m) || [])[1] || '',
}));
const idx = (name) => steps.findIndex((s) => s.name === name);

test('release step exists after the push step, which exists after the lane step', () => {
  const lane = idx('Run the lane'); const push = idx('Push scored reviews to review-texts'); const rel = idx('Release night lease');
  assert.ok(lane >= 0 && push > lane && rel > push, `order lane=${lane} push=${push} release=${rel}`);
});

test('release depends on push success and on the lane having run', () => {
  const push = steps[idx('Push scored reviews to review-texts')];
  const rel = steps[idx('Release night lease')];
  assert.equal(push.id, 'push');
  assert.match(rel.cond, /steps\.push\.outcome == 'success'/);
  assert.match(rel.cond, /steps\.lane\.outcome != 'skipped'/);
  assert.match(rel.body, /opening-night-lease\.js release/);
  assert.match(rel.body, /--holder=\$\{OPENING_NIGHT_LANE_HOLDER\}/);
});

test('the lane step defers its release to the workflow and nothing releases before the push', () => {
  const lane = steps[idx('Run the lane')];
  assert.match(lane.body, /OPENING_NIGHT_LANE_RELEASE_BY_WORKFLOW: '1'/);
  const push = idx('Push scored reviews to review-texts');
  steps.slice(0, push).forEach((s) => assert.doesNotMatch(s.body, /opening-night-lease\.js release/, s.name));
  // the CLI turns the driver's release into a renewal under that env var
  assert.match(cli, /OPENING_NIGHT_LANE_RELEASE_BY_WORKFLOW === '1'/);
  assert.match(cli, /deps\.release = /);
});

test('a failed push still reaches the failure page', () => {
  const notify = steps[idx('Notify on failure')];
  assert.match(notify.cond, /failure\(\)/);
});
