import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// CLAUDE.md rule 15: require the REAL function, never a copy of its logic.
const { sbCreditVerdict } = require('./sb-credit-verdict.js');
const { parseSbUsage } = require('./provider-billing.js');

// ---------- the bug this module exists for (BRO-3032) ----------

test('BRO-3032: a real /usage payload is scored from used_api_credit, not the `used` field that does not exist', () => {
  // Verbatim shape of the live response, same fixture family as
  // provider-billing.test.mjs's exhausted-cycle case.
  const live = {
    max_api_credit: 1000000,
    used_api_credit: 75596,
    max_concurrency: 100,
    current_concurrency: 1,
    renewal_subscription_date: '2026-10-05T18:40:35.286994',
  };
  assert.equal(live.used, undefined, 'guard: the endpoint has no `used` field');

  const parsed = parseSbUsage(live);
  const status = {
    ok: true,
    maxCredits: parsed.cap,
    usedCredits: parsed.cycleUsed,
    remaining: parsed.cap - parsed.cycleUsed,
    pctUsed: Math.round((parsed.cycleUsed / parsed.cap) * 100),
  };

  const v = sbCreditVerdict(status);
  assert.equal(v.level, 'pass');
  assert.match(v.detail, /8% used/);
  // The old inline code produced exactly this, at every usage level:
  assert.doesNotMatch(v.detail, /^0% used/);
});

test('BRO-3032 regression: an exhausted cycle can actually reach fail — the old code reported 0% PASS here', () => {
  const v = sbCreditVerdict({
    ok: true, maxCredits: 1000000, usedCredits: 1000012, remaining: -12, pctUsed: 100,
  });
  assert.equal(v.level, 'fail');
});

// ---------- unreadable is never a silent pass, and never a fabricated ratio ----------

test('max_api_credit of 0 warns — it does NOT become a 100%-used fail', () => {
  // fetchSBCreditStatus classifies this as reason 'no-max' before we see it.
  const v = sbCreditVerdict({ ok: false, reason: 'no-max', message: 'max_api_credit missing from response' });
  assert.equal(v.level, 'warn');
  assert.match(v.detail, /no-max/);
  assert.doesNotMatch(v.detail, /100% used/);
});

test('a transient API error warns rather than failing an opening-night gate', () => {
  const v = sbCreditVerdict({ ok: false, reason: 'api-error', message: 'usage endpoint returned 500' });
  assert.equal(v.level, 'warn');
});

test('a missing key skips (CI-only concern), it does not pass', () => {
  const v = sbCreditVerdict({ ok: false, reason: 'no-key', message: 'SCRAPINGBEE_API_KEY not set' });
  assert.equal(v.level, 'skip');
});

test('a garbage status object warns instead of throwing or passing', () => {
  assert.equal(sbCreditVerdict(null).level, 'warn');
  assert.equal(sbCreditVerdict(undefined).level, 'warn');
  assert.equal(sbCreditVerdict({ ok: true, pctUsed: NaN }).level, 'warn');
});

// ---------- calibration ----------

test('the 75% attention line warns, it does not fail the gate (SB is a fallback; ride-it-out policy)', () => {
  const at92 = sbCreditVerdict({
    ok: true, maxCredits: 1000000, usedCredits: 922000, remaining: 78000, pctUsed: 92,
  });
  assert.equal(at92.level, 'warn', 'last cycle really hit 92%; this must not red the gate for weeks');
  assert.match(at92.detail, /attention line/);
});

test('thresholds ladder: 50 pass, 51 warn, 76 warn, 100 fail', () => {
  const mk = (pctUsed) => sbCreditVerdict({
    ok: true, maxCredits: 100, usedCredits: pctUsed, remaining: 100 - pctUsed, pctUsed,
  });
  assert.equal(mk(50).level, 'pass');
  assert.equal(mk(51).level, 'warn');
  assert.equal(mk(76).level, 'warn');
  assert.equal(mk(100).level, 'fail');
});

// ---------- exhaustion is raw credits, never the rounded percentage ----------

