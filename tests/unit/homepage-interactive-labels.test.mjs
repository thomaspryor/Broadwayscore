// Regression test for task #78 (PostHog rage-click card): 3x rage clicks on
// 'CRITICS ↑' and 2x on 'Broadway' on the homepage. Prior triage (2026-08-14,
// BRO-343 loop v3) confirmed CRITICS is a fully working sort toggle
// (src/components/HomePageClient.tsx, onChange wired, title tooltip present)
// — a discoverability gap, not a broken handler. 'Broadway' is the header
// market-switcher pill (src/components/MarketNav.tsx): a real <button> that
// opens a dropdown, but below 400px width its chevron indicator was fully
// `hidden`, so the word "Broadway" alone gave no visual cue it was
// interactive on narrow phones — the likely false-affordance culprit.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe("homepage 'CRITICS' sort toggle has real interactivity + feedback", () => {
  const src = readFileSync(join(ROOT, 'src/components/HomePageClient.tsx'), 'utf8');

  test('CRITICS option is wired into the SORT ToggleBar with a live onChange handler', () => {
    const sortBarStart = src.indexOf('label="SORT:"');
    assert.ok(sortBarStart !== -1, 'SORT ToggleBar not found in HomePageClient.tsx');
    const sortBarEnd = src.indexOf('ariaLabel="Sort shows"', sortBarStart);
    assert.ok(sortBarEnd !== -1, 'end of SORT ToggleBar not found');
    const block = src.slice(sortBarStart, sortBarEnd);

    assert.match(block, /value:\s*'score_desc'/, 'CRITICS option (score_desc) missing from SORT options');
    assert.match(
      block,
      /next = sort === 'score_desc' \? 'score_asc' : 'score_desc'/,
      'CRITICS click handler must toggle score_desc <-> score_asc (visible re-sort feedback)',
    );
  });

  test('CRITICS option carries a title tooltip that reflects current sort state', () => {
    const sortBarStart = src.indexOf('label="SORT:"');
    const sortBarEnd = src.indexOf('ariaLabel="Sort shows"', sortBarStart);
    const block = src.slice(sortBarStart, sortBarEnd);
    assert.match(block, /Sorted by \$\{scoreLabel\}, highest first, click to reverse/);
    assert.match(block, /Click to sort by \$\{scoreLabel\}/);
  });
});

describe('ToggleBar renders visible click affordance (not a static label)', () => {
  const src = readFileSync(join(ROOT, 'src/components/show-cards/ToggleBar.tsx'), 'utf8');

  test('default-variant buttons carry cursor-pointer, hover, and pressed-state styling', () => {
    assert.match(src, /cursor-pointer/);
    assert.match(src, /hover:underline/);
    assert.match(src, /aria-pressed=\{value === option\.value\}/);
    assert.match(src, /title=\{option\.title\}/);
  });

  test('options render as real <button> elements with an onClick, not plain text', () => {
    assert.match(src, /<button[\s\S]*?onClick=\{\(\) => onChange\(option\.value\)\}/);
  });
});

describe("homepage 'Broadway' market pill shows its dropdown affordance at every width", () => {
  const src = readFileSync(join(ROOT, 'src/components/MarketNav.tsx'), 'utf8');

  test('market pill is a real button with a click handler and aria-haspopup', () => {
    const pillStart = src.indexOf('aria-label="Switch market"');
    assert.ok(pillStart !== -1, 'market pill not found in MarketNav.tsx');
    const pillBlockStart = src.lastIndexOf('<button', pillStart);
    assert.match(src.slice(pillBlockStart, pillStart), /onClick=\{\(\) => setIsOpen\(!isOpen\)\}/);
    assert.match(src.slice(pillBlockStart, pillStart), /aria-haspopup="listbox"/);
  });

  test('dropdown chevron is never fully hidden — only shrunk on narrow widths', () => {
    const chevronMatch = src.match(/<svg className=\{`([^`]*)transition-transform[^`]*`\}/);
    assert.ok(chevronMatch, 'chevron <svg> className template not found');
    const chevronClasses = chevronMatch[1];

    // Regression guard: this used to be `hidden min-[400px]:block`, which
    // hid the dropdown indicator entirely below 400px viewport width.
    assert.doesNotMatch(
      chevronClasses,
      /\bhidden\b/,
      'chevron must not be unconditionally hidden — that removes the only visual cue the "Broadway" pill opens a dropdown on narrow phones',
    );
    assert.match(chevronClasses, /\bblock\b/, 'chevron must render (block) at every width');
  });
});
