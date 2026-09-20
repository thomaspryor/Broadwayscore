import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

// BRO-3456: the ticket-single-button A/B concluded 2026-09-16 (owner kept
// the single-button design — see docs/experiments/ticket-single-button.md
// "Conclusion"). scripts/validate-ab-test.js (the end-to-end distribution/
// DOM/tracking validator that would have caught a regression here) was
// deleted along with the rest of the experiment's tooling since it no
// longer has two variants to validate. These source-level checks are the
// replacement floor: they don't render the component, but they lock in the
// two invariants a future edit could most easily break silently — that the
// multi-button code path stays gone, and that its removal didn't also take
// out the still-live ticket-primary-platform flag read.

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT_PATH = join(HERE, '../../src/components/TicketButtonsAB.tsx');
const source = () => readFileSync(COMPONENT_PATH, 'utf-8');

test('TicketButtonsAB no longer reads the retired ticket-single-button flag or branches on a button-count variant', () => {
  const src = source();
  assert.doesNotMatch(src, /getFeatureFlag\(['"]ticket-single-button['"]\)/, 'must not re-add the retired flag read');
  assert.doesNotMatch(src, /abButtonVariant/, 'must not reintroduce button-variant state');
  assert.doesNotMatch(src, /isSingleButton/, 'must not reintroduce the multi/single branch condition');
  assert.doesNotMatch(src, /\bmaxButtons\b/, 'must not reintroduce the dead multi-button prop');
});

test('TicketButtonsAB still reads the live ticket-primary-platform flag (unrelated experiment, must survive this teardown)', () => {
  const src = source();
  assert.match(src, /getFeatureFlag\(['"]ticket-primary-platform['"]\)/, 'ticket-primary-platform read must not have been collaterally removed');
  assert.match(src, /overridePlatform/, 'the stubhub-override branch must still exist (see file header: do not remove)');
});

test('abVariantStr always reports buttons:single — the permanent single-CTA cohort tag Impact conversions join on', () => {
  const src = source();
  assert.match(src, /buttons:single/, 'the tracking string must keep stamping buttons:single unconditionally');
  assert.doesNotMatch(src, /buttons:\$\{buttonsPart\}/, 'must not reintroduce a variant-dependent buttons segment');
});

// Task #1936 (/show/oh-mary rage clicks): TicketButtonsAB used to
// `return null` until the ticket-primary-platform PostHog flag resolved
// (up to 5s poll + timeout), leaving the primary "Get Tickets" CTA
// completely absent on every load — a silent-gap rage-click trap on
// high-intent pages (same class as the closed-show gap, CLAUDE.md card
// #228 / task #90 / getTicketCtaNote above), just time-based instead of
// permanent. Fix: render immediately with the default (unresolved-flag)
// ordering, which is already control-equivalent since the flag is locked
// 100% todaytix; the override only applies on top once/if the flag
// resolves to the 0%-rollout stubhub variant.
test('TicketButtonsAB does not gate its render on the PostHog flag resolving (no rage-click silent gap)', () => {
  const src = source();
  assert.doesNotMatch(src, /flagsLoaded/, 'must not reintroduce a flagsLoaded state that blocks the initial render');
  assert.doesNotMatch(src, /if \(!flagsLoaded\) return null/, 'must not reintroduce the render-blocking gate that hid the CTA for up to 5s');
});
