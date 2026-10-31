// BRO-4408: opening-night-poller.yml must drain _pending/ no-byline strands
// for the in-window shows before the poll loop, with the BD breaker exemption.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { isExemptCaller, DEFAULT_EXEMPT_SCRIPTS } = require('./brightdata-caps.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const wf = fs.readFileSync(path.join(here, '../../.github/workflows/opening-night-poller.yml'), 'utf8');

// Split the steps of the job by "      - name:" markers (6-space indent).
const steps = wf.split(/\n(?=      - name: )/).slice(1).map(s => ({
  name: s.match(/^      - name: (.*)/)[1],
  body: s,
}));
const idx = (pred) => steps.findIndex(pred);

const drainIdx = idx(s => s.name.startsWith('Drain pending no-byline reviews (in-window'));
const pollIdx = idx(s => /^\s+id: poll$/m.test(s.body));
const commitIdx = idx(s => s.name === 'Commit new review files');
const collectIdx = idx(s => s.name === 'Collect full text inline');

test('a replay-pending-bylines step exists', () => {
  assert.ok(drainIdx >= 0);
  assert.match(steps[drainIdx].body, /run: node scripts\/replay-pending-bylines\.js/);
});

test('replay receives the in-window show list (find step output), not --all-*', () => {
  const b = steps[drainIdx].body;
  assert.match(b, /IN_WINDOW_SHOWS: \$\{\{ steps\.find\.outputs\.shows \}\}/);
  assert.match(b, /--shows="\$IN_WINDOW_SHOWS"/);
  assert.doesNotMatch(b, /run: .*\$\{\{/, 'no expression interpolation inside the shell command');
  assert.doesNotMatch(b, /--all-(open|pending|opera)/);
  assert.match(b, /--time-budget-min=4(?:\s|$)/);
});

test('replay runs before the poll loop, so any_new sees its promotions, and before commit + collect', () => {
  assert.ok(pollIdx >= 0 && commitIdx >= 0 && collectIdx >= 0);
  assert.ok(drainIdx < pollIdx, 'drain must precede poll (poll git-status sets any_new)');
  assert.ok(drainIdx < commitIdx && drainIdx < collectIdx);
});

test('replay leaves promotions uncommitted (no git commit/push in the step)', () => {
  assert.doesNotMatch(steps[drainIdx].body, /git (commit|push)/);
});

test('replay is exempt from the BD breaker and cannot fail the job', () => {
  const b = steps[drainIdx].body;
  assert.match(b, /BD_OPENING_NIGHT: '1'/);
  assert.match(b, /BRIGHTDATA_TOKEN:/);
  assert.match(b, /continue-on-error: true/);
  assert.match(b, /if: steps\.find\.outputs\.has_shows == 'true'/);
});

test('poll step derives any_new from review-texts git status (the seeding the drain relies on)', () => {
  assert.match(steps[pollIdx].body, /cd data\/review-texts && git status --porcelain/);
});

// Run the workflow's actual replay command and the real CLI promotion writer.
// Only external inputs are substituted: shows.json and fetchPage responses.
// Each child writes to its own directory, never the private review-texts clone.
function replayFixture(t, entries, inWindowIds, dryRun = false) {
  const repo = path.resolve(here, '../..');
  const scratch = fs.mkdtempSync(path.join(repo, 'data/.test-pending-drain-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'review-texts');
  const fetchLog = path.join(scratch, 'fetches.jsonl');
  const shows = entries.map(entry => entry.show);
  const responses = Object.fromEntries(entries.map(entry => [entry.review.url, entry.html]));
  for (const entry of entries) {
    const dir = path.join(root, '_pending', entry.show.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'thewrap--pending.json'), JSON.stringify(entry.review));
  }
  const inputs = path.join(scratch, 'inputs.json');
  fs.writeFileSync(inputs, JSON.stringify({ shows, responses }));
  const preload = path.join(scratch, 'inputs.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const read = fs.readFileSync;
    const inputs = JSON.parse(read(process.env.REPLAY_TEST_INPUTS, 'utf8'));
    const showsPath = path.join(process.cwd(), 'data/shows.json');
    fs.readFileSync = function(file, ...args) {
      if (typeof file === 'string' && path.resolve(file) === showsPath) {
        return JSON.stringify({ shows: inputs.shows });
      }
      return read.call(this, file, ...args);
    };
    const scraperPath = require.resolve(path.join(process.cwd(), 'scripts/lib/scraper.js'));
    require.cache[scraperPath] = { id: scraperPath, filename: scraperPath, loaded: true, exports: {
      fetchPage: async (url) => {
        fs.appendFileSync(process.env.REPLAY_TEST_FETCH_LOG, JSON.stringify({
          url, openingNight: process.env.BD_OPENING_NIGHT
        }) + '\\n');
        if (!Object.hasOwn(inputs.responses, url)) throw new Error('Unexpected fixture URL');
        return { content: inputs.responses[url], source: 'fixture' };
      },
      cleanup: async () => {}
    } };
  `);
  const result = spawnSync('bash', ['-c', steps[drainIdx].body.match(/^\s+run: (.*)$/m)[1]
    + (dryRun ? ' --dry-run' : '')], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${preload}`,
      REVIEW_TEXTS_DIR: root,
      IN_WINDOW_SHOWS: inWindowIds.join(','),
      BD_OPENING_NIGHT: steps[drainIdx].body.match(/BD_OPENING_NIGHT: '(.*?)'/)[1],
      REPLAY_TEST_INPUTS: inputs,
      REPLAY_TEST_FETCH_LOG: fetchLog,
    },
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr + result.stdout);
  const fetches = fs.existsSync(fetchLog)
    ? fs.readFileSync(fetchLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, fetches, stdout: result.stdout };
}

function strand(id, title, category = 'broadway', author = 'Robert Hofler') {
  return {
    show: { id, title, category, status: 'open', openingDate: '2026-09-29' },
    review: { showId: id, outletId: 'thewrap', criticName: 'Unknown',
      pendingReason: 'no-byline', contentTier: 'stub', url: `https://www.thewrap.com/${id}-review/` },
    html: `<html><head><title>${title} theatre review</title>
      ${author ? `<meta name="author" content="${author}">` : ''}
      <meta property="article:published_time" content="2026-09-29T22:00:00Z">
      </head><body>${title} theatre review</body></html>`,
  };
}

test('workflow replay promotes in-window strands into the collection directory, leaving other shows alone', t => {
  const entries = [strand('broadway-in-window', 'Hamlet'),
    strand('west-end-in-window', 'Shadowlands', 'west-end'),
    strand('off-broadway-in-window', 'Degenerates', 'off-broadway')];
  const outside = strand('outside-window', 'Wicked');
  const { root, fetches, stdout } = replayFixture(t, [...entries, outside], entries.map(e => e.show.id));
  assert.match(stdout, /Processing 3 show\(s\)/);
  assert.match(stdout, /Promoted: 3/);
  assert.deepEqual(fetches.map(f => f.url), entries.map(e => e.review.url));
  assert.ok(fetches.every(f => f.openingNight === '1'));
  // The existing workflow starts collection after this command completes.
  assert.ok(drainIdx < collectIdx);
  assert.match(steps[collectIdx].body, /SHOW_FILTER: \$\{\{ steps\.find\.outputs\.shows \}\}/);
  assert.match(steps[collectIdx].body, /run: node scripts\/collect-review-texts\.js/);
  for (const entry of entries) {
    const promoted = path.join(root, entry.show.id, 'thewrap--robert-hofler.json');
    const review = JSON.parse(fs.readFileSync(promoted, 'utf8'));
    assert.equal(review.criticName, 'Robert Hofler');
    assert.equal(review.bylineSource, 'replay-pending-bylines');
    assert.equal(review.needsTextRetry, true);
    assert.equal(review.url, entry.review.url);
    assert.ok(!fs.existsSync(path.join(root, '_pending', entry.show.id, 'thewrap--pending.json')));
  }
  assert.ok(fs.existsSync(path.join(root, '_pending', outside.show.id, 'thewrap--pending.json')));
  assert.ok(!fs.existsSync(path.join(root, outside.show.id)));
});

test('replay retains an unresolved byline and a wrong-show strand', t => {
  const noByline = strand('no-byline', 'Hamlet', 'broadway', null);
  const wrongShow = strand('wrong-show', 'Shadowlands');
  wrongShow.html = '<html><head><title>Wicked review</title></head><body>Wicked review</body></html>';
  const entries = [noByline, wrongShow];
  const { root, stdout } = replayFixture(t, entries, entries.map(e => e.show.id));
  assert.match(stdout, /Promoted: 0/);
  assert.match(stdout, /Kept in _pending: 2/);
  for (const entry of entries) {
    assert.ok(fs.existsSync(path.join(root, '_pending', entry.show.id, 'thewrap--pending.json')));
    assert.ok(!fs.existsSync(path.join(root, entry.show.id)));
  }
  const rejected = JSON.parse(fs.readFileSync(path.join(root, '_pending', wrongShow.show.id,
    'thewrap--pending.json'), 'utf8'));
  assert.match(rejected.promoteSkippedReason, /not this show/);
});

test('dry-run reports the promotion without moving the strand', t => {
  const entry = strand('dry-run', 'Hamlet');
  const { root, stdout } = replayFixture(t, [entry], [entry.show.id], true);
  assert.match(stdout, /DRY.*would promote to thewrap--robert-hofler.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '_pending', entry.show.id,
    'thewrap--pending.json'), 'utf8')), entry.review);
  assert.ok(!fs.existsSync(path.join(root, entry.show.id)));
});

test('in-window replay and collection bypass the BD breaker; a manual SHOW_FILTER alone does not', () => {
  for (const [step, script] of [[drainIdx, 'replay-pending-bylines.js'], [collectIdx, 'collect-review-texts.js']]) {
    const marker = steps[step].body.match(/BD_OPENING_NIGHT: '(.*?)'/)[1];
    assert.equal(isExemptCaller(script, DEFAULT_EXEMPT_SCRIPTS, null, marker), true);
    assert.equal(isExemptCaller(script, DEFAULT_EXEMPT_SCRIPTS), false);
  }
});
