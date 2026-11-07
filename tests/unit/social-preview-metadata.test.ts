// Link previews (BRO-5529). Two Next.js metadata rules shape every shared link:
// a page's openGraph replaces the root layout's wholesale, images included,
// and a page's twitter title, description and image are filled from its
// openGraph only when the resolved twitter leaves them out (og:title and
// og:description likewise from the page's own title and description). The
// root layout used to hard-code the homepage's, so pages without their own
// openGraph previewed as the homepage everywhere, and the 33 that set only
// openGraph did on X; 27 pages also listed no images, so iMessage and Slack
// showed them with no image at all.
//
// Run via `npx tsx --test` (tests/unit-test-manifest-tsx.txt); imports the real
// helpers.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SITE_OG_IMAGE, WEST_END_OG_IMAGE, TONY_OG_IMAGE, BASE_URL } from '../../src/lib/seo';
import { fantasySocial, FANTASY_SOCIAL_LINE } from '../../src/config/fantasy-social';
import { FANTASY_OG_IMAGE } from '../../src/config/fantasy-listing';

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'src/app');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** The text of each `key: { ... }` object literal in src, braces matched. */
function objectLiterals(src: string, key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${key}:\\s*\\{`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        out.push(src.slice(m.index, i + 1));
        break;
      }
    }
  }
  return out;
}

test('the root layout sets preview defaults, never the homepage\'s own title, description or url', () => {
  const src = readFileSync(path.join(APP, 'layout.tsx'), 'utf8');
  const twitter = objectLiterals(src, 'twitter');
  const openGraph = objectLiterals(src, 'openGraph');
  assert.strictEqual(twitter.length, 1, 'expected one twitter block in src/app/layout.tsx');
  assert.strictEqual(openGraph.length, 1, 'expected one openGraph block in src/app/layout.tsx');
  assert.doesNotMatch(twitter[0], /\b(title|description|images):/, 'root twitter must leave title, description and images to each page\'s openGraph');
  assert.doesNotMatch(openGraph[0], /\b(title|description|url):/, 'root openGraph must leave title, description and url to each page');
  assert.match(openGraph[0], /images: \[SITE_OG_IMAGE\]/);
});

test('every page or layout that sets openGraph lists its images', () => {
  const missing: string[] = [];
  const files = walk(APP).filter((f) => /\/(page|layout)\.tsx$/.test(f));
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const blocks = objectLiterals(src, 'openGraph');
    if (blocks.length === 0) continue;
    // A segment's opengraph-image file supplies og:image itself.
    const dir = path.dirname(f);
    if (readdirSync(dir).some((n) => n.startsWith('opengraph-image'))) continue;
    // An images value that can be undefined drops og:image and, with it, the
    // twitter image (blog/[slug] with no hero image did).
    if (blocks.some((b) => !/\bimages:/.test(b) || /\bimages:[^\n]*\bundefined\b/.test(b))) missing.push(path.relative(ROOT, f));
  }
  assert.deepStrictEqual(missing, [], `openGraph without images (add images: [SITE_OG_IMAGE]):\n${missing.join('\n')}`);
});

test('no page title restates the brand the root title template appends', () => {
  // A page's own title now also becomes its og:title, so "Blog · Broadway
  // Scorecard" rendered as "Blog · Broadway Scorecard | Broadway Scorecard"
  // in the tab and the preview. openGraph and twitter titles are not
  // templated, so those blocks are cut out before the scan.
  const doubled: string[] = [];
  for (const f of walk(APP).filter((x) => /\/(page|layout)\.tsx$/.test(x) && x !== path.join(APP, 'layout.tsx'))) {
    let src = readFileSync(f, 'utf8');
    for (const key of ['openGraph', 'twitter']) for (const b of objectLiterals(src, key)) src = src.replace(b, '');
    for (const line of src.split('\n')) {
      if (/^\s*title: ['`][^'`]*Broadway Scorecard['`],?\s*$/.test(line)) doubled.push(`${path.relative(ROOT, f)}: ${line.trim()}`);
    }
  }
  assert.deepStrictEqual(doubled, [], `page titles ending in the brand (the template adds it):\n${doubled.join('\n')}`);
});

test('each shared card names a real file and its true size', () => {
  for (const image of [SITE_OG_IMAGE, WEST_END_OG_IMAGE, TONY_OG_IMAGE]) {
    assert.ok(image.url.startsWith(`${BASE_URL}/og/`), image.url);
    const file = path.join(ROOT, 'public', image.url.slice(BASE_URL.length));
    assert.ok(existsSync(file), `${file} is missing`);
    const png = readFileSync(file);
    assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [image.width, image.height], `${file} size`);
    assert.ok(image.alt.length > 0);
  }
});

test('fantasySocial sets the Marquee card on openGraph and twitter', () => {
  const { openGraph, twitter } = fantasySocial('Draft Guide | Broadway Fantasy League', '/fantasy/guide');
  const og = openGraph as Record<string, unknown> & { images: Array<{ url: string }> };
  const tw = twitter as Record<string, unknown> & { images: Array<{ url: string }> };
  assert.strictEqual(og.url, `${BASE_URL}/fantasy/guide`);
  assert.strictEqual(og.siteName, 'Broadway Scorecard');
  assert.strictEqual(og.description, FANTASY_SOCIAL_LINE);
  assert.strictEqual(og.images[0].url, `${BASE_URL}${FANTASY_OG_IMAGE}`);
  assert.strictEqual(tw.card, 'summary_large_image');
  assert.strictEqual(tw.title, 'Draft Guide | Broadway Fantasy League');
  assert.strictEqual(tw.images[0].url, `${BASE_URL}${FANTASY_OG_IMAGE}`);
  assert.ok(existsSync(path.join(ROOT, 'public', FANTASY_OG_IMAGE.split('?')[0])));
});
