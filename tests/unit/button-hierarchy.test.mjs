// Button-hierarchy drift guard (2026-07-12 owner decision):
//   .btn-primary (champagne gradient, = the Get Tickets treatment) is THE
//   primary action of a screen; .btn-secondary is every other tappable action;
//   bright #FFD700 is reserved for stars/scores and must NEVER be a button or
//   background fill class. This test fails the build if a raw bright-gold fill
//   or a hand-rolled gradient sneaks back into a component.
import { test } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';

function grep(pattern) {
  try {
    return execSync(`grep -rn --include='*.tsx' --include='*.ts' -E "${pattern}" src/`, { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean);
  } catch (e) {
    if (e.status === 1) return []; // no matches
    throw e;
  }
}

test('no bright-gold (#FFD700) background/border fills outside SVG star art', () => {
  // bg-[#FFD700] / border-[#FFD700] as Tailwind classes = a gold-filled control.
  // SVG `fill="#FFD700"` (StarRating, ScoreBadge art) is the sanctioned use.
  const hits = grep('(bg|border)-\\[#FFD700\\]');
  assert.deepStrictEqual(hits, [],
    `Bright gold is reserved for stars/scores — use .btn-primary (ticket gradient) for primary actions.\n${hits.join('\n')}`);
});

test('no hex-yellow hover fills left behind', () => {
  const hits = grep('hover:bg-\\[#e6c200\\]');
  assert.deepStrictEqual(hits, [], hits.join('\n'));
});

test('btn-primary is actually in use (the system did not get deleted)', () => {
  const hits = grep('btn-primary');
  assert.ok(hits.length >= 5, `expected ≥5 btn-primary usages, found ${hits.length}`);
});

// Gold buttons and selected toggles carry WHITE text on the deeper button
// gold (owner 2026-11-13, BRO-7426: dark text on gold "looks really bad", a
// deeper gold looked muddy; option 2 picked). Gold fills with text go through
// bg-cta / bg-gradient-cta with text-shadow-cta so one token sets every button.
test('gold fills with text use the button gold and white text', () => {
  const dark = grep("(bg-cta|bg-gradient-cta|bg-brand|bg-gradient-brand)[ \\\"'][^\\\"']*text-(black|gray-900|\\\\[#1a)");
  assert.deepStrictEqual(dark, [], `dark text on a gold button:\n${dark.join('\n')}`);
  const pale = grep("(bg-brand|bg-gradient-brand)[ \\\"'][^\\\"']*text-white|text-white[^\\\"']*(bg-brand|bg-gradient-brand)[ \\\"']");
  assert.deepStrictEqual(pale, [], `gold button outside the button-gold token, use bg-cta + text-shadow-cta:\n${pale.join('\n')}`);
  // Bright amber with black text was an off-brand stand-in on the 404/error pages.
  const amber = grep("bg-amber-[45]00 text-black");
  assert.deepStrictEqual(amber, [], `amber button, use bg-cta text-white:\n${amber.join('\n')}`);
  const css = execSync('cat src/app/globals.css', { encoding: 'utf8' });
  for (const cls of ['.btn-primary', '.btn-active', '.filter-pill-active']) {
    const rule = css.slice(css.indexOf(`  ${cls} {`), css.indexOf('}', css.indexOf(`  ${cls} {`)));
    assert.match(rule, /bg-(gradient-)?cta\b/, `${cls} must use the button gold`);
    assert.match(rule, /text-white/, `${cls} must keep white text`);
  }
});
