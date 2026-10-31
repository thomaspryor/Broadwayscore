// BRO-6336: an any-confidence entry whose quoted figure verifies on the fetched page applies with no human step;
// unconfirmed ones are rejected with a reason; rows a person must settle stay pending for the Linear card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { verifiedOutcome } = require('../../scripts/lib/pending-verify-policy');
const { verifyFigure, showTitleForms } = require('../../scripts/lib/commercial-source-verify');

const page = '<html><head><title>Lear Capitalization</title></head><body><h1>King Lear</h1><p>The 2019 production of King Lear was capitalized at $4.9 million, Forbes reported.</p></body></html>';
const evidenceFor = (entry) => {
  const ev = {};
  const r = verifyFigure(entry.capitalization, page, { titles: showTitleForms('King Lear'), year: '2019', field: 'capitalization' });
  if (r.found) ev.capitalization = r;
  return ev;
};

test('a LOW-confidence entry whose figure the page confirms applies', () => {
  const entry = { confidence: 'low', capitalization: 4900000 };
  const ev = evidenceFor(entry);
  assert.ok(ev.capitalization, 'the verifier found the quote');
  assert.deepEqual(verifiedOutcome(entry, ev), { action: 'apply' });
});

test('a figure the page does not state is rejected with a reason, not applied', () => {
  const entry = { confidence: 'high', capitalization: 6000000 };
  const out = verifiedOutcome(entry, evidenceFor(entry));
  assert.equal(out.action, 'reject');
  assert.match(out.reason, /capitalization/);
});

test('fetch failures retry, then reject on the last attempt', () => {
  const entry = { capitalization: 4900000 };
  assert.equal(verifiedOutcome(entry, { fetchFailed: true }).action, 'retry');
  const last = verifiedOutcome({ ...entry, sourceVerifyAttempts: 2 }, { fetchFailed: true });
  assert.equal(last.action, 'reject');
  assert.match(last.reason, /could not be fetched/);
});

test('cap defers, and an entry with no figure to check falls through to the normal guards', () => {
  assert.equal(verifiedOutcome({ capitalization: 1 }, { capped: true }).action, 'defer');
  assert.equal(verifiedOutcome({ recouped: false }, {}).action, 'apply');
});

// BRO-6471: this pass once emailed the owner every held or rejected row. Any new hold type (stale Trickle returns,
// BRO-6333) flowed straight into that email as "a commercial update ... needs a person to edit commercial.json".
// None of it was an owner action: held rows go to a worker card from the health check, rejected ones to the archive.
test('the daily verified-apply pass sends the owner no email', () => {
  const wf = fs.readFileSync(new URL('../../.github/workflows/commercial-pending-daily.yml', import.meta.url), 'utf8')
    .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(wf, /RESEND_API_KEY|OWNER_EMAIL|sendEmailAlert|send-[a-z-]+\.js/, 'a new owner email from this pass needs an owner action (docs/owner-email-guidelines.md)');
});
