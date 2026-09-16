/**
 * BRO-2271: backward-looking pre-BRO-736 SERP wrong-production corpus audit.
 *
 * Run: node --test tests/unit/audit-corpus-contamination.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  SUSPECT_SOURCES,
  findCandidates,
  applyFlag,
  applyClear,
} = require('../../scripts/audit-corpus-contamination.js');

function makeCorpus(showFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-corpus-'));
  for (const [showId, files] of Object.entries(showFiles)) {
    const showDir = path.join(dir, showId);
    fs.mkdirSync(showDir, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(showDir, file), JSON.stringify(content, null, 2));
    }
  }
  return dir;
}

function showsMap(shows) {
  return new Map(shows.map((s) => [s.id, s]));
}

test('flags a suspect-source file whose embedded URL year is a different, undeclared production', () => {
  const dir = makeCorpus({
    'cats-2026': {
      'nyt--unknown.json': {
        showId: 'cats-2026',
        source: 'serp-discovery',
        url: 'https://www.nytimes.com/2024/06/12/theater/cats-jellicle-ball-review.html',
      },
    },
  });
  const shows = showsMap([{ id: 'cats-2026', openingDate: '2026-04-09', priorRuns: [], tourLegs: [] }]);
  const candidates = findCandidates({ showsById: shows, reviewTextsDir: dir });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].showId, 'cats-2026');
  assert.equal(candidates[0].file, 'nyt--unknown.json');
});

test('does not flag a URL year matching the opening year', () => {
  const dir = makeCorpus({
    'cats-2026': {
      'nyt--unknown.json': {
        showId: 'cats-2026',
        source: 'serp-discovery',
        url: 'https://www.nytimes.com/2026/04/09/theater/cats-review.html',
      },
    },
  });
  const shows = showsMap([{ id: 'cats-2026', openingDate: '2026-04-09' }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('does not flag a URL year covered by a declared priorRuns window', () => {
  const dir = makeCorpus({
    'cats-2026': {
      'amny--matt-windman.json': {
        showId: 'cats-2026',
        source: 'serp-discovery',
        url: 'https://www.amny.com/2024/06/12/cats-jellicle-ball-review.html',
      },
    },
  });
  const shows = showsMap([{
    id: 'cats-2026',
    openingDate: '2026-04-09',
    priorRuns: [{ openingDate: '2024-03-01', closingDate: '2024-06-30' }],
  }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('ignores non-suspect sources even with a mismatched embedded year', () => {
  const dir = makeCorpus({
    'les-mis-west-end': {
      'guardian--critic.json': {
        showId: 'les-mis-west-end',
        source: 'show-score',
        url: 'https://www.theguardian.com/stage/2025/oct/07/les-miserables-review.html',
      },
    },
  });
  const shows = showsMap([{ id: 'les-mis-west-end', openingDate: '1985-12-04' }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('skips a file already excluded via the sibling wrongShow flag', () => {
  const dir = makeCorpus({
    'into-the-woods-2022': {
      'latimes--critic.json': {
        showId: 'into-the-woods-2022',
        source: 'outlet-serp-discovery',
        url: 'https://www.latimes.com/2023/01/05/into-the-woods-review.html',
        wrongShow: true,
      },
    },
  });
  const shows = showsMap([{ id: 'into-the-woods-2022', openingDate: '2022-08-06' }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('skips a file already flagged wrongProduction', () => {
  const dir = makeCorpus({
    'cats-2026': {
      'nyt--unknown.json': {
        showId: 'cats-2026',
        source: 'serp-discovery',
        url: 'https://www.nytimes.com/2024/06/12/theater/cats-review.html',
        wrongProduction: true,
      },
    },
  });
  const shows = showsMap([{ id: 'cats-2026', openingDate: '2026-04-09' }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('skips a file already cleared by a prior audit pass', () => {
  const dir = makeCorpus({
    'eugene-onegin-2026': {
      'operawire--critic.json': {
        showId: 'eugene-onegin-2026',
        source: 'site-search',
        url: 'https://operawire.com/metropolitan-opera-2025-26-review-eugene-onegin/',
        wrongProductionAuditCleared: true,
      },
    },
  });
  const shows = showsMap([{ id: 'eugene-onegin-2026', openingDate: '2026-04-20' }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('skips shows missing from the current shows.json (orphan review dir)', () => {
  const dir = makeCorpus({
    'ghost-show': {
      'nyt--unknown.json': {
        showId: 'ghost-show',
        source: 'serp-discovery',
        url: 'https://www.nytimes.com/2020/01/01/theater/ghost-review.html',
      },
    },
  });
  assert.equal(findCandidates({ showsById: new Map(), reviewTextsDir: dir }).length, 0);
});

test('applyFlag writes wrongProduction + note and is picked up as resolved on rerun', () => {
  const dir = makeCorpus({
    'cats-2026': {
      'nyt--unknown.json': {
        showId: 'cats-2026',
        source: 'serp-discovery',
        url: 'https://www.nytimes.com/2024/06/12/theater/cats-review.html',
      },
    },
  });
  const shows = showsMap([{ id: 'cats-2026', openingDate: '2026-04-09' }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 1);

  const target = path.join(dir, 'cats-2026', 'nyt--unknown.json');
  applyFlag(target, 'test note: confirmed wrong production');

  const updated = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(updated.wrongProduction, true);
  assert.equal(updated.wrongProductionNote, 'test note: confirmed wrong production');
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('applyClear writes wrongProductionAuditCleared + note and is picked up as resolved on rerun', () => {
  const dir = makeCorpus({
    'eugene-onegin-2026': {
      'operawire--critic.json': {
        showId: 'eugene-onegin-2026',
        source: 'site-search',
        url: 'https://operawire.com/metropolitan-opera-2025-26-review-eugene-onegin/',
      },
    },
  });
  const shows = showsMap([{ id: 'eugene-onegin-2026', openingDate: '2026-04-20' }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 1);

  const target = path.join(dir, 'eugene-onegin-2026', 'operawire--critic.json');
  applyClear(target, 'test note: season-notation false positive');

  const updated = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(updated.wrongProductionAuditCleared, true);
  assert.equal(updated.wrongProductionAuditClearedNote, 'test note: season-notation false positive');
  assert.ok(updated.wrongProductionAuditClearedAt);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('skips a file protected by a shouldSkipWrongProductionAudit breadcrumb (BRO-3586)', () => {
  const dir = makeCorpus({
    'cats-2026': {
      'nyt--unknown.json': {
        showId: 'cats-2026',
        source: 'serp-discovery',
        url: 'https://www.nytimes.com/2024/06/12/theater/cats-review.html',
        wrongProductionManualClear: true,
      },
    },
  });
  const shows = showsMap([{ id: 'cats-2026', openingDate: '2026-04-09' }]);
  assert.equal(findCandidates({ showsById: shows, reviewTextsDir: dir }).length, 0);
});

test('applyFlag refuses a file protected by a shouldSkipWrongProductionAudit breadcrumb, leaving it unchanged (BRO-3586)', () => {
  const dir = makeCorpus({
    'cats-2026': {
      'nyt--unknown.json': {
        showId: 'cats-2026',
        source: 'serp-discovery',
        url: 'https://www.nytimes.com/2024/06/12/theater/cats-review.html',
        wrongProductionManualClear: true,
      },
    },
  });
  const target = path.join(dir, 'cats-2026', 'nyt--unknown.json');
  const before = fs.readFileSync(target, 'utf8');
  assert.throws(() => applyFlag(target, 'attempted override'), /wrongProductionManualClear=true/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('applyFlag refuses a file already cleared by this audit\'s own --clear, leaving it unchanged (BRO-3586)', () => {
  const dir = makeCorpus({
    'eugene-onegin-2026': {
      'operawire--critic.json': {
        showId: 'eugene-onegin-2026',
        source: 'site-search',
        url: 'https://operawire.com/metropolitan-opera-2025-26-review-eugene-onegin/',
        wrongProductionAuditCleared: true,
        wrongProductionAuditClearedNote: 'season-notation false positive',
      },
    },
  });
  const target = path.join(dir, 'eugene-onegin-2026', 'operawire--critic.json');
  const before = fs.readFileSync(target, 'utf8');
  assert.throws(() => applyFlag(target, 'attempted override'), /wrongProductionAuditCleared=true/);
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('applyFlag still writes wrongProduction for a bare wrongProduction:false (auto-clear, not a human breadcrumb) (BRO-3586)', () => {
  const dir = makeCorpus({
    'cats-2026': {
      'nyt--unknown.json': {
        showId: 'cats-2026',
        source: 'serp-discovery',
        url: 'https://www.nytimes.com/2024/06/12/theater/cats-review.html',
        wrongProduction: false,
      },
    },
  });
  const target = path.join(dir, 'cats-2026', 'nyt--unknown.json');
  applyFlag(target, 'verified contamination despite stale auto-clear');
  const updated = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(updated.wrongProduction, true);
});

test('SUSPECT_SOURCES covers every source tag written by the pre-BRO-736 SERP/site-search discovery paths', () => {
  for (const s of [
    'serp-discovery',
    'serp-discovery-per-critic',
    'site-search',
    'broad-web-serp',
    'outlet-serp-discovery',
    'opening-night-discovery',
  ]) {
    assert.ok(SUSPECT_SOURCES.has(s), `expected SUSPECT_SOURCES to include ${s}`);
  }
});
