// BRO-7171 Stage 4: terminal "text cannot be recovered" state. One validity
// predicate, used by the gap classifier and classifyIncompleteReason; durable
// across rebases; cleared by a url change or a recorded clear.
// Run: node --test scripts/lib/gap-terminal.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const GT = require('./gap-terminal.js');
const { classifyTextGap } = require('./text-gap-classify.js');
const { classifyIncompleteReason } = require('./incomplete-reason.js');
const guard = require('./review-write-guard.js');
const { URL_DERIVED_FIELDS } = require('./url-change-invariant.js');
const { clearFailureFlags } = require('./clear-failure-flags.js');

const NOW = Date.parse('2026-11-09T00:00:00Z');
const oldShow = { openingDate: '2012-03-01' };
const recentShow = { openingDate: '2026-03-01' };

function stub(over = {}) {
  return { showId: 's', outletId: 'wolf-entertainment-guide', url: null, contentTier: 'excerpt', fullText: '', dtliExcerpt: 'A fine evening.', assignedScore: 72, ...over };
}
const auto = (review) => GT.buildTerminalRecord({ review, reason: 'OUTLET_DEFUNCT', decidedBy: 'gap-terminal-auto', evidence: ['dns: wolfentertainmentguide.com ENOTFOUND 2026-11-09'], nowIso: '2026-11-09T00:00:00Z' });

test('valid auto record on a historic show is TERMINAL and permanently_unavailable', () => {
  const r = stub();
  r.textUnrecoverable = auto(r);
  assert.deepEqual(GT.validateTerminal(r, { recency: 'historic' }), { valid: true, reason: 'OUTLET_DEFUNCT' });
  const g = classifyTextGap(r, null, { show: oldShow, nowMs: NOW });
  assert.equal(g.gapClass, 'TERMINAL');
  assert.equal(g.open, false);
  assert.deepEqual(classifyIncompleteReason(r, null), { incompleteReason: 'permanently_unavailable', incompleteDetail: 'OUTLET_DEFUNCT' });
  // still a scored review: nothing about the record touches the score or excerpt
  assert.equal(r.assignedScore, 72);
});

test('recent shows are never terminal, whoever decided', () => {
  const r = stub();
  r.textUnrecoverable = { ...auto(r), reason: 'PAYWALL_NO_ACCESS', approvedBy: 'owner: approve all' };
  assert.equal(GT.validateTerminal(r, { recency: 'recent' }).reason, 'recent_show');
  assert.notEqual(classifyTextGap(r, null, { show: recentShow, nowMs: NOW }).gapClass, 'TERMINAL');
});

test('owner reasons need approvedBy; unknown reasons, no evidence, old policy are invalid', () => {
  const r = stub();
  r.textUnrecoverable = { ...auto(r), reason: 'PAYWALL_NO_ACCESS' };
  assert.equal(GT.validateTerminal(r).reason, 'owner_approval_missing');
  r.textUnrecoverable = { ...auto(r), reason: 'GAVE_UP' };
  assert.equal(GT.validateTerminal(r).reason, 'unknown_reason');
  r.textUnrecoverable = { ...auto(r), evidence: [] };
  assert.equal(GT.validateTerminal(r).reason, 'no_evidence');
  r.textUnrecoverable = { ...auto(r), policyVersion: 0 };
  assert.equal(GT.validateTerminal(r).reason, 'policy_version');
  // the pre-Stage-4 shape (reason/decidedAt/evidence only) no longer counts
  r.textUnrecoverable = { reason: 'x', decidedAt: '2026-01-01', evidence: ['y'] };
  assert.equal(classifyTextGap(r, null, { show: oldShow, nowMs: NOW }).gapClass === 'TERMINAL', false);
});

test('a url change invalidates the record and the url-change invariant clears it', () => {
  const r = stub({ url: 'https://old.example.com/review' });
  r.textUnrecoverable = auto(r);
  assert.equal(GT.validateTerminal({ ...r, url: 'https://new.example.com/review' }).reason, 'url_changed');
  assert.equal(GT.validateTerminal({ ...r, url: null }).reason, 'url_changed');
  assert.ok(URL_DERIVED_FIELDS.includes('textUnrecoverable'));
});

