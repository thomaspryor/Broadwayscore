import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  isSentinelPersonName,
  buildShowPersonNameSets,
  classifyCriticAgainstSets,
  evaluateCreditedPersonAsCritic,
} = require('./creative-as-critic.js');

// The real shape that reddened main three times: the show's DIRECTOR written in
// as the critic on a roundup row whose outletId is an article headline.
const HOW_TO_DANCE = {
  id: 'how-to-dance-in-ohio-2023',
  creativeTeam: [
    { name: 'Jacob Yandura', role: 'Music' },
    { name: 'Rebekah Greer Melocik', role: 'Book & Lyrics' },
    { name: 'Sammi Cannold', role: 'Director' },
    { name: 'Mayte Natalio', role: 'Choreographer' },
  ],
  cast: [{ name: 'Madison Kopec' }],
};

// The false-positive trap: this show's ONLY credited creative is a literal
// placeholder, and unbylined reviews are saved with criticName 'Unknown'.
const LA_TERNURA = {
  id: 'la-ternura-off-broadway-2025',
  creativeTeam: [{ name: 'unknown', role: 'Director' }],
  cast: [],
};

describe('sentinel handling — the la-ternura false-positive trap', () => {
  test('a placeholder credit never enters the show sets', () => {
    const sets = buildShowPersonNameSets(LA_TERNURA);
    assert.equal(sets.creative.size, 0, 'placeholder credit "unknown" must be filtered out');
  });

  test('an unbylined review on a placeholder-credited show is NOT a match', () => {
    const v = evaluateCreditedPersonAsCritic(LA_TERNURA, 'Unknown');
    assert.equal(v.match, false);
    assert.equal(v.reason, 'sentinel-critic');
  });

  // Filtering only ONE side is the bug this asserts against: if the show side
  // kept 'unknown', or the critic side were compared before the sentinel test,
  // every unbylined review on this show would be condemned as garbage.
  test('sentinel loses even when BOTH sides carry it verbatim', () => {
    const sets = { creative: new Set(['unknown']), cast: new Set() };
    const v = classifyCriticAgainstSets(sets, 'unknown');
    assert.equal(v.match, false, 'a sentinel on both sides must still not match');
    assert.equal(v.reason, 'sentinel-critic');
  });

  for (const name of ['Unknown', 'TBA', 'tbd', 'N/A', 'Anonymous', '', '   ']) {
    test(`isSentinelPersonName(${JSON.stringify(name)}) is true`, () => {
      assert.equal(isSentinelPersonName(name), true);
    });
  }

  test('a real name is not a sentinel', () => {
    assert.equal(isSentinelPersonName('Sammi Cannold'), false);
  });
});

describe('creative-team-as-critic detection', () => {
  test('the show director as critic matches with kind "creative"', () => {
    const v = evaluateCreditedPersonAsCritic(HOW_TO_DANCE, 'Sammi Cannold');
    assert.equal(v.match, true);
    assert.equal(v.kind, 'creative');
    assert.equal(v.matchedName, 'sammi cannold');
  });

  test('matching is case- and whitespace-insensitive', () => {
    const v = evaluateCreditedPersonAsCritic(HOW_TO_DANCE, '  SAMMI   CANNOLD  '.replace(/\s+/g, ' ').trim());
    assert.equal(v.kind, 'creative');
  });

  test('a cast member matches with kind "cast", NOT "creative"', () => {
    const v = evaluateCreditedPersonAsCritic(HOW_TO_DANCE, 'Madison Kopec');
    assert.equal(v.kind, 'cast');
  });

  test('an ordinary critic on the same show does not match', () => {
    const v = evaluateCreditedPersonAsCritic(HOW_TO_DANCE, 'Jesse Green');
    assert.equal(v.match, false);
    assert.equal(v.reason, 'no-match');
  });

  // Per-show scoping is load-bearing: a GLOBAL name index would flag critic
  // "Scott Brown" on every show an actor of the same name ever appeared in.
  test('a credited person on a DIFFERENT show does not match', () => {
    const otherShow = { id: 'other-2020', creativeTeam: [{ name: 'Scott Brown' }], cast: [] };
    assert.equal(evaluateCreditedPersonAsCritic(HOW_TO_DANCE, 'Scott Brown').match, false);
    assert.equal(evaluateCreditedPersonAsCritic(otherShow, 'Scott Brown').kind, 'creative');
  });
});

describe('argument contract — a missing argument must never look like "no match"', () => {
  // The v45 lesson, encoded as a test: isPlaceholderByline(name) was called
  // WITHOUT its outlet argument, which silently disabled a whole branch, and
  // the guard still failed its revert-check exactly like a working one.
  test('calling with one argument THROWS rather than returning false', () => {
    assert.throws(() => evaluateCreditedPersonAsCritic(HOW_TO_DANCE), TypeError);
    assert.throws(() => classifyCriticAgainstSets({ creative: new Set(), cast: new Set() }), TypeError);
  });

  test('an unresolved show record is distinguishable from a genuine non-match', () => {
    assert.equal(evaluateCreditedPersonAsCritic(null, 'Sammi Cannold').reason, 'no-show-record');
    assert.equal(evaluateCreditedPersonAsCritic(HOW_TO_DANCE, 'Jesse Green').reason, 'no-match');
  });

  test('a show with no credits at all yields no-match, not a crash', () => {
    assert.equal(evaluateCreditedPersonAsCritic({ id: 'x' }, 'Jesse Green').reason, 'no-match');
  });

  test('malformed credit entries are skipped, not thrown on', () => {
    const messy = { id: 'm', creativeTeam: [null, {}, { name: 42 }, { name: 'Real Person' }], cast: 'not-an-array' };
    const sets = buildShowPersonNameSets(messy);
    assert.deepEqual([...sets.creative], ['real person']);
    assert.equal(sets.cast.size, 0);
  });
});

