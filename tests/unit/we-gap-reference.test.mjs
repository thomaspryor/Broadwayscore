/**
 * WE completeness gate — reference sources + safety-invariant tests.
 *
 * Covers the plan-review P0s (2026-07-09):
 *  - URL-less WET rows must surface (outlet-based matching, not URL-only)
 *  - prior-run roundup rows are NEVER ingest-eligible
 *  - empty-parse from a found roundup = detector failure flag, not "no citations"
 *  - opening-window scoping (no back-catalogue grind)
 *  - default-OFF ingest: the workflow must carry the WE_GAP_INGEST env line and
 *    the audit must gate on === '1' (absent env fails closed)
 *  - alert dedup hash is order-insensitive and change-sensitive
 *
 * Run: node --test tests/unit/we-gap-reference.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  getWeReferenceRows, isWeShow, inOpeningWindow, isCurrentRunRoundup, missingSetHash,
} = require('../../scripts/lib/gap-reference-sources.js');

const noLog = () => {};
const NOW = Date.parse('2026-07-10T12:00:00Z');
const SHOW = { id: 'sting-west-end-2026', title: 'Sting', venue: 'The Maria Theatre', category: 'west-end', openingDate: '2026-07-01' };

describe('scoping helpers', () => {
  test('isWeShow: west-end + off-west-end yes; broadway/off-broadway no', () => {
    assert.equal(isWeShow({ category: 'west-end' }), true);
    assert.equal(isWeShow({ category: 'off-west-end' }), true);
    assert.equal(isWeShow({ category: 'broadway' }), false);
    assert.equal(isWeShow({ market: 'west-end' }), true);
    assert.equal(isWeShow({}), false);
  });

  test('inOpeningWindow: opened 9d ago yes; opened 400d ago no (back-catalogue excluded); pre-opening no', () => {
    assert.equal(inOpeningWindow({ openingDate: '2026-07-01' }, NOW), true);
    assert.equal(inOpeningWindow({ openingDate: '2025-06-01' }, NOW), false);
    assert.equal(inOpeningWindow({ openingDate: '2026-08-01' }, NOW), false, 'roundups do not exist pre-opening');
    assert.equal(inOpeningWindow({ openingDate: null }, NOW), false);
  });

  test('isCurrentRunRoundup: 2022 roundup on a 2026 opening is a prior run', () => {
    const show = { openingDate: '2026-06-30' };
    assert.equal(isCurrentRunRoundup('2022-04-01', show), false);
    assert.equal(isCurrentRunRoundup('2026-07-01', show), true);
    assert.equal(isCurrentRunRoundup(null, show), true, 'unknown date treated as current (discovery already date-gated)');
  });

  test('missingSetHash: order-insensitive, change-sensitive', () => {
    assert.equal(missingSetHash(['guardian', 'thestage']), missingSetHash(['thestage', 'guardian']));
    assert.notEqual(missingSetHash(['guardian']), missingSetHash(['guardian', 'thestage']));
    assert.equal(missingSetHash(['a', 'a', 'b']), missingSetHash(['a', 'b']), 'dedup before hashing');
  });
});

describe('getWeReferenceRows', () => {
  const wetTablePost = (dateIso) => ([{
    id: 1, link: 'https://www.westendtheatre.com/1/news/reviews/sting-review-round-up/',
    date: dateIso,
    title: { rendered: 'Sting Review round-up' },
    content: { rendered: '<table>\n<tr>\n<td>The Guardian</td>\n<td>★★★★</td>\n</tr>\n<tr>\n<td>WhatsOnStage</td>\n<td>★★★</td>\n</tr>\n</table>' },
  }]);

  test('WET table rows arrive with url:null + outletId (the class URL-matching would drop)', async () => {
    const ref = await getWeReferenceRows(SHOW, {
      fetchJSON: async (url) => /westendtheatre/.test(url) ? wetTablePost('2026-07-02T09:00:00') : [],
      fetchPage: async () => { throw new Error('404'); },
      dataDir: '/nonexistent',
      log: noLog,
    });
    const wetRows = ref.rows.filter(r => r.source === 'westendtheatre');
    assert.ok(wetRows.length >= 2, 'both table rows extracted');
    assert.ok(wetRows.every(r => r.url === null), 'table rows have no URL');
    assert.ok(wetRows.every(r => r.outletId && r.outletId.length > 0), 'rows carry outletId for outlet-based matching');
    assert.equal(wetRows[0].priorRun, false, 'post dated day after opening = current run');
  });

  test('PRIOR-RUN GUARD: 2022-dated WET roundup rows are marked priorRun', async () => {
    const ref = await getWeReferenceRows({ ...SHOW, openingDate: '2026-06-30' }, {
      fetchJSON: async (url) => /westendtheatre/.test(url) ? wetTablePost('2022-04-01T09:00:00') : [],
      fetchPage: async () => { throw new Error('404'); },
      dataDir: '/nonexistent',
      log: noLog,
    });
    const wetRows = ref.rows.filter(r => r.source === 'westendtheatre');
    assert.ok(wetRows.length >= 2);
    assert.ok(wetRows.every(r => r.priorRun === true), 'prior-run roundup rows flagged (never ingest-eligible)');
  });

  test('EMPTY-PARSE FLOOR: title-matched WET post with 0 parseable rows → emptyParse, not silence', async () => {
    const posts = [{
      id: 2, link: 'https://www.westendtheatre.com/2/news/reviews/sting-review-round-up/',
      date: '2026-07-02T09:00:00',
      title: { rendered: 'Sting Review round-up' },
      content: { rendered: '<div class="totally-new-template">redesigned markup, no stars</div>' },
    }];
    const ref = await getWeReferenceRows(SHOW, {
      fetchJSON: async (url) => /westendtheatre/.test(url) ? posts : [],
      fetchPage: async () => ({ content: '<div class="totally-new-template">no legacy classes</div>', source: 'test' }),
      dataDir: '/nonexistent',
      log: noLog,
    });
    assert.equal(ref.sources.westendtheatre.found, true, 'roundup WAS found');
    assert.equal(ref.sources.westendtheatre.emptyParse, true, 'parser drift flagged as detector failure');
  });

  test('BLACKOUT FLOOR: every source throwing → allSourcesFailed=true', async () => {
    const boom = async () => { throw new Error('network down'); };
    const ref = await getWeReferenceRows(SHOW, { fetchJSON: boom, fetchPage: boom, dataDir: '/nonexistent', log: noLog });
    assert.equal(ref.allSourcesFailed, true, 'passive TS-archive absence must NOT mask a real blackout of the fetching sources');
    assert.equal(ref.rows.length, 0);
  });
});

describe('The Stage archive source (passive, 2026-07-11)', () => {
  const os = require('node:os');
  const pathMod = require('node:path');

  const TS_HTML = (dateIso) => `<html><head>
<title>Sting review round-up: what did the critics think?</title>
<link rel="canonical" href="https://www.thestage.co.uk/review-round-ups/sting-review-round-up">
<meta property="article:published_time" content="${dateIso}T09:00:00+00:00">
</head><body>
<p>writes Arifa Akbar (<a href="https://www.theguardian.com/stage/review/sting">Guardian, ★★★★</a>) while others demur.</p>
<p>says Tim Bano (<a href="https://www.thestage.co.uk/reviews/sting-review">The Stage, ★★★</a>) in his verdict.</p>
</body></html>`;

  const writeArchive = (showId, html) => {
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'ts-arch-'));
    const arch = pathMod.join(dir, 'aggregator-archive', 'thestage-roundups');
    fs.mkdirSync(arch, { recursive: true });
    fs.writeFileSync(pathMod.join(arch, `${showId}.html`), html);
    return dir;
  };
  const noNetwork = { fetchJSON: async () => [], fetchPage: async () => { throw new Error('404'); }, log: noLog };

  test('archived roundup rows join the union — including The Stage\'s OWN review (the T1 blind spot)', async () => {
    const dataDir = writeArchive(SHOW.id, TS_HTML('2026-07-02'));
    const ref = await getWeReferenceRows(SHOW, { ...noNetwork, dataDir });
    const tsRows = ref.rows.filter(r => r.source === 'thestage-archive');
    assert.ok(tsRows.length >= 2, `expected ≥2 archive rows, got ${tsRows.length}`);
    assert.ok(tsRows.some(r => r.outletId === 'thestage' || /stage/i.test(r.outletName)),
      'The Stage cites its own review in its roundup — a missing Stage review is now flaggable');
    assert.ok(tsRows.every(r => r.priorRun === false), 'current-run archive rows are ingest-eligible');
    assert.equal(ref.sources['thestage-archive'].found, true);
    assert.equal(ref.sources['thestage-archive'].passive, true);
  });

  test('prior-production archive (gather SERP archived the wrong run) → rows priorRun', async () => {
    const dataDir = writeArchive(SHOW.id, TS_HTML('2022-04-01'));
    const ref = await getWeReferenceRows(SHOW, { ...noNetwork, dataDir });
    const tsRows = ref.rows.filter(r => r.source === 'thestage-archive');
    assert.ok(tsRows.length >= 2);
    assert.ok(tsRows.every(r => r.priorRun === true), 'stale archived roundup rows must never be ingest-eligible');
  });

  test('archive exists but parses 0 rows → emptyParse (visible; passive so never a proving floor)', async () => {
    const dataDir = writeArchive(SHOW.id, '<html><head><title>Sting review round-up</title></head><body><p>redesigned template, no star links</p></body></html>');
    const ref = await getWeReferenceRows(SHOW, { ...noNetwork, dataDir });
    assert.equal(ref.sources['thestage-archive'].found, true);
    assert.equal(ref.sources['thestage-archive'].emptyParse, true);
    assert.equal(ref.sources['thestage-archive'].passive, true, 'passive flag exempts it from proving floors');
  });

  test('wrong-show archive (title mismatch) is IGNORED — no rows, error noted (QA review 2026-07-11)', async () => {
    const dataDir = writeArchive(SHOW.id, TS_HTML('2026-07-02').replace(/<title>[^<]*<\/title>/, '<title>Completely Different Show review round-up</title>'));
    const ref = await getWeReferenceRows(SHOW, { ...noNetwork, dataDir });
    assert.equal(ref.rows.filter(r => r.source === 'thestage-archive').length, 0, 'wrong-show rows must not join the union');
    assert.equal(ref.sources['thestage-archive'].found, false);
    assert.match(ref.sources['thestage-archive'].error || '', /title mismatch/);
  });

  test('no archive → passive absence: no error, no floor, no rows', async () => {
    const ref = await getWeReferenceRows(SHOW, { ...noNetwork, dataDir: '/nonexistent' });
    assert.equal(ref.sources['thestage-archive'].found, false);
    assert.equal(ref.sources['thestage-archive'].error, null);
    assert.equal(ref.sources['thestage-archive'].emptyParse, false);
  });

  test('workflow checks out the aggregator archive so TS is present in CI', () => {
    const wfSrc = fs.readFileSync(new URL('../../.github/workflows/audit-aggregator-gap.yml', import.meta.url), 'utf8');
    assert.ok(wfSrc.includes('checkout-aggregator-archive'),
      'audit-aggregator-gap.yml must checkout the aggregator archive or the TS source is silently absent in CI');
  });
});

describe('safety wiring (audit + workflow must keep the fail-closed invariants)', () => {
  const auditSrc = fs.readFileSync(new URL('../../scripts/audit-show-review-gap.js', import.meta.url), 'utf8');
  const wfSrc = fs.readFileSync(new URL('../../.github/workflows/audit-aggregator-gap.yml', import.meta.url), 'utf8');

  test('audit gates WE ingest on WE_GAP_INGEST === "1" (absent env fails closed)', () => {
    assert.ok(auditSrc.includes("process.env.WE_GAP_INGEST === '1'"), 'explicit-opt-in comparison present');
    // The predicate itself is canonical in lib/gap-ingest-policy.js (behaviorally
    // tested in gap-ingest-policy.test.mjs — priorRun blocks even when gate is on).
    // Needle updated 2026-07-26 (task #468): b38a8a8151c wired the SERP-census
    // gate into the same canonical predicate call; the guard must track the
    // full current shape so a dropped gate param fails THIS test.
    assert.ok(auditSrc.includes('ingestBlockReason(m, { showIsWe, weGateOn, lowTrustSources: lowTrust, serpCensusGateOn })'),
      'missing-URL ingest must consult the canonical policy predicate (incl. per-source trust + SERP-census gate)');
  });

  test('audit invalidates stale WE checkpoints via WE_REF_VERSION', () => {
    assert.ok(auditSrc.includes('WE_REF_VERSION'), 'reference version constant present');
    assert.ok(auditSrc.includes('e.refVersion !== WE_REF_VERSION'), 'freshness skip bypassed for stale WE entries');
  });

  test('workflow env carries the gate flags + email secrets (a dropped line fails THIS test, not silently enables ingest)', () => {
    for (const needle of ['WE_GAP_INGEST', 'WE_GAP_REFERENCE_DISABLED', 'RESEND_API_KEY', 'OWNER_EMAIL']) {
      assert.ok(wfSrc.includes(needle), `audit-aggregator-gap.yml env must include ${needle}`);
    }
  });

  test('P0 (ship-check): flaggedMisses RECOVERY path also respects the WE gate + prior-run block', () => {
    assert.ok(auditSrc.includes('m.recoverable && recBlockedPred(m)') && auditSrc.includes('m.recoverable && !recBlockedPred(m)'),
      'recovery filter must exclude gate-blocked rows — an empty-body file + a 2022 roundup URL must never re-ingest prior-production text');
    assert.ok(auditSrc.includes('ingestBlockReason(m, { showIsWe: isWeShow(s), weGateOn: weRecGateOn, lowTrustSources: lowTrust, serpCensusGateOn: serpCensusRecGateOn })'),
      'recovery must consult the SAME canonical policy predicate as missing-URL ingest');
  });

  test('P0 (#371 ship-check): SERP census rows are gated on EVERY ingest path (missing-URL + recovery), not just WE', () => {
    assert.ok(auditSrc.includes("process.env.SERP_CENSUS_INGEST === '1'"), 'explicit-opt-in comparison present');
    assert.ok(auditSrc.includes('blockedPred = (m) => ingestBlockReason(m, { showIsWe, weGateOn, lowTrustSources: lowTrust, serpCensusGateOn })'),
      'missing-URL ingest must thread serpCensusGateOn — a Broadway-market serpCensus row must not bypass the WE-only gates');
    assert.ok(auditSrc.includes('recBlockedPred = (m) => ingestBlockReason(m, { showIsWe: isWeShow(s), weGateOn: weRecGateOn, lowTrustSources: lowTrust, serpCensusGateOn: serpCensusRecGateOn })'),
      'recovery must thread serpCensusGateOn too');
  });

  test('INCIDENT 2026-07-10: Broadway-path same-title contamination blocked by production identity', () => {
    // Was: WE shows gated ALL missing-URL ingest on WE_GAP_INGEST — which stops
    // protecting the moment the gate auto-enables. Now the Broadway-path articles
    // themselves are date-gated (articleRunIdentity) and prior-run URLs are
    // permanently blocked on every market (2018 TKAM/2013 Midsummer/2014 Last
    // Ship/2025 JLP reviews all ingested onto WE entries in the first run).
    assert.ok(auditSrc.includes('articleRunIdentity(html, show, articleUrl)'),
      'every fetched aggregator article must be dated against the opening window (article URL threaded so extractPublishDate can scope JSON-LD to the main entity)');
    assert.ok(auditSrc.includes("m.priorRunSource = 'aggregator-article-date'"),
      'prior-production article URLs must be tagged priorRun in missing/flaggedMisses');
  });

  test('P1 (ship-check): prior-run-only alert sets do not daily re-ping; failed delivery does not record dedup hash', () => {
    assert.ok(auditSrc.includes('rePingDue && !allPriorRun'), 'unfixable prior-run-only sets alert once, not daily');
    // 2026-07-11: the condition grew a second clause (actionable-only email
    // policy — warning-severity alerts no longer email, so `delivered` would
    // stay false forever without this) but this assertion's literal string
    // wasn't updated, leaving it silently broken since. Match the invariant
    // itself (dedup hash writes only when the alert was handled) rather than
    // one exact substring of the condition.
    assert.ok(auditSrc.includes("if (delivered || !shouldEmailAlert('warning')) {"),
      'hash recorded only on real delivery (or actionable-only-policy suppression) so failures retry');
  });

  test('P1 (ship-check): outlet display variants match covered files (canonical key)', () => {
    assert.ok(auditSrc.includes("replace(/-(london|uk)$/,'').replace(/-/g, '')"),
      'timeout-london/broadway-world-uk class variants must match registry ids');
  });

  test('audit alerts via email with set-change dedup', () => {
    assert.ok(auditSrc.includes('missingSetHash('), 'set-change dedup in place');
    assert.ok(auditSrc.includes('email: true'), 'alert requests email delivery');
    assert.ok(auditSrc.includes('citedNoUrl'), 'URL-less citations surface in results');
  });
});
