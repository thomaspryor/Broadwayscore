// BRO-7386: an unsent opening-night draft must keep following the site's
// numbers after its show leaves the 2-day opening window and whether or not
// the show is on the workflow's drafting readiness list. Cloud 9
// (cloud-9-west-end-2026, press night 2026-11-10) kept 81 from 12 reviews
// while the site showed 77 from 18: the refresh was picked inside the drafting
// gates, and the script's own lookback exited before looking at the draft.
//
// require()s the real functions (CLAUDE.md rule 15); the workflow checks read
// the real opening-night-broadcast.yml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { selectCandidateShows } = require(path.join(ROOT, 'scripts', 'send-opening-night-broadcast.js'));
const { refreshPlanByMarket, unsentDraftShowsForUpdate } = require(path.join(ROOT, 'scripts', 'lib', 'broadcast-refresh.js'));
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'opening-night-broadcast.yml'), 'utf8');

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const ID = 'cloud-9-west-end-2026';
const KEY = `west-end:${ID}`;

function cloud9Tracker() {
  const draft = {
    draftCreatedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(),
    draftStatus: 'draft', draftId: '484a04d4-test', completed: true, sentAt: null,
    method: 'resend-draft', reviewCount: 12,
    draftNumbers: { [ID]: { score: 81, reviewCount: 12 } },
  };
  return { [KEY]: draft, [ID]: { ...draft, broadcastKey: KEY } };
}
const cloud9 = { id: ID, title: 'Cloud 9', status: 'open', category: 'west-end', openingDate: daysAgo(5) };
const siteNow = (id) => (id === ID ? { score: 77, reviewCount: 18 } : null);

test('(a) a show opened beyond the lookback with a stale 81/12 draft is still refreshed (site 77/18)', () => {
  const sel = selectCandidateShows([cloud9], cloud9Tracker(), {
    updateUnsent: true, lookbackDays: 2, allowedIds: new Set([ID]), market: 'west-end',
  });
  assert.deepEqual(sel.shows.map((s) => s.id), [ID], 'the --update-unsent-draft run must pick the draft, not exit on the lookback');

  const plan = refreshPlanByMarket(cloud9Tracker(), siteNow);
  assert.deepEqual(plan['west-end'], [ID]);
  assert.deepEqual(plan.shows, [ID]);
  assert.deepEqual(plan.moved[0].was, { [ID]: { score: 81, reviewCount: 12 } });
  assert.deepEqual(plan.moved[0].now, { [ID]: { score: 77, reviewCount: 18 } });
});

test('(b) a show missing from the readiness list is still refreshed', () => {
  // refreshPlanByMarket takes no ready set at all: the readiness list decides
  // drafting only. The workflow step must call it that way and must not sit
  // behind the drafting gates.
  assert.equal(refreshPlanByMarket.length, 2, 'refreshPlanByMarket must not take a ready-set filter');
  assert.deepEqual(refreshPlanByMarket(cloud9Tracker(), siteNow).shows, [ID]);

  const stepStart = WORKFLOW.indexOf('      - name: Find unsent drafts whose numbers moved');
  assert.ok(stepStart !== -1, 'refresh step missing');
  const stepEnd = WORKFLOW.indexOf('\n      - name:', stepStart + 10);
  const step = WORKFLOW.slice(stepStart, stepEnd);
  assert.match(step, /id: refresh\n/);
  assert.doesNotMatch(step, /^\s+if:/m, 'refresh selection must not be gated (no if:)');
  assert.doesNotMatch(step, /steps\.(find|time_gate|readiness_gate|check)\./, 'refresh selection must not read the drafting gates');
  assert.match(step, /refreshPlanByMarket\(sent, readShowNumbers\)/);
  assert.ok(stepStart < WORKFLOW.indexOf('      - name: Find recently opened shows'), 'refresh selection runs before the opening-window lookup');

  // The check step no longer computes refreshes against its ready list.
  const check = WORKFLOW.slice(WORKFLOW.indexOf('      - name: Check already broadcast'), WORKFLOW.indexOf('      - name: Shows for the QA gates'));
  assert.doesNotMatch(check, /draftsNeedingRefresh|refresh_shows/);
  // Everything downstream reads the refresh step's outputs, not the check step's.
  assert.doesNotMatch(WORKFLOW, /steps\.check\.outputs\.(refresh_|gate_shows)/);
});

test('the update step runs before draft creation and its output is persisted on refresh-only runs', () => {
  const update = WORKFLOW.indexOf('      - name: Update unsent drafts with new numbers');
  const create = WORKFLOW.indexOf('      - name: Create broadcast draft');
  assert.ok(update !== -1 && create !== -1 && update < create, 'update step must precede Create broadcast draft');
  const updateStep = WORKFLOW.slice(update, WORKFLOW.indexOf('\n      - name:', update + 10));
  assert.match(updateStep, /if: steps\.refresh\.outputs\.refresh_shows != ''/);
  assert.doesNotMatch(updateStep, /broadcasts\/[^\s]*\/send/);
  for (const name of ['Commit data', 'Push core data to private repo', 'Remind owner about unsent drafts']) {
    const i = WORKFLOW.indexOf(`      - name: ${name}\n`);
    assert.ok(i !== -1, `${name} missing`);
    const ifLine = WORKFLOW.slice(i).match(/\n\s+if: (.*)\n/)[1];
    assert.match(ifLine, /steps\.refresh\.outputs\.refresh_shows != ''/, `${name} must also run when only a refresh happened`);
  }
});

test('the normal draft path keeps its lookback and allow-list; update targets are per market', () => {
  const bway = { id: 'old-bway', title: 'Old', status: 'open', category: 'broadway', openingDate: daysAgo(5) };
  const sel = selectCandidateShows([bway], {}, { updateUnsent: false, lookbackDays: 2, allowedIds: null, market: 'broadway' });
  assert.deepEqual(sel.shows, [], 'a show past the lookback is not drafted');
  assert.deepEqual(unsentDraftShowsForUpdate(cloud9Tracker(), [cloud9], 'broadway'), [], 'a West End draft is not a Broadway target');
  assert.deepEqual(unsentDraftShowsForUpdate(cloud9Tracker(), [cloud9], 'west-end', ['other']), [], '--shows still narrows');
  const sentDraft = cloud9Tracker();
  sentDraft[KEY].sentAt = new Date().toISOString();
  assert.deepEqual(unsentDraftShowsForUpdate(sentDraft, [cloud9], 'west-end'), [], 'a sent draft is never a target');
});

test('an abandoned draft older than 30 days is no longer followed; a failed update cannot cancel the new draft', () => {
  const old = cloud9Tracker();
  old[KEY].draftCreatedAt = new Date(Date.now() - 45 * 86_400_000).toISOString();
  assert.deepEqual(unsentDraftShowsForUpdate(old, [cloud9], 'west-end'), [], 'a 45-day-old draft is not a target');
  assert.equal(refreshPlanByMarket(old, () => null).shows.length, 0);
  for (const name of ['Create broadcast draft (owner sends manually from Resend)', 'Gather more reviews if not ready']) {
    const i = WORKFLOW.indexOf(`      - name: ${name}\n`);
    assert.ok(i !== -1, `${name} missing`);
    assert.match(WORKFLOW.slice(i).match(/\n\s+if: (.*)\n/)[1], /^\(!cancelled\(\)\)/, `${name} must not be skipped by a red update step`);
  }
});
