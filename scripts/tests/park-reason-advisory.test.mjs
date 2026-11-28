// BRO-5372: a technical park reason must not be worded like an owner hold.
// 72 open cards were held out of every worker queue on 2026-10-14 because their
// PARKED line said "judgment", "decide", "human triage" or "this session", which
// OWNER_HOLD_PARK_RE reads as the owner's call. Fixtures below are real park
// reasons from those cards. Per CLAUDE.md 15 every assertion runs the real
// exported functions.
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parkReasonAdvisory, OWNER_HOLD_PARK_RE, isDrainableSessionParked } = require('../lib/headless-dispatchability.js');
const { FRICTION_PARK_REASON, MISSING_SHOW_PARK_REASON } = require('../posthog-friction-analyzer.js');

const REAL_OWNER_HOLDS = [
  'needs owner decision: Mail+ subscription (99p/mo) for cookie-auth scraping of star ratings',
  'Requires interactive Google OAuth consent (owner login) to mint a new refresh token — cannot be done headlessly from this machine.',
  "Owner product call: the site deliberately shows no % for closed shows (getRecoupmentDisplayMode 'none' after a final designation); showing a cited figure is a new public claim",
  'owner spend decision: 49 gather dispatches per promotion batch costs ScrapingBee/SERP credits; workflow edit also needs a §18 plan review from a desktop session',
  'bulk board mutation (108 issues) — needs explicit owner sign-off before running, not an auto-dispatch',
  "owner scheduling decision: external commitment on the owner's calendar, no CLI/API path exists from this machine",
  "needs the owner's Mac: cookie extraction runs in the local browser, not in CI",
  'Each item is a product or account decision only the owner can make; see notes',
];

const TECHNICAL_WORDED_AS_HOLDS = [
  'per-outlet naming judgment; data plan batch',
  '99 rows need per-workflow reading to decide stage-it vs read-only vs composite-action staging; a session of its own',
  'Changes score inputs for the whole corpus: needs scoring-delta.js and an owner-visible before/after, more than this session',
  "needs a rescore after clearing the flags; data plan + rescore dispatch, not this session's red-main scope",
  'Weekly PostHog friction scan finding — needs human triage before work starts',
  'Needs a design call: audit-regex-patterns.js --full reads data/review-texts, which cloud sessions often lack, so a hard Stop gate would force NO-VERIFY on every cloud edit',
  'policy/standardization decision — owner should decide scope before dispatch',
];

test('a real owner hold gets no advisory', () => {
  for (const r of REAL_OWNER_HOLDS) assert.strictEqual(parkReasonAdvisory(r), null, r);
});

test('technical work worded as an owner hold gets an advisory naming the word', () => {
  for (const r of TECHNICAL_WORDED_AS_HOLDS) {
    const adv = parkReasonAdvisory(r);
    assert.ok(adv && adv.startsWith('PARK-ADVISORY:'), r);
    assert.match(adv, /--dispatch/);
    assert.ok(adv.includes(`"${r.match(OWNER_HOLD_PARK_RE)[0]}"`), adv);
  }
});

test('a technical reason that does not read as a hold gets no advisory', () => {
  assert.strictEqual(parkReasonAdvisory('needs a rule-18 /second-opinion verdict before the workflow edit'), null);
  assert.strictEqual(parkReasonAdvisory(''), null);
  assert.strictEqual(parkReasonAdvisory(undefined), null);
});

test('the PostHog filer park reasons do not read as owner holds', () => {
  for (const r of [FRICTION_PARK_REASON, MISSING_SHOW_PARK_REASON]) {
    assert.strictEqual(OWNER_HOLD_PARK_RE.test(r), false, r);
    assert.strictEqual(parkReasonAdvisory(r), null, r);
  }
  // The missing-show guard (CLAUDE.md Rule 3) must survive the reword.
  assert.match(MISSING_SHOW_PARK_REASON, /validate-show-venue/);
  assert.strictEqual(isDrainableSessionParked(`PARKED: ${MISSING_SHOW_PARK_REASON}`), false);
});

// Prevention for every filer with a literal park reason (BRO-5372 what-else: the
// three date audits filed "needs human verification" parks daily).
test('no literal --park reason in scripts/ reads as an owner hold without naming an owner-only need', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const files = fs.readdirSync(root, { recursive: true })
    .filter((f) => /\.(m?js|sh)$/.test(f) && !/\.test\.|node_modules/.test(f));
  const offenders = [];
  let seen = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    for (const m of src.matchAll(/--park['"]?\s*,?\s*['"]([^'"`$]{10,})['"]/g)) {
      seen += 1;
      if (parkReasonAdvisory(m[1])) offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.ok(seen >= 4, `expected to find the literal park reasons, found ${seen}`);
  assert.deepStrictEqual(offenders, []);
});