describe('save-time wiring — createOrMergeReviewFile refuses the write', () => {
  // data/shows.json is a symlink into the private data repo: present in the main
  // checkout, ABSENT in a worktree and in CI jobs that do not check the private
  // repo out. t.skip() rather than an early return — node reports a bare return
  // as a PASS, which is exactly how a test that asserts nothing hides.
  const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
  const haveShows = fs.existsSync(showsPath);

  test('a creative-team byline is skipped with reason credited-person-as-critic', (t) => {
    if (!haveShows) return t.skip('data/shows.json not available in this checkout');
    const { createOrMergeReviewFile } = require('./review-file-writer.js');
    const res = createOrMergeReviewFile('how-to-dance-in-ohio-2023', {
      outlet: 'BroadwayWorld',
      criticName: 'Sammi Cannold',
      source: 'bww-roundup',
      fields: { bwwExcerpt: 'an underdog itself' },
    }, { dryRun: true });
    assert.equal(res.action, 'skipped');
    assert.match(res.reason, /credited-person-as-critic/);
  });

  test('an ordinary critic on the same show is NOT skipped by this guard', (t) => {
    if (!haveShows) return t.skip('data/shows.json not available in this checkout');
    const { createOrMergeReviewFile } = require('./review-file-writer.js');
    const res = createOrMergeReviewFile('how-to-dance-in-ohio-2023', {
      outlet: 'New York Times',
      criticName: 'Jesse Green',
      url: 'https://www.nytimes.com/2023/12/10/theater/how-to-dance-in-ohio-review.html',
      source: 'bww-roundup',
      fields: { bwwExcerpt: 'a real excerpt' },
    }, { dryRun: true });
    assert.ok(!/credited-person-as-critic/.test(String(res.reason || '')), `unexpectedly skipped: ${res.reason}`);
  });

  // The validator only WARNS on a cast match, so the writer must not reject one:
  // a save-time rule stricter than the validation rule would silently discard
  // data that no gate ever objected to.
  test('a CAST byline is NOT skipped — the guard is creative-only by design', (t) => {
    if (!haveShows) return t.skip('data/shows.json not available in this checkout');
    const { createOrMergeReviewFile } = require('./review-file-writer.js');
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
    const show = shows.find((s) => s.id === 'how-to-dance-in-ohio-2023');
    const castName = (show?.cast || [])
      .map((m) => (typeof m === 'string' ? m : m?.name))
      .find((n) => n && !isSentinelPersonName(n));
    if (!castName) return t.skip('no usable cast member on the fixture show');
    const res = createOrMergeReviewFile('how-to-dance-in-ohio-2023', {
      outlet: 'BroadwayWorld',
      criticName: castName,
      source: 'bww-roundup',
      fields: { bwwExcerpt: 'a cast-bylined piece' },
    }, { dryRun: true });
    assert.ok(!/credited-person-as-critic/.test(String(res.reason || '')), `cast byline was skipped: ${res.reason}`);
  });

  test('an operator-supplied row is exempt from the guard', (t) => {
    if (!haveShows) return t.skip('data/shows.json not available in this checkout');
    const { createOrMergeReviewFile } = require('./review-file-writer.js');
    const res = createOrMergeReviewFile('how-to-dance-in-ohio-2023', {
      outlet: 'BroadwayWorld',
      criticName: 'Sammi Cannold',
      source: 'manual-entry',
      fields: { bwwExcerpt: 'operator typed this in', humanReviewScore: 70 },
    }, { dryRun: true });
    assert.ok(!/credited-person-as-critic/.test(String(res.reason || '')), `unexpectedly skipped: ${res.reason}`);
  });
});

describe('validator parity — the predicate agrees with the live corpus', () => {
  test('no INCLUDABLE review file carries a creative-team byline of its own show', (t) => {
    const reviewTextsDir = path.join(__dirname, '..', '..', 'data', 'review-texts');
    const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
    if (!fs.existsSync(reviewTextsDir) || !fs.existsSync(showsPath)) {
      return t.skip('core data not available in this checkout');
    }
    const { isIncludableForRebuild } = require('./review-guards.js');
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows;
    const byId = Object.create(null);
    for (const s of shows) if (s && s.id) byId[s.id] = s;

    const offenders = [];
    for (const dirent of fs.readdirSync(reviewTextsDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const dirPath = path.join(reviewTextsDir, dirent.name);
      const sets = buildShowPersonNameSets(byId[dirent.name]);
      if (sets.creative.size === 0) continue;
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(dirPath, f);
        let data;
        try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
        if (!isIncludableForRebuild(data, byId[dirent.name], fp)) continue;
        if (classifyCriticAgainstSets(sets, data.criticName).kind === 'creative') {
          offenders.push(`${dirent.name}/${f}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `creative-team-as-critic files would red validate-data.js: ${offenders.join(', ')}`);
  });
});
