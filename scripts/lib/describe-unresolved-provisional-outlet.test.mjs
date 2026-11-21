// BRO-4155: audit-show-review-gap.js's ingestMissingUrl used to report both a
// genuinely unparseable URL host AND a resolved-but-aggregator host (e.g. a
// Show Score self-referential/pagination URL) as the identical
// 'unknown-outlet-no-host' string, which made the show-score
// "unknown-outlet-no-host" log line undiagnosable — the host might have
// resolved just fine and been intentionally rejected as an aggregator.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeUnresolvedProvisionalOutlet, AGGREGATOR_DOMAINS } from './aggregator-domains.js';

describe('describeUnresolvedProvisionalOutlet (BRO-4155)', () => {
  test('null/missing host: genuinely unparseable URL', () => {
    assert.equal(describeUnresolvedProvisionalOutlet(null), 'unknown-outlet-no-host');
    assert.equal(describeUnresolvedProvisionalOutlet(''), 'unknown-outlet-no-host');
  });

  test('known aggregator host (show-score.com): names the host, does not claim "no-host"', () => {
    assert.ok(AGGREGATOR_DOMAINS.has('show-score.com'), 'test assumes show-score.com stays a registered aggregator domain');
    const reason = describeUnresolvedProvisionalOutlet('show-score.com');
    assert.equal(reason, 'unknown-outlet-aggregator-host (show-score.com)');
    assert.ok(!reason.includes('no-host'), 'a resolved aggregator host must not be reported as "no-host"');
  });

  test('a non-aggregator host that still failed to produce a provisional slug', () => {
    assert.equal(
      describeUnresolvedProvisionalOutlet('co'),
      'unknown-outlet-no-provisional-slug (co)',
    );
  });
});