test('995,000 of 1,000,000 rounds to pctUsed 100 but still has 5,000 credits — must NOT report exhausted', () => {
  // fetchSBCreditStatus Math.rounds pctUsed (check-sb-credits.js), so this
  // account presents as "100%" with a working balance. A percentage-based
  // exhaustion test fails an opening-night gate here. Both pre-ship reviewers
  // found this independently.
  const v = sbCreditVerdict({
    ok: true, maxCredits: 1000000, usedCredits: 995000, remaining: 5000, pctUsed: 100,
  });
  assert.equal(v.level, 'warn');
  assert.doesNotMatch(v.detail, /exhausted/i);
});

test('remaining exactly 0 is exhausted; remaining 1 is not', () => {
  const at0 = sbCreditVerdict({ ok: true, maxCredits: 1000, usedCredits: 1000, remaining: 0, pctUsed: 100 });
  assert.equal(at0.level, 'fail');
  const at1 = sbCreditVerdict({ ok: true, maxCredits: 1000, usedCredits: 999, remaining: 1, pctUsed: 100 });
  assert.equal(at1.level, 'warn');
});

test('an over-drawn cycle (negative remaining) is exhausted', () => {
  const v = sbCreditVerdict({ ok: true, maxCredits: 1000000, usedCredits: 1000012, remaining: -12, pctUsed: 100 });
  assert.equal(v.level, 'fail');
});

// ---------- rollback without a deploy ----------

test('an explicit failPctUsed below 100 restores a hard headroom line', () => {
  const v = sbCreditVerdict(
    { ok: true, maxCredits: 100, usedCredits: 80, remaining: 20, pctUsed: 80 },
    { failPctUsed: 75 },
  );
  assert.equal(v.level, 'fail');
  assert.match(v.detail, /hard line/);
});

test('SB_READINESS_FAIL_PCT_USED restores the 75% hard line without a code edit', () => {
  const prev = process.env.SB_READINESS_FAIL_PCT_USED;
  process.env.SB_READINESS_FAIL_PCT_USED = '75';
  try {
    const v = sbCreditVerdict({ ok: true, maxCredits: 100, usedCredits: 80, remaining: 20, pctUsed: 80 });
    assert.equal(v.level, 'fail');
  } finally {
    if (prev === undefined) delete process.env.SB_READINESS_FAIL_PCT_USED;
    else process.env.SB_READINESS_FAIL_PCT_USED = prev;
  }
});

test('a non-numeric env override is ignored rather than disabling the ladder', () => {
  const prev = process.env.SB_READINESS_FAIL_PCT_USED;
  process.env.SB_READINESS_FAIL_PCT_USED = 'not-a-number';
  try {
    const v = sbCreditVerdict({ ok: true, maxCredits: 100, usedCredits: 80, remaining: 20, pctUsed: 80 });
    assert.equal(v.level, 'warn', 'falls back to the default 100, so 80% is still only a warn');
  } finally {
    if (prev === undefined) delete process.env.SB_READINESS_FAIL_PCT_USED;
    else process.env.SB_READINESS_FAIL_PCT_USED = prev;
  }
});

// ---------- every level the module can return is mapped by the caller ----------

test('sbCreditVerdict only ever returns levels the readiness script can render', () => {
  const allowed = new Set(['pass', 'warn', 'fail', 'skip']);
  const cases = [
    null, undefined, {},
    { ok: false, reason: 'no-key' },
    { ok: false, reason: 'api-error' },
    { ok: false, reason: 'no-max' },
    { ok: true, pctUsed: NaN },
    { ok: true, maxCredits: 100, usedCredits: 0, remaining: 100, pctUsed: 0 },
    { ok: true, maxCredits: 100, usedCredits: 60, remaining: 40, pctUsed: 60 },
    { ok: true, maxCredits: 100, usedCredits: 90, remaining: 10, pctUsed: 90 },
    { ok: true, maxCredits: 100, usedCredits: 100, remaining: 0, pctUsed: 100 },
  ];
  for (const c of cases) {
    assert.ok(allowed.has(sbCreditVerdict(c).level), `unmapped level for ${JSON.stringify(c)}`);
  }
});
