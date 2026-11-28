import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);

// Notion card 3b1637c5-416f-8163-a707-e156f5e1efc3 (BRO-141): a 2026-08-16
// measurement swept 5 outlet/domain pools to a reproducible zero recovery
// rate (192 combined candidates, 0 recovered — old/niche sites with near-zero
// Google indexing, or paywalled). The card's acceptance criteria is to guard
// that decision in CODE rather than operator memory, so a future session
// can't silently re-burn real SERP provider spend re-running them. This test
// require()s the real exported guard (CLAUDE.md rule 15) rather than
// reimplementing the list.
const {
  isProvenZeroSweep,
  buildDomainOutletIds,
  PROVEN_ZERO_SWEEP_DOMAINS,
  PROVEN_ZERO_SWEEP_OUTLETS,
} = require('../lib/serp-text-recovery-candidates.js');
const { OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES } = require('../lib/url-discovery.js');

test('proven-zero domain pools are guarded', () => {
  for (const domain of ['lightingandsoundamerica.com', 'wolfentertainmentguide.com', 'dailymail.co.uk', 'thetimes.co.uk']) {
    assert.equal(isProvenZeroSweep({ domain, outlet: null }), true, `expected ${domain} to be guarded`);
  }
});

test('AP is guarded in --outlet mode (0/18 measured via --outlet=ap, not --domain)', () => {
  assert.equal(isProvenZeroSweep({ domain: null, outlet: 'ap' }), true);
});

test('AP is NOT guarded as a bare --domain target when no outlet-domain map is passed (documents the optional-arg fallback)', () => {
  // Without outletDomains/domainAliases, isProvenZeroSweep can only check the
  // static PROVEN_ZERO_SWEEP_DOMAINS list — apnews.com was never added to it
  // directly (the measured zero was --outlet=ap, not --domain=apnews.com).
  assert.equal(isProvenZeroSweep({ domain: 'apnews.com', outlet: null }), false);
});

test('AP IS guarded as --domain=apnews.com (and its alias abcnews.go.com) once outletDomains/domainAliases are passed — closes the alias bypass', () => {
  // ship-check regression: BRO-141's own alias-expansion commit
  // (buildDomainOutletIds) made --domain=apnews.com / --domain=abcnews.go.com
  // reach the exact same AP-attributed candidate pool that --outlet=ap was
  // measured at 0/18. Without this, the alias generalization silently
  // reopened the guard it's supposed to protect. This is the real call the
  // CLI makes — recover-serp-text.js always passes both maps.
  assert.equal(isProvenZeroSweep({ domain: 'apnews.com', outlet: null }, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES), true);
  assert.equal(isProvenZeroSweep({ domain: 'abcnews.go.com', outlet: null }, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES), true);
});

test('un-swept outlets/domains are not guarded even with the full maps passed (vulture and nypost — the recommended next sweep)', () => {
  assert.equal(isProvenZeroSweep({ domain: 'vulture.com', outlet: null }, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES), false);
  assert.equal(isProvenZeroSweep({ domain: 'nypost.com', outlet: null }, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES), false);
});

test('sanity: apnews.com really does resolve to outletId "ap" and abcnews.go.com really is its registered alias (guards against the fixture itself drifting)', () => {
  assert.equal(OUTLET_DOMAINS['ap'], 'apnews.com');
  const aliasSet = REGISTRY_DOMAIN_ALIASES['apnews.com'];
  assert.ok(aliasSet && aliasSet.has('abcnews.go.com'));
  assert.ok(buildDomainOutletIds('apnews.com', OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES).has('ap'));
});

test('a target with neither domain nor outlet is not guarded', () => {
  assert.equal(isProvenZeroSweep({ domain: null, outlet: null }), false);
});

test('PROVEN_ZERO_SWEEP_DOMAINS and PROVEN_ZERO_SWEEP_OUTLETS match the measured pools exactly (no drift)', () => {
  assert.deepEqual([...PROVEN_ZERO_SWEEP_DOMAINS].sort(), [
    'dailymail.co.uk',
    'lightingandsoundamerica.com',
    'thetimes.co.uk',
    'wolfentertainmentguide.com',
  ]);
  assert.deepEqual([...PROVEN_ZERO_SWEEP_OUTLETS], ['ap']);
});

test('recover-serp-text.js refuses a proven-zero --domain sweep at the CLI without --force-exhausted', () => {
  let stderr = '';
  let exitCode = 0;
  try {
    execFileSync('node', ['scripts/recover-serp-text.js', '--domain=dailymail.co.uk', '--dry-run', '--limit=1'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status;
    stderr = e.stderr || '';
  }
  assert.notEqual(exitCode, 0, 'expected a non-zero exit for a guarded sweep');
  assert.match(stderr, /proven-zero sweep/);
  assert.match(stderr, /--force-exhausted/);
});

test('recover-serp-text.js refuses a proven-zero --outlet=ap sweep at the CLI without --force-exhausted', () => {
  let stderr = '';
  let exitCode = 0;
  try {
    execFileSync('node', ['scripts/recover-serp-text.js', '--outlet=ap', '--dry-run', '--limit=1'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status;
    stderr = e.stderr || '';
  }
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /proven-zero sweep/);
});

test('proven-zero DOMAIN-list entries are ALSO guarded via their own registered aliases (dailymail.com, thetimes.com)', () => {
  // what-else finding: the guard closed the OUTLET-alias bypass (ap ->
  // apnews.com/abcnews.go.com) but missed the symmetric case for entries
  // already in PROVEN_ZERO_SWEEP_DOMAINS itself — daily-mail's own registry
  // alias (dailymail.com) and times-uk's (thetimes.com) were reachable
  // without tripping the guard.
  const aliasSet1 = REGISTRY_DOMAIN_ALIASES['dailymail.co.uk'];
  const aliasSet2 = REGISTRY_DOMAIN_ALIASES['thetimes.co.uk'];
  assert.ok(aliasSet1 && aliasSet1.has('dailymail.com'), 'expected dailymail.co.uk alias fixture to still be registered');
  assert.ok(aliasSet2 && aliasSet2.has('thetimes.com'), 'expected thetimes.co.uk alias fixture to still be registered');
  assert.equal(isProvenZeroSweep({ domain: 'dailymail.com', outlet: null }, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES), true);
  assert.equal(isProvenZeroSweep({ domain: 'thetimes.com', outlet: null }, OUTLET_DOMAINS, REGISTRY_DOMAIN_ALIASES), true);
});

test('recover-serp-text.js refuses --domain=dailymail.com (alias of the guarded dailymail.co.uk) at the CLI', () => {
  let stderr = '';
  let exitCode = 0;
  try {
    execFileSync('node', ['scripts/recover-serp-text.js', '--domain=dailymail.com', '--dry-run', '--limit=1'], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    exitCode = e.status;
    stderr = e.stderr || '';
  }
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /proven-zero sweep/);
});

test('recover-serp-text.js refuses --domain=apnews.com and --domain=abcnews.go.com too — the alias bypass is closed end-to-end', () => {
  for (const domain of ['apnews.com', 'abcnews.go.com']) {
    let stderr = '';
    let exitCode = 0;
    try {
      execFileSync('node', ['scripts/recover-serp-text.js', `--domain=${domain}`, '--dry-run', '--limit=1'], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      exitCode = e.status;
      stderr = e.stderr || '';
    }
    assert.notEqual(exitCode, 0, `expected --domain=${domain} to be refused`);
    assert.match(stderr, /proven-zero sweep/);
  }
});
