import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const emptyCastCheck = require('../../scripts/lib/opening-night-checks/empty-cast.check.js');
const placeholderSynopsisCheck = require('../../scripts/lib/opening-night-checks/placeholder-synopsis.check.js');
const staleUpcomingCheck = require('../../scripts/lib/opening-night-checks/stale-upcoming-tag.check.js');
const revivalCheck = require('../../scripts/lib/opening-night-checks/revival-unverified.check.js');

function makeContext(overrides = {}) {
  return {
    reviewsDoc: {},
    reviewTextsRoot: '/tmp/does-not-exist',
    driftState: {},
    criticConsensusDoc: {},
    now: new Date(),
    shows: [],
    ...overrides,
  };
}

describe('empty-cast check', () => {
  it('fixture show with empty cast (Whoopi-Monologues class bug) → warning', () => {
    const show = { id: 'the-whoopi-monologues-off-broadway-2026', status: 'open', cast: [] };
    const result = emptyCastCheck.run(show, makeContext());
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /cast is empty/);
  });

  it('non-empty cast → ok', () => {
    const show = { id: 'test-2026', status: 'open', cast: [{ name: 'Kerry Washington' }] };
    const result = emptyCastCheck.run(show, makeContext());
    assert.equal(result.ok, true);
  });

  it('closed historical show with empty cast → ok (out of scope)', () => {
    const show = { id: 'whoopi-goldberg-1984', status: 'closed', cast: [] };
    const result = emptyCastCheck.run(show, makeContext());
    assert.equal(result.ok, true);
  });
});

describe('placeholder-synopsis check', () => {
  it('fixture show with templated placeholder synopsis → warning', () => {
    const show = {
      id: 'the-whoopi-monologues-off-broadway-2026',
      status: 'open',
      synopsis: 'brings back characters, stories, and monologues by the acclaimed comedian in this special theatrical experience',
    };
    const result = placeholderSynopsisCheck.run(show, makeContext());
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
  });

  it('real synopsis over min length → ok', () => {
    const show = {
      id: 'test-2026',
      status: 'open',
      synopsis: '*The Whoopi Monologues* revives the characters from Whoopi Goldberg\'s landmark 1984 Broadway solo show, reimagined by director Whitney White for a cast of five: Kerry Washington, Kara Young, Dominique Fishback, Danielle Pinnock, and Kecia Lewis.',
    };
    const result = placeholderSynopsisCheck.run(show, makeContext());
    assert.equal(result.ok, true);
  });

  it('empty synopsis on closed historical show → ok (out of scope)', () => {
    const show = { id: 'whoopi-goldberg-1984', status: 'closed', synopsis: '' };
    const result = placeholderSynopsisCheck.run(show, makeContext());
    assert.equal(result.ok, true);
  });
});

describe('stale-upcoming-tag check', () => {
  it('status=open with upcoming tag → warning', () => {
    const show = { id: 'joe-turners-come-and-gone-2026', status: 'open', tags: ['upcoming', 'revival', 'lottery', 'rush'] };
    const result = staleUpcomingCheck.run(show, makeContext());
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /fix-stale-upcoming-tags/);
  });

  it('status=previews with upcoming tag → ok (not stale yet)', () => {
    const show = { id: 'test-2026', status: 'previews', tags: ['upcoming'] };
    const result = staleUpcomingCheck.run(show, makeContext());
    assert.equal(result.ok, true);
  });

  it('status=open with no upcoming tag → ok', () => {
    const show = { id: 'test-2026', status: 'open', tags: ['lottery'] };
    const result = staleUpcomingCheck.run(show, makeContext());
    assert.equal(result.ok, true);
  });
});

describe('revival-unverified check', () => {
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ont-revival-'));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('shares canonical title with an earlier show but isRevival is false → warning', () => {
    const show = { id: 'death-of-a-salesman-2026', status: 'open', isRevival: false, title: 'Death of a Salesman' };
    const shows = [
      show,
      { id: 'death-of-a-salesman-2012', title: 'Death of a Salesman' },
    ];
    const result = revivalCheck.run(show, makeContext({ shows }));
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /isRevival is not true/);
  });

  it('isRevival already true → ok', () => {
    const show = { id: 'death-of-a-salesman-2026', status: 'open', isRevival: true, title: 'Death of a Salesman' };
    const shows = [show, { id: 'death-of-a-salesman-2012', title: 'Death of a Salesman' }];
    const result = revivalCheck.run(show, makeContext({ shows }));
    assert.equal(result.ok, true);
  });

  it('same title, different market (transfer, not revival) → ok (regression: Hamilton/Wicked/Hadestown/Oh Mary FP)', () => {
    const show = { id: 'hamilton-west-end-2021', status: 'open', isRevival: false, title: 'Hamilton', market: 'west-end' };
    const shows = [show, { id: 'hamilton-2015', title: 'Hamilton', market: 'broadway' }];
    const result = revivalCheck.run(show, makeContext({ shows }));
    assert.equal(result.ok, true);
  });

  it('no title match, review text mentions "revival" 3+ times → warning', () => {
    const showId = 'retitled-revival-2026';
    const showDir = path.join(tmpRoot, showId);
    fs.mkdirSync(showDir, { recursive: true });
    fs.writeFileSync(path.join(showDir, 'nytimes--critic.json'), JSON.stringify({
      fullText: 'This revival reimagines the material. As a revival it succeeds. A rare revival done right.',
    }));

    const show = { id: showId, status: 'open', isRevival: false, title: 'Something New' };
    const result = revivalCheck.run(show, makeContext({ shows: [show], reviewTextsRoot: tmpRoot }));
    assert.equal(result.ok, false);
    assert.match(result.message, /mentions "revival" 3x/);
  });

  it('no title match, review text mentions "revival" only once → ok', () => {
    const showId = 'genuinely-new-2026';
    const showDir = path.join(tmpRoot, showId);
    fs.mkdirSync(showDir, { recursive: true });
    fs.writeFileSync(path.join(showDir, 'nytimes--critic.json'), JSON.stringify({
      fullText: 'A brand new play with no revival in sight.',
    }));

    const show = { id: showId, status: 'open', isRevival: false, title: 'Something Brand New' };
    const result = revivalCheck.run(show, makeContext({ shows: [show], reviewTextsRoot: tmpRoot }));
    assert.equal(result.ok, true);
  });

  it('closed historical show → ok (out of scope)', () => {
    const show = { id: 'whoopi-goldberg-1984', status: 'closed', isRevival: false, title: 'Whoopi Goldberg' };
    const result = revivalCheck.run(show, makeContext({ shows: [show] }));
    assert.equal(result.ok, true);
  });
});
