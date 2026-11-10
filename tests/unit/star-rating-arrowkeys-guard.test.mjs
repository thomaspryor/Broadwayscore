// BRO-7074 class guard: a <StarRating> whose pick commits at once (navigates, opens the
// editor) must pass arrowKeys={false}, or one stray arrow press on a focused star fires a
// 0.5-star pick. Callers that only set local state may keep arrow keys (keyboard half-stars).
// A NEW interactive <StarRating> fails here until it is classified one way or the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
// Pure state setters: the pick changes a draft value, nothing leaves the page.
// Value = how many interactive tags the file may have, so a second (commit-on-pick)
// star added to an exempt file still fails.
const STATE_ONLY = new Map([
  ['src/components/user/RatingEditor.tsx', 1],
  ['src/components/onboarding/WelcomeSheet.tsx', 1],
  ['src/app/test/ugc-fixture/page.tsx', 1],
]);

// Bare `readOnly` / readOnly={true} only; readOnly={false} or {someVar} is interactive.
const isReadOnly = (tag) => /\breadOnly(?!\s*=)/.test(tag) || /\breadOnly\s*=\s*\{\s*true\s*\}/.test(tag);
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function starRatingTags(src) {
  const tags = [];
  const re = /<StarRating\b/g;
  let m;
  while ((m = re.exec(src))) {
    // Walk to the closing "/>" at brace depth 0 (props can contain arrow functions and JSX).
    let depth = 0, i = m.index;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break; // ends `/>` and `>...</StarRating>` alike
    }
    tags.push(src.slice(m.index, i + 1));
  }
  return tags;
}

test('commit-on-pick StarRating call sites disable arrow keys', () => {
  const offenders = [];
  let interactive = 0;
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file);
    if (rel.endsWith('/StarRating.tsx')) continue;
    let inFile = 0;
    for (const tag of starRatingTags(stripComments(readFileSync(file, 'utf8')))) {
      if (isReadOnly(tag)) continue;
      interactive++;
      inFile++;
      if (STATE_ONLY.has(rel)) {
        if (inFile > STATE_ONLY.get(rel)) offenders.push(`${rel} (extra interactive tag in a state-only file)`);
        continue;
      }
      if (!/arrowKeys=\{false\}/.test(tag)) offenders.push(rel);
    }
  }
  assert.ok(interactive >= 5, `scanner found only ${interactive} interactive StarRating tags`);
  assert.deepEqual(offenders, [], `add arrowKeys={false} (or list the file as state-only): ${offenders.join(', ')}`);
});

test('scanner sees the three commit-on-pick sites', () => {
  for (const f of ['src/components/user/HoverRateStars.tsx', 'src/app/my-shows/MyShowsClient.tsx', 'src/components/show-page/ShowHeroRedesign.tsx']) {
    const tags = starRatingTags(stripComments(readFileSync(join(ROOT, f), 'utf8'))).filter(t => !isReadOnly(t));
    assert.ok(tags.length >= 1 && tags.every(t => /arrowKeys=\{false\}/.test(t)), f);
  }
});

test('scanner self-check: readOnly={false}, closing-tag form and comments', () => {
  const src = stripComments('<StarRating readOnly={false} onRatingChange={(r) => go(r)} /> // <StarRating readOnly />\n<StarRating rating={1} onRatingChange={(r) => go(r)}></StarRating><StarRating readOnly rating={2} />');
  const tags = starRatingTags(src);
  assert.equal(tags.length, 3);
  assert.deepEqual(tags.map(isReadOnly), [false, false, true]);
  assert.ok(tags.every(t => !/arrowKeys/.test(t)));
});
