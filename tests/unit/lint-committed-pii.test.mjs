/**
 * Unit tests for scripts/lib/pii-scan.js and scripts/lint-committed-pii.js
 * (task #1074). Pattern: require() the real functions; never copy logic
 * into tests (CLAUDE.md rule 15).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { scanJsonValue, scanJsonlValue, formatPath, maskEmail, EMAIL_RE } = require('../../scripts/lib/pii-scan.js');
const { scanFile, listTrackedAuditFiles, ALLOWLIST } = require('../../scripts/lint-committed-pii.js');

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

describe('scanJsonlValue — JSON Lines coverage (task #1092)', () => {
  test('flags a submitter email baked into a title field, queued-alert-attempt shape', () => {
    const text =
      '{"ts":"2026-08-06T00:00:00.000Z","conditionKey":"feedback-outcome:missing-show",' +
      '"title":"Feedback from Jane Submitter (jane.submitter@example.com): please add this show",' +
      '"ok":true,"error":null}\n';
    const findings = scanJsonlValue(text);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].type, 'email-shaped-string');
    assert.deepStrictEqual(findings[0].path, ['line1', 'title']);
  });

  test('skips a line that fails to parse instead of throwing', () => {
    const text = '{"title":"clean line"}\nnot valid json\n{"title":"also clean"}\n';
    assert.deepStrictEqual(scanJsonlValue(text), []);
  });

  test('ignores blank lines', () => {
    const text = '{"title":"clean"}\n\n\n{"title":"still clean"}\n';
    assert.deepStrictEqual(scanJsonlValue(text), []);
  });

  test('clean fixture scans clean end-to-end via scanFile', () => {
    const { error, findings } = scanFile('tests/fixtures/lint-committed-pii/clean.jsonl');
    assert.strictEqual(error, null);
    assert.deepStrictEqual(findings, []);
  });

  test('the dirty fixture (submitter email in a queued alert-attempt title) trips the scan via scanFile', () => {
    const { error, findings } = scanFile('tests/fixtures/lint-committed-pii/dirty-attempts.jsonl');
    assert.strictEqual(error, null);
    assert.ok(findings.some((f) => f.type === 'email-shaped-string'));
  });

  test('a malformed line is recorded on badLineNumbers instead of silently vanishing', () => {
    const { badLineNumbers } = scanFile('tests/fixtures/lint-committed-pii/dirty-attempts.jsonl');
    assert.deepStrictEqual(badLineNumbers, [2]);
  });

  test('a clean jsonl file reports an empty badLineNumbers', () => {
    const { badLineNumbers } = scanFile('tests/fixtures/lint-committed-pii/clean.jsonl');
    assert.deepStrictEqual(badLineNumbers, []);
  });
});

describe('listTrackedAuditFiles — task #1092', () => {
  test('includes both .json and .jsonl tracked files', () => {
    const files = listTrackedAuditFiles();
    assert.ok(files.some((f) => f.endsWith('.json')), 'expected at least one tracked .json file');
    assert.ok(files.some((f) => f.endsWith('.jsonl')), 'expected at least one tracked .jsonl file');
  });
});

describe('ALLOWLIST', () => {
  test('is a Map, and every entry has a justification + a positive finite maxFindings', () => {
    assert.ok(ALLOWLIST instanceof Map);
    for (const [file, entry] of ALLOWLIST) {
      assert.ok(file.startsWith('data/audit/'), `${file} should be a data/audit path`);
      assert.ok(typeof entry.reason === 'string' && entry.reason.length > 10, `${file} needs a real justification`);
      assert.ok(Number.isFinite(entry.maxFindings) && entry.maxFindings > 0, `${file} needs a positive maxFindings`);
    }
  });

  test('the allowlisted file is skipped at its current finding count', () => {
    const entry = ALLOWLIST.get('data/audit/truncated-reviews-to-fix.json');
    assert.ok(entry, 'expected truncated-reviews-to-fix.json to still be allowlisted');
    const { findings } = scanFile('data/audit/truncated-reviews-to-fix.json');
    assert.ok(
      findings.length <= entry.maxFindings,
      `live finding count ${findings.length} exceeds allowlisted baseline ${entry.maxFindings} — ` +
        'a NEW hit landed in this file and the baseline must be reviewed, not silently raised'
    );
  });
});

describe('redaction placeholders are not submitter PII', () => {
  const { isRedactedPlaceholder } = require('../../scripts/lib/pii-scan.js');

  // The exact string that took Lint Workflows red on 2026-09-02: an audit row
  // quoted a Linear issue about NOT leaking a GitHub token, and the issue body
  // contained the already-redacted credential-in-URL form. EMAIL_RE matches the
  // `gho_REDACTED@github.com` substring.
  const REAL_CASE =
    'record-push-ledger.js prints https://gho_REDACTED@github.com/thomaspryor/Broadwayscore.git verbatim';

  test('the real BRO-2353 credential-in-URL string is not flagged', () => {
    assert.ok(EMAIL_RE.test(REAL_CASE), 'precondition: EMAIL_RE still matches it');
    assert.ok(isRedactedPlaceholder(REAL_CASE));
    assert.equal(scanJsonValue({ notes: REAL_CASE }).length, 0);
  });

  test('other redaction spellings are covered', () => {
    for (const s of ['ghp_REDACTED@github.com', 'redacted@example.com', 'token_Redacted@github.com']) {
      assert.ok(isRedactedPlaceholder(s), `${s} should read as redacted`);
    }
  });

  test('asterisk-masked forms were never matched, so they need no carve-out', () => {
    // EMAIL_RE's local part is [A-Za-z0-9._%+-]+ and excludes `*`. Asserted so
    // nobody "helpfully" adds a masking-character branch to REDACTED_LOCAL_RE
    // that looks like protection but can never fire.
    assert.equal(EMAIL_RE.test('****@example.com'), false);
    assert.equal(scanJsonValue({ notes: '****@example.com' }).length, 0);
    assert.equal(isRedactedPlaceholder('****@example.com'), false, 'no EMAIL_RE hit means nothing to excuse');
  });

  test('a REAL address is still flagged, including on the same domains', () => {
    // This is the whole risk of the carve-out. Allowlisting the github.com
    // domain would have hidden the first of these; keying on the local part
    // does not.
    for (const s of ['someone@github.com', 'j.green@nystagereview.com', 'entrant+tag@gmail.com']) {
      assert.equal(isRedactedPlaceholder(s), false, `${s} must NOT read as redacted`);
      assert.ok(scanJsonValue({ notes: s }).length > 0, `${s} must still be flagged`);
    }
  });

  test('a redacted-looking local part does not suppress a real address elsewhere in the same string', () => {
    // maskEmail/EMAIL_RE only look at the FIRST match, so a string carrying
    // both must stay flagged rather than being waved through on the first hit.
    const mixed = 'ref gho_REDACTED@github.com and contact entrant@gmail.com';
    assert.ok(scanJsonValue({ notes: mixed }).length > 0, 'a real address after a placeholder must still flag');
  });
});
