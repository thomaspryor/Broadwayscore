// outlet-domain-validation.test.mjs — task #1926.
//
// Real incident: data/review-texts/paranormal-activity-2026/vulture--sandy-macdonald.json
// carried outletId "vulture" (T1, weight 1.0) with a url on
// newyorknotebook.substack.com — a host that matches none of vulture's
// registered domains (vulture.com, domainAliases nymag.com/newyorkmetro.com).
// Nothing gated on that mismatch, so isIncludableForRebuild() returned true
// and the next rebuild would have double-counted a T1 outlet.
//
// A first version of this gate checked EVERY outletId+url review-texts file
// unconditionally and was caught by adversarial review before ship: a full
// corpus scan found 722 currently-includable files across 78 outlets that
// would have been WRONGLY excluded (wire services syndicating on partner
// domains, aggregator-sourced score stubs, historical archival provenance).
// The fix scopes the check to `source === 'submit-review-form'` (the literal
// stamp both the form and audit-aggregator-gap auto-ingest write) plus a
// wire-service exemption — see the file header for the corpus numbers. These
// tests lock in BOTH halves: the gate still catches the real incident, and it
// does not regress the corpus classes that caused the false positives.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const {
  hostMatchesDomain,
  hostMatchesOutletDomain,
  hasOutletDomainEscapeHatch,
  explainOutletDomainMismatch,
} = require_('./outlet-domain-validation.js');

// ── Pure-function unit tests — injected fixture registry ───────────────────

const FIXTURE_REGISTRY = {
  outlets: {
    vulture: { domain: 'vulture.com', domainAliases: ['nymag.com', 'newyorkmetro.com'] },
    ap: { domain: 'ap.org' },
    'no-domain-outlet': { domain: null },
    'no-registry-entry-outlet': undefined,
  },
};

describe('hostMatchesDomain — subdomain-aware, not loose substring', () => {
  test('exact match', () => {
    assert.equal(hostMatchesDomain('vulture.com', 'vulture.com'), true);
  });
  test('subdomain matches', () => {
    assert.equal(hostMatchesDomain('amp.vulture.com', 'vulture.com'), true);
  });
  test('unrelated host with domain as a substring does NOT match', () => {
    // Guards against a scraper.js-style `.includes()` false positive.
    assert.equal(hostMatchesDomain('notvulture.com', 'vulture.com'), false);
    assert.equal(hostMatchesDomain('vulture.com.evil.example', 'vulture.com'), false);
  });
  test('completely different host does not match', () => {
    assert.equal(hostMatchesDomain('newyorknotebook.substack.com', 'vulture.com'), false);
  });
});

describe('hostMatchesOutletDomain', () => {
  test('registered outlet, matching host → true', () => {
    assert.equal(
      hostMatchesOutletDomain('https://www.vulture.com/2026/08/paranormal-activity-review.html', 'vulture', FIXTURE_REGISTRY),
      true
    );
  });
  test('registered outlet, matching domainAlias host → true', () => {
    assert.equal(
      hostMatchesOutletDomain('https://nymag.com/vulture/paranormal-activity-review.html', 'vulture', FIXTURE_REGISTRY),
      true
    );
  });
  test('registered outlet, real incident mismatch host → false', () => {
    assert.equal(
      hostMatchesOutletDomain('https://newyorknotebook.substack.com/p/paranormal-activity', 'vulture', FIXTURE_REGISTRY),
      false
    );
  });
  test('alias-spelled outletId is canonicalized before lookup', () => {
    // Adversarial-review finding: outletId "nymag" (an alias, not the
    // registry's canonical key "vulture") used to miss the registry lookup
    // entirely and return null (unvalidatable) — letting a borrowed-identity
    // review through under an alias spelling. Real outlet-registry.json
    // aliases used here (not the fixture registry, which doesn't model
    // aliases) so this exercises the real normalizeOutlet() path.
    const registry = require_('../../data/outlet-registry.json');
    assert.equal(hostMatchesOutletDomain('https://newyorknotebook.substack.com/p/x', 'nymag', registry), false);
    assert.equal(hostMatchesOutletDomain('https://www.vulture.com/x', 'nymag', registry), true);
  });
  test('outlet with no registered domain → null (unvalidatable, not a mismatch)', () => {
    assert.equal(
      hostMatchesOutletDomain('https://anything.example/review', 'no-domain-outlet', FIXTURE_REGISTRY),
      null
    );
  });
  test('unregistered outlet → null', () => {
    assert.equal(
      hostMatchesOutletDomain('https://anything.example/review', 'totally-unknown-outlet', FIXTURE_REGISTRY),
      null
    );
  });
  test('missing url/outletId/registry never throws, returns null', () => {
    assert.equal(hostMatchesOutletDomain(null, 'vulture', FIXTURE_REGISTRY), null);
    assert.equal(hostMatchesOutletDomain('https://vulture.com/x', null, FIXTURE_REGISTRY), null);
    assert.equal(hostMatchesOutletDomain('https://vulture.com/x', 'vulture', null), null);
    assert.equal(hostMatchesOutletDomain('not a url', 'vulture', FIXTURE_REGISTRY), null);
  });
});

