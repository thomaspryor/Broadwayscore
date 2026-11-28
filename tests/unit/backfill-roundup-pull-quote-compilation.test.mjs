/**
 * Unit tests for scripts/lib/pull-quote-compilation-backfill.js (BRO-2638).
 * Run: node --test tests/unit/backfill-roundup-pull-quote-compilation.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectPullQuoteCompilation } = require('../../scripts/lib/pull-quote-compilation-backfill.js');

const compilation = 'A new production opened tonight at the August Wilson Theatre. That is the critical consensus, as indicated below: '
  + 'Helen Shaw, New York Times. A confident, unsettling piece of theater that earns its scares. '
  + 'Jackson McHenry, Vulture. The design team pulls off tricks that leave the audience gasping. '
  + "Howard Miller, Talkin' Broadway. A tightly wound thriller with a starry cast. "
  + 'Johnny Oleksinski, New York Post. Genuinely frightening in a way few Broadway shows manage. '
  + 'Frank Rizzo, Variety. A slick, well-drilled production that never quite finds its heart.';

describe('selectPullQuoteCompilation', () => {
  test('selects an unflagged compilation page', () => {
    const r = selectPullQuoteCompilation({ fullText: compilation, outletId: 'nyt-theater', criticName: 'Jonathan Mandell' });
    assert.ok(r && /pull-quote compilation/.test(r.reason));
  });
  test('skips a file already flagged', () => {
    assert.equal(selectPullQuoteCompilation({ fullText: compilation, outletId: 'nyt-theater', criticName: 'Jonathan Mandell', isRoundupArticle: true }), null);
  });
  test('leaves an ordinary review alone', () => {
    assert.equal(selectPullQuoteCompilation({ fullText: 'A tight, funny revival with a superb lead performance and sharp direction throughout its two hours.', outletId: 'nytimes', criticName: 'Jesse Green' }), null);
  });
  test('tolerates empty and missing input', () => {
    assert.equal(selectPullQuoteCompilation(null), null);
    assert.equal(selectPullQuoteCompilation({}), null);
  });
});

describe('backfill script contract + safety', () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { isLikelyStaleRoundupFlag } = require('../../scripts/lib/review-guards.js');
  const script = path.join(process.cwd(), 'scripts/backfill-roundup-pull-quote-compilation.js');
  const rec = { fullText: compilation, outletId: 'nyt-theater', criticName: 'Jonathan Mandell', url: 'https://newyorktheater.me/2014/11/20/x-reviews/' };

  test('respects a manual clear (false or cleared note)', () => {
    assert.equal(selectPullQuoteCompilation({ ...rec, isRoundupArticle: false }), null);
    assert.equal(selectPullQuoteCompilation({ ...rec, roundupArticleClearedNote: 'human' }), null);
  });
  test('backfill reason is not reverted by the weekly stale-flag clearer', () => {
    const flagged = { ...rec, isRoundupArticle: true, roundupArticleReason: 'auto: backfill (BRO-2638) — pull-quote compilation: x' };
    assert.equal(isLikelyStaleRoundupFlag(flagged), false);
  });
  test('stdout contract: dry run prints Would flag, --apply prints APPLIED and writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-'));
    fs.mkdirSync(path.join(dir, 'show-a'));
    const f = path.join(dir, 'show-a', 'nyt-theater--jonathan-mandell.json');
    fs.writeFileSync(f, JSON.stringify(rec));
    const dry = spawnSync('node', [script, `--dir=${dir}`], { encoding: 'utf8' });
    assert.match(dry.stdout, /Would flag: 1/);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).isRoundupArticle, undefined);
    const live = spawnSync('node', [script, `--dir=${dir}`, '--apply'], { encoding: 'utf8' });
    assert.match(live.stdout, /APPLIED — flagged 1 file/);
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).isRoundupArticle, true);
  });
});
