// TESTS-VS-DERIVED-DATA-EXEMPT: synthetic show lists only; the wiring tests read the workflow YAML.
/**
 * BRO-5479 (owner decision 2026-10-16): a poller failure emails the owner right
 * away when a Broadway show is in the poll; other markets go through the
 * auto-fix-first gate (BRO-5477). Pattern: require() the real function (rule 15).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { parseShowIds, isBroadwayPoll } = require('../../scripts/poller-failure-audience.js');

const SHOWS = [
  { id: 'bway-show', category: 'broadway' },
  { id: 'ob-show', category: 'off-broadway' },
  { id: 'we-show', category: 'west-end' },
  { id: 'owe-show', category: 'off-west-end' },
  { id: 'no-category-show' },
];

describe('isBroadwayPoll', () => {
  test('a Broadway show anywhere in the poll counts', () => {
    assert.equal(isBroadwayPoll(parseShowIds('we-show, bway-show'), SHOWS), true);
  });
  test('only non-Broadway shows (Off-Broadway included) do not', () => {
    assert.equal(isBroadwayPoll(['ob-show', 'we-show', 'owe-show'], SHOWS), false);
  });
  test('fails open: empty poll, unknown id, missing category, unreadable shows.json', () => {
    assert.equal(isBroadwayPoll([], SHOWS), true);
    assert.equal(isBroadwayPoll(['not-in-shows-json'], SHOWS), true);
    assert.equal(isBroadwayPoll(['no-category-show'], SHOWS), true);
    assert.equal(isBroadwayPoll(['we-show'], null), true);
  });
});

describe('isBroadwayPoll: only Broadway openings email right away', () => {
  const NOW = new Date('2026-10-21T16:10:00Z');
  const dated = (openingDate) => [{ id: 'b', category: 'broadway', openingDate }];
  test('opening night and the 3 days after count', () => {
    assert.equal(isBroadwayPoll(['b'], dated('2026-10-21'), NOW), true);
    assert.equal(isBroadwayPoll(['b'], dated('2026-10-19'), NOW), true);
  });
  test('the day before opening counts', () => {
    assert.equal(isBroadwayPoll(['b'], dated('2026-10-22'), NOW), true);
  });
  test('a Broadway show past its opening window does not (Other Desert Cities, 2026-10-21)', () => {
    const shows = [
      { id: 'other-desert-cities-2026', category: 'broadway', openingDate: '2026-10-18' },
      { id: 'fish-off-broadway-2026', category: 'off-broadway', openingDate: '2026-10-20' },
    ];
    assert.equal(isBroadwayPoll(['fish-off-broadway-2026', 'other-desert-cities-2026'], shows, NOW), false);
  });
  test('a Broadway show weeks out does not', () => {
    assert.equal(isBroadwayPoll(['b'], dated('2026-11-20'), NOW), false);
  });
  test('fails open on a missing or unparseable openingDate', () => {
    assert.equal(isBroadwayPoll(['b'], dated(null), NOW), true);
    assert.equal(isBroadwayPoll(['b'], dated('TBA'), NOW), true);
  });
  test('an Off-Broadway show in its opening window still does not', () => {
    assert.equal(isBroadwayPoll(['o'], [{ id: 'o', category: 'off-broadway', openingDate: '2026-10-21' }], NOW), false);
  });
});

describe('opening-night-poller.yml wiring', () => {
  const doc = yaml.load(fs.readFileSync(path.join(process.cwd(), '.github/workflows/opening-night-poller.yml'), 'utf8'));
  const steps = doc.jobs.poll.steps;
  const audienceIdx = steps.findIndex((s) => s.id === 'audience');
  const notifyIdx = steps.findIndex((s) => s.id === 'notify');
  const notify = steps[notifyIdx];
  const action = yaml.load(fs.readFileSync(path.join(process.cwd(), '.github/actions/notify-failure/action.yml'), 'utf8'));
  const send = action.runs.steps.find((s) => s.name === 'Send failure alert');

  test('audience is classified before Notify reads it', () => {
    assert.ok(audienceIdx >= 0 && audienceIdx < notifyIdx);
  });
  test('every failure still goes through the auto-fix gate (kill switch kept)', () => {
    assert.match(String(notify.with.auto_fix_first), /vars\.AUTO_FIX_FIRST_DISABLED != 'true'/);
    assert.doesNotMatch(String(notify.with.auto_fix_first), /audience/);
  });
  test('a Broadway or unknown poll also emails: only an explicit broadway=false turns it off', () => {
    assert.match(String(notify.with.email_with_auto_fix), /steps\.audience\.outputs\.broadway != 'false' && 'true' \|\| 'false'/);
  });
  test('the extra email goes out only when the gate held the alert, never after the gate emailed itself', () => {
    assert.match(String(send.if), /inputs\.email_with_auto_fix == 'true' && steps\.autofix\.outputs\.held == 'true'/);
    assert.match(String(send.if), /steps\.autofix\.outputs\.handled != 'true'/);
  });
});