describe('hasOutletDomainEscapeHatch', () => {
  const FULL_PROTECTION = {
    allowUnvalidatedDomain: true,
    allowUnvalidatedDomainReason: 'Verified with the critic directly: this outlet syndicates via Substack.',
    humanReviewScore: 85,
    manualContentTier: 'complete',
    wrongProduction: false,
    wrongProductionManualClear: true,
    allowEarlyDate: true,
    wrongShow: false,
    contentVerification: { wrongProduction: false, wrongArticle: false },
  };
  test('all fields present → true', () => {
    assert.equal(hasOutletDomainEscapeHatch(FULL_PROTECTION), true);
  });
  test('missing allowUnvalidatedDomainReason → false', () => {
    const { allowUnvalidatedDomainReason, ...rest } = FULL_PROTECTION;
    assert.equal(hasOutletDomainEscapeHatch(rest), false);
  });
  test('empty-string reason → false', () => {
    assert.equal(hasOutletDomainEscapeHatch({ ...FULL_PROTECTION, allowUnvalidatedDomainReason: '   ' }), false);
  });
  test('missing any ONE of the 8 protection fields → false', () => {
    for (const field of [
      'humanReviewScore', 'manualContentTier', 'wrongProduction', 'wrongProductionManualClear',
      'allowEarlyDate', 'wrongShow',
    ]) {
      const clone = { ...FULL_PROTECTION };
      delete clone[field];
      assert.equal(hasOutletDomainEscapeHatch(clone), false, `missing ${field} should fail the escape hatch`);
    }
    assert.equal(
      hasOutletDomainEscapeHatch({ ...FULL_PROTECTION, contentVerification: { wrongProduction: false } }),
      false,
      'missing contentVerification.wrongArticle should fail'
    );
  });
  test('allowUnvalidatedDomain not explicitly true → false', () => {
    assert.equal(hasOutletDomainEscapeHatch({ ...FULL_PROTECTION, allowUnvalidatedDomain: 'yes' }), false);
  });
});

describe('explainOutletDomainMismatch', () => {
  test('real incident shape → mismatch reason', () => {
    const data = {
      outletId: 'vulture',
      url: 'https://newyorknotebook.substack.com/p/paranormal-activity',
      source: 'submit-review-form',
      domainUnvalidated: true,
      domainUnvalidatedReason: 'no registered domain for outlet "newyorknotebook" — URL host not checked',
    };
    const reason = explainOutletDomainMismatch(data, FIXTURE_REGISTRY);
    assert.ok(reason, 'expected a mismatch reason');
    assert.match(reason, /vulture/);
  });
  test('same mismatch on a NON-ingest source → null (scope: only submit-review-form)', () => {
    // 722-file corpus scan: bww-roundup/dtli/show-score/westendtheatre/
    // playbill-verdict/theatre-record/stagedoor/serp-discovery/newspapers-com-ocr
    // all legitimately carry a URL that doesn't live on the outlet's own
    // domain. This must NOT fire outside the validated ingest source.
    for (const source of ['bww-roundup', 'dtli', 'newspapers-com-ocr', 'serp-discovery', undefined, 'manual-url']) {
      const data = {
        outletId: 'vulture',
        url: 'https://newyorknotebook.substack.com/p/paranormal-activity',
        source,
      };
      assert.equal(explainOutletDomainMismatch(data, FIXTURE_REGISTRY), null, `source=${source} must not be gated`);
    }
  });
  test('wire-service outlet is always exempt, even on the validated ingest source', () => {
    const data = { outletId: 'ap', url: 'https://www.somepartnersite.example/ap-review', source: 'submit-review-form' };
    assert.equal(explainOutletDomainMismatch(data, FIXTURE_REGISTRY), null);
  });
  test('escape hatch satisfied → null even with a real mismatch', () => {
    const data = {
      outletId: 'vulture',
      url: 'https://newyorknotebook.substack.com/p/paranormal-activity',
      source: 'submit-review-form',
      allowUnvalidatedDomain: true,
      allowUnvalidatedDomainReason: 'Verified directly with the critic.',
      humanReviewScore: 85,
      manualContentTier: 'complete',
      wrongProduction: false,
      wrongProductionManualClear: true,
      allowEarlyDate: true,
      wrongShow: false,
      contentVerification: { wrongProduction: false, wrongArticle: false },
    };
    assert.equal(explainOutletDomainMismatch(data, FIXTURE_REGISTRY), null);
  });
  test('matching host → null', () => {
    const data = { outletId: 'vulture', url: 'https://www.vulture.com/2026/08/paranormal-activity-review.html', source: 'submit-review-form' };
    assert.equal(explainOutletDomainMismatch(data, FIXTURE_REGISTRY), null);
  });
  test('unvalidatable (domainless / unregistered outlet) → null, not excluded', () => {
    assert.equal(
      explainOutletDomainMismatch({ outletId: 'no-domain-outlet', url: 'https://anything.example/x', source: 'submit-review-form' }, FIXTURE_REGISTRY),
      null
    );
    assert.equal(
      explainOutletDomainMismatch({ outletId: 'brand-new-unregistered', url: 'https://anything.example/x', source: 'submit-review-form' }, FIXTURE_REGISTRY),
      null
    );
  });
  test('missing url or outletId → null', () => {
    assert.equal(explainOutletDomainMismatch({ outletId: 'vulture', source: 'submit-review-form' }, FIXTURE_REGISTRY), null);
    assert.equal(explainOutletDomainMismatch({ url: 'https://vulture.com/x', source: 'submit-review-form' }, FIXTURE_REGISTRY), null);
  });
});

