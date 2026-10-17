// Unit tests for sweep-pending-commercial.js classifyEntry (BRO-4990).
// Requires the real function (CLAUDE.md §15).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { classifyEntry } = require('../../scripts/sweep-pending-commercial');

const shows = { a: { slug: 'a', category: 'broadway', openingDate: '2021-10-01' } };
const old = new Date(Date.now() - 400 * 86_400_000).toISOString();

describe('classifyEntry', () => {
  it('archives an unheld low-confidence row past the age limit', () => {
    assert.equal(classifyEntry('a', { confidence: 'low', researchedAt: old, openingDate: '2021-10-01' }, shows).action, 'archive');
  });

  // Ship-check P1: archiving a held backfill row dropped its attempt count,
  // so the Saturday sweep re-researched the show every ~180 days forever.
  it('keeps a held backfill row (and a noData attempt record) however old', () => {
    for (const extra of [{}, { noData: true }]) {
      const entry = { confidence: 'low', researchedAt: old, openingDate: '2021-10-01', requiresHumanReview: true, backfill: 'BRO-4990', ...extra };
      assert.equal(classifyEntry('a', entry, shows).action, 'keep');
    }
  });

  it('still archives an out-of-scope row even when held', () => {
    const ob = { b: { slug: 'b', category: 'off-broadway', openingDate: '2021-10-01' } };
    assert.equal(classifyEntry('b', { confidence: 'low', researchedAt: old, requiresHumanReview: true }, ob).action, 'archive');
  });
});

// Recouped-claim triage (commercial-pending-review-cards cluster, BRO-3807..):
// stale ID-keyed duplicates and wrong-production claims were filed weekly.
const { buildShowKeyIndex } = require('../../scripts/lib/commercial-slug-key');
const triage = require('../../scripts/lib/commercial-claim-triage');
const { buildNotes } = require('../../scripts/lib/commercial-claim-card');

describe('classifyEntry recouped-claim triage', () => {
  const showList = [
    { id: 'wicked-2003', slug: 'wicked', category: 'broadway', openingDate: '2003-10-30' },
    { id: 'bug-2026', slug: 'bug', category: 'broadway', previewsStartDate: '2025-12-16', openingDate: '2026-01-08' },
    { id: 'mamma-mia-2025', slug: 'mamma-mia', category: 'broadway', openingDate: '2025-08-14' },
    { id: 'plaza-suite-2022', slug: 'plaza-suite-2022', category: 'broadway', openingDate: '2022-03-28' },
  ];
  const bySlug = Object.fromEntries(showList.flatMap((s) => [[s.slug, s], [s.id, s]]));
  const cited = [{ type: 'trade', url: 'https://playbill.com/x' }];
  const ctx = {
    showKeyIndex: buildShowKeyIndex(showList),
    commercialShows: {
      wicked: { designation: 'Miracle', recouped: true, recoupedDate: '2004-12', sources: cited },
      'mamma-mia': { designation: 'Tour Stop', productionType: 'tour-stop', recouped: null },
    },
  };
  const claim = (extra) => ({ recouped: true, _recoupedClaim: true, confidence: 'high', ...extra });

  it('leaves an unheld stale duplicate for the reconciler instead of filing a card', () => {
    const r = classifyEntry('wicked-2003', claim({ slug: 'wicked', recoupedDate: '2004-12' }), bySlug, ctx);
    assert.equal(r.action, 'keep');
  });

  it('strips the claim from a held stale duplicate (the reconciler skips held rows)', () => {
    const r = classifyEntry('wicked-2003', claim({ slug: 'wicked', recoupedDate: '2004-12', requiresHumanReview: true }), bySlug, ctx);
    assert.equal(r.action, 'strip');
    assert.equal(r.rejectAs, undefined);
  });

  // Ship-check P1: the reconciler also skips _reviewHold rows, so a 'keep'
  // there left the claim uncarded and unclosed forever.
  it('strips the claim from a _reviewHold stale duplicate too', () => {
    const r = classifyEntry('wicked-2003', claim({ slug: 'wicked', recoupedDate: '2004-12', _reviewHold: true }), bySlug, ctx);
    assert.equal(r.action, 'strip');
  });

  it('reports a duplicate whose year differs (may be a correction)', () => {
    assert.equal(classifyEntry('wicked-2003', claim({ slug: 'wicked', recoupedDate: '2006-01' }), bySlug, ctx).action, 'report');
  });

  it('rejects a claim dated before the production started (production guard)', () => {
    const r = classifyEntry('bug', claim({ recoupedDate: '2005-01-28' }), bySlug, ctx);
    assert.equal(r.action, 'archive');
    assert.equal(r.rejectAs, 'bug');
  });

  it('rejects a claim on a tour-stop engagement, stripping only the claim on a held row', () => {
    assert.equal(classifyEntry('mamma-mia', claim({}), bySlug, ctx).action, 'archive');
    assert.equal(classifyEntry('mamma-mia', claim({ requiresHumanReview: true }), bySlug, ctx).action, 'strip');
  });

  it('still reports an unverified claim for a person', () => {
    assert.equal(classifyEntry('plaza-suite-2022', claim({ slug: 'plaza-suite-2022' }), bySlug, ctx).action, 'report');
  });

  it('keeps old behavior (report) without ctx', () => {
    assert.equal(classifyEntry('wicked-2003', claim({ slug: 'wicked' }), bySlug).action, 'report');
  });
});

describe('claim rejection memory', () => {
  it('remembers URLs inside prose sources, normalized', () => {
    const archive = { shows: {} };
    triage.recordRejection(archive, { slug: 'leo', entry: { recoupedSource: 'Profile says so ([x](https://palmerpb.com/a/?utm_source=openai))' }, detail: 'no', now: 't' });
    assert.ok(triage.isRejectedSource(archive, 'leo', 'https://palmerpb.com/a'));
    assert.ok(!triage.isRejectedSource(archive, 'leo', 'https://playbill.com/other'));
  });

  it('deep research drops a claim only when every cited URL was rejected', () => {
    const archive = { shows: {} };
    triage.recordRejection(archive, { slug: 'bug', entry: { recoupedSource: 'https://playbill.com/old?utm_source=x' }, detail: 'wrong production', now: 'n' });
    assert.equal(triage.rejectedClaimSource(archive, 'bug', 'Per https://playbill.com/old.'), 'https://playbill.com/old');
    assert.equal(triage.rejectedClaimSource(archive, 'bug', 'https://playbill.com/old and https://variety.com/new'), null);
    assert.equal(triage.rejectedClaimSource(archive, 'bug', 'no link at all'), null);
  });

  it('a later archive write for the same slug keeps earlier rejected URLs', () => {
    const archive = { shows: {} };
    triage.recordRejection(archive, { slug: 's', entry: { recoupedSource: 'https://a.com/1' }, detail: 'x', now: 't' });
    triage.recordRejection(archive, { slug: 's', entry: { recoupedSource: 'https://b.com/2' }, detail: 'y', now: 't' });
    triage.writeArchiveRecord(archive, 's', { archivedReason: 'low-confidence-aged-out' });
    assert.ok(triage.isRejectedSource(archive, 's', 'https://a.com/1'));
    assert.ok(triage.isRejectedSource(archive, 's', 'https://b.com/2'));
  });
});

describe('Linear card commands', () => {
  it('uses the pending key for --show and --reject when it differs from the slug', () => {
    const notes = buildNotes({ slug: 'wicked', pendingKey: 'wicked-2003' });
    assert.match(notes, /--show=wicked-2003/);
    assert.match(notes, /--reject=wicked-2003/);
  });
});
