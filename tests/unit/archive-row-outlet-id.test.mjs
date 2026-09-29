/**
 * resolveArchiveRowOutletId — outlet identity for aggregator-archive cache rows.
 *
 * Card 39b637c5-416f-81bb: caches store scrape-era outletIds; collision-era rows
 * carry sunday-telegraph for telegraph.co.uk URLs and re-ingest reproduces the
 * stale mapping. The URL overrides ONLY when the fallback ID claims the URL's
 * domain (stale URL-derived ID) or isn't registered at all — blind URL-first
 * would mis-home WET star rows (whose `url` is the roundup page itself) and
 * Observer week-in-theatre columns published on theguardian.com.
 *
 * Uses the real outlet-registry.json (stable outlets only: telegraph,
 * sunday-telegraph, observer, timeout, timeout-london, daily-mail, express-uk).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const { resolveArchiveRowOutletId, findRawOutletIdIngestLines } = require(resolve(ROOT, 'scripts/lib/archive-outlet-identity.js'));
const { readFileSync } = await import('node:fs');

describe('resolveArchiveRowOutletId', () => {
  test('stale collision-era ID: sunday-telegraph + telegraph.co.uk URL resolves to telegraph', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.telegraph.co.uk/theatre/what-to-see/kill-mockingbird-review/',
      outletLabel: 'The Telegraph',
      cachedOutletId: 'sunday-telegraph',
      sourceOutletId: 'westendtheatre',
    }), 'telegraph');
  });

  test('roundup-page URL never overrides the label (WET star rows)', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.westendtheatre.com/339763/news/reviews/shadowlands-reviews/',
      outletLabel: 'Daily Mail',
      cachedOutletId: 'daily-mail',
      sourceOutletId: 'westendtheatre',
    }), 'daily-mail');
  });

  test('registered outlet keeps its ID when URL points at a foreign domain (Observer on theguardian.com)', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.theguardian.com/stage/2025/jan/19/the-week-in-theatre-oliver-review',
      outletLabel: 'Observer',
      cachedOutletId: 'observer',
      sourceOutletId: 'westendtheatre',
    }), 'observer');
  });

  test('timeout path-split: /london URL flips timeout to timeout-london', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.timeout.com/london/theatre/the-crucible-4-review',
      outletLabel: 'Time Out',
      cachedOutletId: 'timeout',
      sourceOutletId: 'westendtheatre',
    }), 'timeout-london');
  });

  test('junk/alias cached ID with a resolvable URL canonicalizes (the-express → express-uk)', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'https://www.express.co.uk/entertainment/theatre/2073053/disney-hercules-musical-london-review',
      outletLabel: 'The Express',
      cachedOutletId: 'the-express',
      sourceOutletId: 'westendtheatre',
    }), 'express-uk');
  });

  test('URL-less row keeps the cached ID (genuine Sunday print reviews)', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: '',
      outletLabel: 'Sunday Telegraph',
      cachedOutletId: 'sunday-telegraph',
    }), 'sunday-telegraph');
  });

  test('no cached ID falls back to normalized label', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: '',
      outletLabel: 'The Telegraph',
    }), 'telegraph');
  });

  test('malformed URL falls back to cached ID', () => {
    assert.strictEqual(resolveArchiveRowOutletId({
      url: 'not a url',
      outletLabel: 'The Telegraph',
      cachedOutletId: 'telegraph',
    }), 'telegraph');
  });
});

describe('WE-aggregator ingestion wiring', () => {
  // Every path that turns an aggregator row into a review identity must go
  // through resolveArchiveRowOutletId. The poller and sweep writers ingest the
  // SAME rows as gather-reviews — a raw `X.outletId || normalizeOutlet(...)`
  // there re-introduces the divergence (ship-check P1, 2026-07-12).
  const WIRED = [
    { file: 'scripts/gather-reviews.js', minCalls: 4, label: 'LBO, WET, TR, TS cache blocks' },
    { file: 'scripts/opening-night-poller.js', minCalls: 4, label: 'poller LBO, WET, TR, TS blocks' },
    { file: 'scripts/scrape-theatre-reviews.js', minCalls: 1, label: 'TR sweep writer' },
    { file: 'scripts/scrape-thestage-roundups.js', minCalls: 1, label: 'TS sweep writer' },
  ];
  for (const w of WIRED) {
    test(`${w.file} routes ${w.label} through resolveArchiveRowOutletId`, () => {
      const contents = readFileSync(resolve(ROOT, w.file), 'utf8');
      assert.match(contents, /require\(['"]\.\/lib\/archive-outlet-identity['"]\)/,
        `${w.file} must import resolveArchiveRowOutletId — removing the wire re-introduces stale/divergent outletIds (card 39b637c5-416f-81bb)`);
      const calls = contents.match(/resolveArchiveRowOutletId\s*\(/g) || [];
      assert.ok(calls.length >= w.minCalls,
        `expected ≥${w.minCalls} resolveArchiveRowOutletId call sites (${w.label}), found ${calls.length}`);
      // Un-exempted matches only. A genuine non-ingest use (rejected-review
      // telemetry, say) declares itself with `// audit-only: <reason>` rather
      // than being narrowed out of the guard — see findRawOutletIdIngestLines.
      const raw = findRawOutletIdIngestLines(contents);
      assert.deepStrictEqual(raw, [],
        `${w.file} has a row-ingest site trusting .outletId directly — route it through `
        + `resolveArchiveRowOutletId, or declare why it is not row ingest with an `
        + `\`// audit-only: <reason>\` annotation ON the matching line or the line DIRECTLY above it:\n`
        + raw.map((f) => `  ${w.file}:${f.line}  ${f.text}`).join('\n'));
    });
  }
});

// The guard above only ever asserts ABSENCE. Nothing in it proves the detector
// still matches anything — so a well-meant "fix the false positive" narrowing
// could silently turn it into a dead gate and no test would notice. That is not
// hypothetical: the first fix proposed for BRO-3455 was to require the ||
// fallback to be a normalizeOutlet()-style call, which would have kept shape 3
// below and permitted shapes 1 and 2 forever. This block is the lock.
describe('raw outletId ingest guard (positive control)', () => {
  // The three shapes fc5596d0813 removed, verbatim. If any of these stops being
  // detected, the guard has been weakened — that is the ONLY thing this exists for.
  const HISTORICAL_SHAPES = [
    `outletId: r.outletId || r.outlet?.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'unknown',`,
    `outletId: r.outletId || 'unknown',`,
    `outletId: r.outletId || normalizeOutlet(r.outlet || ''),`,
  ];
  for (const shape of HISTORICAL_SHAPES) {
    test(`still detects: ${shape.slice(0, 48)}…`, () => {
      assert.strictEqual(findRawOutletIdIngestLines(shape).length, 1);
    });
  }

  test('the wrapped multi-line form is still detected', () => {
    assert.strictEqual(
      findRawOutletIdIngestLines("outletId:\n  r.outletId ||\n  'unknown',").length, 1);
  });

  test('all three guarded subject names are detected', () => {
    for (const subject of ['r', 'review', 'lboReview']) {
      assert.strictEqual(
        findRawOutletIdIngestLines(`outletId: ${subject}.outletId || 'unknown',`).length, 1,
        `subject "${subject}" must still be caught`);
    }
  });

  test('an audit-only annotation WITH a reason exempts the line', () => {
    assert.strictEqual(findRawOutletIdIngestLines(
      `// audit-only: rejected-review telemetry\n${HISTORICAL_SHAPES[1]}`).length, 0);
  });

  test('a bare audit-only marker with NO reason does not exempt', () => {
    assert.strictEqual(findRawOutletIdIngestLines(
      `// audit-only:\n${HISTORICAL_SHAPES[1]}`).length, 1);
  });

  test('a trailing audit-only annotation on the matching line exempts it', () => {
    assert.strictEqual(findRawOutletIdIngestLines(
      `outletId: r.outletId || 'unknown', // audit-only: fixture`).length, 0);
  });

  // ship-check reproduced both of these against the shipped module: an
  // unrelated trailing marker on the PRECEDING LINE OF CODE used to exempt the
  // real ingest site below it. That is how a source lint goes dead quietly.
  test('an unrelated trailing marker on a preceding CODE line does NOT exempt', () => {
    assert.strictEqual(findRawOutletIdIngestLines(
      `const a = 1; // audit-only: something unrelated\n${HISTORICAL_SHAPES[1]}`).length, 1);
  });

  test('a comment-only marker line above still exempts', () => {
    assert.strictEqual(findRawOutletIdIngestLines(
      `  // audit-only: rejected-review telemetry\n${HISTORICAL_SHAPES[1]}`).length, 0);
  });

  test('a blank line between marker and match does not exempt', () => {
    assert.strictEqual(findRawOutletIdIngestLines(
      `// audit-only: too far away\n\n${HISTORICAL_SHAPES[1]}`).length, 1);
  });

  // The two shipped exemptions are the only ones. A third has to be added
  // deliberately, in a diff that changes this number.
  test('exactly two audit-only exemptions exist across the guarded files', () => {
    const files = [
      'scripts/gather-reviews.js',
      'scripts/opening-night-poller.js',
      'scripts/scrape-theatre-reviews.js',
      'scripts/scrape-thestage-roundups.js',
    ];
    const total = files.reduce((n, f) => {
      const c = readFileSync(resolve(ROOT, f), 'utf8').match(/\/\/\s*audit-only:/g) || [];
      return n + c.length;
    }, 0);
    assert.strictEqual(total, 2,
      'a new `// audit-only:` exemption was added to a guarded file — confirm it really is not row ingest, then update this count');
  });

  test('clean routed code produces no findings', () => {
    assert.deepStrictEqual(findRawOutletIdIngestLines(
      `outletId: resolveArchiveRowOutletId({ url: r.url, outletLabel: r.outlet, cachedOutletId: r.outletId }),`), []);
  });
});