// ── Corpus-wide false-positive guard ────────────────────────────────────────
// The actual regression test for the adversarial-review finding: run the real
// gate against the FULL local review-texts corpus (present in this worktree
// via setup-local-data.sh --all) and assert it flags at most the 2 known real
// instances — never a broader set. Skips gracefully if the corpus isn't
// present (e.g. a fresh worktree that hasn't pulled review-texts yet).

describe('corpus-wide false-positive guard', () => {
  const fs = require_('fs');
  const path = require_('path');
  const url = require_('url');
  const dirname = path.dirname(url.fileURLToPath(import.meta.url));
  const root = path.join(dirname, '..', '..', 'data', 'review-texts');
  const hasCorpus = fs.existsSync(root);

  test('at most the 2 known real instances are flagged across the full corpus', { skip: !hasCorpus && 'no review-texts corpus in this worktree (run ./scripts/setup-local-data.sh --all)' }, () => {
    const registry = require_('../../data/outlet-registry.json');
    const shows = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    const flagged = [];
    for (const showDir of shows) {
      const dir = path.join(root, showDir.name);
      let files;
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { continue; }
      for (const f of files) {
        let data;
        try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        if (!data.outletId || !data.url) continue;
        if (explainOutletDomainMismatch(data, registry)) flagged.push(`${showDir.name}/${f}`);
      }
    }
    assert.ok(
      flagged.length <= 2,
      `expected at most 2 flagged files (the known incident + its sibling), got ${flagged.length}: ${flagged.slice(0, 20).join(', ')}`
    );
  });
});

// ── Integration — the REAL review-guards.js against the REAL registry ──────
// Acceptance criteria (task #1926): fixture w/ mismatched host is NOT
// includable; same fixture + allowUnvalidatedDomain + protection fields IS
// includable; a matching-host fixture is unaffected. require()s the actual
// production functions per CLAUDE.md §15 — never copies the rule chain.

describe('review-guards.js integration — real registry, real explainExclusion', () => {
  const { isIncludableForRebuild, explainExclusion } = require_('./review-guards.js');
  const text = 'A real review with plenty of text describing the production in detail.';

  test('mismatched host on a registered T1 outlet, from the validated ingest source → excluded', () => {
    const data = {
      fullText: text,
      outletId: 'vulture',
      url: 'https://newyorknotebook.substack.com/p/paranormal-activity',
      source: 'submit-review-form',
    };
    assert.equal(explainExclusion(data, null, undefined), 'outletDomainUnvalidated');
    assert.equal(isIncludableForRebuild(data, null, undefined), false);
  });

  test('same mismatch, but NOT from the validated ingest source → unaffected, includable', () => {
    const data = {
      fullText: text,
      outletId: 'vulture',
      url: 'https://newyorknotebook.substack.com/p/paranormal-activity',
      source: 'dtli',
    };
    assert.equal(isIncludableForRebuild(data, null, undefined), true);
  });

  test('mismatched host + full escape hatch → includable', () => {
    const data = {
      fullText: text,
      outletId: 'vulture',
      url: 'https://newyorknotebook.substack.com/p/paranormal-activity',
      source: 'submit-review-form',
      allowUnvalidatedDomain: true,
      allowUnvalidatedDomainReason: 'Verified directly with the critic: this piece is a legitimate syndication.',
      humanReviewScore: 85,
      manualContentTier: 'complete',
      wrongProduction: false,
      wrongProductionManualClear: true,
      allowEarlyDate: true,
      wrongShow: false,
      contentVerification: { wrongProduction: false, wrongArticle: false },
    };
    assert.equal(isIncludableForRebuild(data, null, undefined), true);
  });

  test('matching host on the same outlet → unaffected, includable', () => {
    const data = {
      fullText: text,
      outletId: 'vulture',
      url: 'https://www.vulture.com/2026/08/paranormal-activity-review.html',
      source: 'submit-review-form',
    };
    assert.equal(isIncludableForRebuild(data, null, undefined), true);
  });

  test('no outletId at all → unaffected (this guard only fires with an outletId)', () => {
    assert.equal(isIncludableForRebuild({ fullText: text, url: 'https://example.com/review', source: 'submit-review-form' }, null, undefined), true);
  });
});
