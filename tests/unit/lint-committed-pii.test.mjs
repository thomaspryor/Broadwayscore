/**
 * Unit tests for scripts/lib/pii-scan.js and scripts/lint-committed-pii.js
 * (task #1074). Pattern: require() the real functions; never copy logic
 * into tests (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scanJsonValue, formatPath, maskEmail, EMAIL_RE } = require('../../scripts/lib/pii-scan.js');
const { scanFile, ALLOWLIST } = require('../../scripts/lint-committed-pii.js');

describe('EMAIL_RE', () => {
  test('matches a plain email address', () => {
    assert.strictEqual(EMAIL_RE.test('jane.doe@example.com'), true);
  });

  test('does not match a bare domain or slug string', () => {
    assert.strictEqual(EMAIL_RE.test('a-midsummer-nights-dream-west-end-2026'), false);
  });
});

describe('maskEmail', () => {
  test('masks the local part, keeps the domain', () => {
    assert.strictEqual(maskEmail('jane.doe@example.com'), 'j******e@example.com');
  });

  test('leaves a non-email string untouched', () => {
    assert.strictEqual(maskEmail('no email here'), 'no email here');
  });
});

describe('formatPath', () => {
  test('joins object keys with dots', () => {
    assert.strictEqual(formatPath(['entries', 'submitter', 'email']), 'entries.submitter.email');
  });

  test('renders array indices with brackets', () => {
    assert.strictEqual(formatPath(['entries', 3, 'description']), 'entries[3].description');
  });

  test('empty path renders as empty string', () => {
    assert.strictEqual(formatPath([]), '');
  });
});

describe('scanJsonValue — the #1064 bug shape', () => {
  test('flags an email baked into a free-text description field (routeAlert() shape)', () => {
    const doc = {
      entries: [
        {
          conditionKey: 'feedback-outcome:missing-show',
          title: 'Feedback from Jane Submitter',
          description: 'Jane Submitter (jane.submitter@example.com) asked: please add this show.',
          severity: 'info',
        },
      ],
    };
    const findings = scanJsonValue(doc);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].type, 'email-shaped-string');
    assert.deepStrictEqual(findings[0].path, ['entries', 0, 'description']);
  });

  test('flags a compound submitterEmail key even without an @ pattern', () => {
    const doc = { entries: [{ submitterEmail: 'redacted-but-present' }] };
    const findings = scanJsonValue(doc);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].type, 'pii-key');
    assert.strictEqual(findings[0].key, 'submitterEmail');
  });

  test('flags snake_case and mixed-case compound PII keys', () => {
    const doc = { requester_name: 'Jane Doe', RequesterEmail: 'x' };
    const findings = scanJsonValue(doc);
    const keys = findings.map((f) => f.key).sort();
    assert.deepStrictEqual(keys, ['RequesterEmail', 'requester_name']);
  });

  test('flags bare name/email keys nested under a submitter object', () => {
    const doc = { submitter: { name: 'Jane Doe', email: 'jane@example.com' } };
    const findings = scanJsonValue(doc);
    // email value itself also matches EMAIL_RE, so 3 findings total (name key,
    // email key, email-shaped string) — assert each type is present.
    const types = findings.map((f) => f.type);
    assert.ok(types.includes('pii-key'));
    assert.ok(types.includes('email-shaped-string'));
  });
});

describe('scanJsonValue — false-positive resistance (real data/audit shapes)', () => {
  test('does not flag a critic byline name', () => {
    const doc = { critic: { name: 'Jesse Green', outlet: 'The New York Times' } };
    assert.deepStrictEqual(scanJsonValue(doc), []);
  });

  test('does not flag a slug-migration "from"/"to" pair (slug-misroute-audit.json shape)', () => {
    const doc = { from: 'a-midsummer-nights-dream-globe-west-end-2026', to: 'a-midsummer-nights-dream-west-end-2026' };
    assert.deepStrictEqual(scanJsonValue(doc), []);
  });

  test('does not flag a top-level bare "name" or "email" key outside a submitter-shaped parent', () => {
    const doc = { name: 'Some Show Title', email: 'not-actually-an-address-just-a-key-name' };
    assert.deepStrictEqual(scanJsonValue(doc), []);
  });

  test('does not flag an unrelated free-text field with no email pattern', () => {
    const doc = { description: 'Deployed coverage — the site is serving stale coverage' };
    assert.deepStrictEqual(scanJsonValue(doc), []);
  });

  test('clean fixture (tests/fixtures/lint-committed-pii/clean.json) scans clean end-to-end', () => {
    const { error, findings } = scanFile('tests/fixtures/lint-committed-pii/clean.json');
    assert.strictEqual(error, null);
    assert.deepStrictEqual(findings, []);
  });
});

describe('scanFile — end-to-end against fixtures', () => {
  test('the dirty fixture (submitter email in a queued digest description) trips the scan', () => {
    const { error, findings } = scanFile('tests/fixtures/lint-committed-pii/dirty-description.json');
    assert.strictEqual(error, null);
    assert.ok(findings.length >= 1);
    assert.ok(findings.some((f) => f.type === 'email-shaped-string'));
  });

  test('a missing file reports a parse error, not a crash', () => {
    const { error, findings } = scanFile('tests/fixtures/lint-committed-pii/does-not-exist.json');
    assert.ok(error);
    assert.deepStrictEqual(findings, []);
  });
});

describe('ALLOWLIST', () => {
  test('is a Map, and every entry has a non-empty justification', () => {
    assert.ok(ALLOWLIST instanceof Map);
    for (const [file, reason] of ALLOWLIST) {
      assert.ok(file.startsWith('data/audit/'), `${file} should be a data/audit path`);
      assert.ok(typeof reason === 'string' && reason.length > 10, `${file} needs a real justification`);
    }
  });
});
