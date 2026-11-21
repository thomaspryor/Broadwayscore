// Sweep closes the parked-submission card when it closes the issue, and finds
// a review filed under a different show than the one the validator named (#1178).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sweepSubmissions } = require('./submission-sweep.js');

const URL = 'https://nystagereview.com/2026/11/02/waiting-for-lefty-no-no-odets/';

function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-'));
  fs.mkdirSync(path.join(dir, 'review-texts', 'show-b'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'review-texts', 'show-b', 'nysr.json'), JSON.stringify({ url: URL, contentTier: 'complete' }));
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ reviews: [{ showId: 'show-b', url: URL }] }));
  fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows: [{ id: 'show-a' }, { id: 'show-b' }] }));
  return dir;
}

test('landed submission: issue closed and the card closed', () => {
  const gh = [];
  const issue = { number: 1178, title: '[Review Submission] Waiting for Lefty', body: `### Review URL\n\n${URL}\n`, createdAt: new Date(Date.now() - 3600e3).toISOString(), labels: [{ name: 'needs-manual-review' }] };
  const runGh = (args) => { gh.push(args); return args[0] === 'issue' && args[1] === 'list' ? JSON.stringify(args.includes('needs-manual-review') ? [issue] : []) : ''; };
  const closed = [];
  sweepSubmissions({ runGh, root: root(), closeCard: (x) => { closed.push(x.issueNumber); return { closed: true, identifier: 'BRO-1' }; } });
  assert.ok(gh.some((a) => a[1] === 'close' && a[2] === '1178'));
  assert.deepEqual(closed, ['1178']);
});