test('grouping: recent and routable rows never terminal; auto only with DNS + archive evidence', () => {
  const rows = [
    { reviewKey: 'a/x.json', recency: 'recent', strategy: null, gapClass: 'NO_URL', outletId: 'wolf' },
    { reviewKey: 'b/x.json', recency: 'historic', strategy: 'ARCHIVE', gapClass: 'URL_DEAD', outletId: 'v' },
    { reviewKey: 'c/x.json', recency: 'historic', strategy: null, gapClass: 'NO_URL', subclass: 'PRINT_OR_DEFUNCT', outletId: 'wolf', url: null },
    { reviewKey: 'd/x.json', recency: 'historic', strategy: null, gapClass: 'URL_DEAD', outletId: 'dead', url: 'https://dead.example/r' },
    { reviewKey: 'e/x.json', recency: 'historic', strategy: null, gapClass: 'URL_DEAD', outletId: 'alive', url: 'https://alive.example/r' },
    { reviewKey: 'f/x.json', recency: 'historic', strategy: null, gapClass: 'PAYWALL_PAGE', outletId: 'telegraph', url: 'https://telegraph.co.uk/r' },
    { reviewKey: 'g/x.json', recency: 'historic', strategy: null, gapClass: 'NO_URL', subclass: 'AGG_REF', outletId: 'alive', url: null },
    { reviewKey: 'h/x.json', recency: 'historic', strategy: null, gapClass: 'GARBAGE_PAGE', outletId: 'alive', url: 'https://alive.example/g' },
  ];
  const empty = [{ strategy: 'ARCHIVE', outcome: 'no_evidence', reason: 'archive_empty', runId: 'r1' }];
  const att = new Map([['d/x.json', empty], ['e/x.json', empty]]);
  const hosts = { wolf: 'wolf.example', dead: 'dead.example', alive: 'alive.example', telegraph: 'telegraph.co.uk' };
  const g = GT.groupTerminalCandidates(rows, att, { deadHosts: new Map([['wolf.example', 'ENOTFOUND'], ['dead.example', 'ENOTFOUND']]), hostFor: (r) => hosts[r.outletId] });
  assert.deepEqual(g.auto.map((a) => a.row.reviewKey), ['c/x.json', 'd/x.json']);
  assert.ok(g.auto.every((a) => a.reason === 'OUTLET_DEFUNCT' && a.evidence.length === 2));
  assert.deepEqual(g.owner.URL_DEAD_NO_ARCHIVE.map((a) => a.row.reviewKey), ['e/x.json']);
  assert.deepEqual(g.owner.PAYWALL_NO_ACCESS.map((a) => a.row.reviewKey), ['f/x.json']);
  assert.deepEqual(g.owner.NOT_FINDABLE.map((a) => a.row.reviewKey), ['g/x.json']);
  assert.deepEqual(g.open, { recent_never_terminal: 1, route_left_to_try: 1, 'no_evidence_yet:GARBAGE_PAGE': 1 });
});

test('ship-check: waiting rows, owned rows, garbage and pre-reopen evidence never go terminal', () => {
  const base = { recency: 'historic', strategy: null, outletId: 'dead', url: 'https://dead.example/r' };
  const rows = [
    { ...base, reviewKey: 'cool/x.json', gapClass: 'NO_URL', url: null, skipped: [{ strategy: 'AGG_LINK', reason: 'collector_cooldown' }] },
    { ...base, reviewKey: 'own/x.json', gapClass: 'URL_DEAD', skipped: [{ strategy: 'ANY', reason: 'manual_tier' }] },
    { ...base, reviewKey: 'garb/x.json', gapClass: 'GARBAGE_PAGE', url: null, skipped: [{ strategy: 'REFETCH_FREE', reason: 'no_url' }] },
    { ...base, reviewKey: 'reop/x.json', gapClass: 'URL_DEAD', skipped: [{ strategy: 'URL_REDISCOVER', reason: 'disabled' }] },
    { ...base, reviewKey: 'ok/x.json', gapClass: 'NO_URL', url: null, skipped: [{ strategy: 'URL_REDISCOVER', reason: 'disabled' }] },
  ];
  const att = new Map([['reop/x.json', [
    { strategy: 'ARCHIVE', outcome: 'no_evidence', reason: 'archive_empty', runId: 'old' },
    { strategy: 'ANY', outcome: 'reopened', reason: 'url_changed' },
  ]]]);
  const g = GT.groupTerminalCandidates(rows, att, { deadHosts: new Map([['dead.example', 'ENOTFOUND']]), hostFor: () => 'dead.example' });
  assert.deepEqual(g.auto.map((a) => a.row.reviewKey), ['ok/x.json']);
  assert.equal(g.open.waiting_on_retry, 1);
  assert.equal(g.open['owned:manual_tier'], 1);
  assert.equal(g.open['no_evidence_yet:GARBAGE_PAGE'], 1);
  assert.equal(g.open['no_evidence_yet:URL_DEAD'], 1);
});

test('ship-check: a terminal record never masks a garbage fetch (scorer reads incompleteReason)', () => {
  const r = stub({ fullText: 'Subscribe now to keep reading' });
  r.textUnrecoverable = auto(r);
  const res = classifyIncompleteReason(r, { failureReason: 'garbage_content', garbageReason: 'nav chrome', failureCount: 2 });
  assert.equal(res.incompleteReason, 'scraper_garbage');
});

test('durable across a rebase; a recorded clear is honored (three-way sync)', () => {
  assert.ok(guard.PROTECTED_FIELDS.includes('textUnrecoverable'));
  assert.ok(guard.PROTECTED_FIELDS.includes('textUnrecoverableClearReason'));
  const { MANUAL_FIELDS } = require('./restore-protected-fields.js');
  assert.ok(MANUAL_FIELDS.includes('textUnrecoverable'));
  const committed = stub();
  committed.textUnrecoverable = auto(committed);
  // lost without a breadcrumb: not an intentional clear (restore puts it back)
  assert.equal(guard.isIntentionalClear('textUnrecoverable', stub(), committed), false);
  // clearFailureFlags on a recovered (complete) file retires it WITH the breadcrumb
  const local = { ...committed, contentTier: 'complete', fullText: 'x'.repeat(3000) };
  assert.ok(clearFailureFlags(local).includes('textUnrecoverable'));
  assert.equal(local.textUnrecoverable, undefined);
  assert.match(local.textUnrecoverableClearReason, /^text recovered/);
  assert.equal(guard.isIntentionalClear('textUnrecoverable', local, committed), true);
});
