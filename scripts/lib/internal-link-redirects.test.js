// BRO-5970 regression guard: internal links must not point at redirects or
// at pages that 404.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sourceToRegex, extractLinks, findRedirectingLinks, loadRedirectMatchers, scanRepo } = require('./internal-link-guard');

const ROOT = path.join(__dirname, '..', '..');
let failed = 0;
function test(name, fn) {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n    ', e.message); }
}

test('sourceToRegex handles :slug, :path* and :path+', () => {
  assert(sourceToRegex('/directors/:slug').test('/directors/john-doe'));
  assert(!sourceToRegex('/directors/:slug').test('/directors/a/b'));
  assert(sourceToRegex('/director/:path*').test('/director'));
  assert(sourceToRegex('/director/:path*').test('/director/a/b'));
  assert(!sourceToRegex('/director/:path*').test('/directors'));
});

test('extractLinks + findRedirectingLinks flag a redirecting href', () => {
  const m = loadRedirectMatchers({ redirects: [{ source: '/old', destination: '/new', permanent: true }] });
  const src = `<Link href="/old">x</Link>\n<a href={'/fine'}>y</a>\nurl: \`\${BASE_URL}/old\``;
  assert.strictEqual(extractLinks(src).length, 3);
  assert.strictEqual(findRedirectingLinks(src, m).length, 2);
});

test('no src link points at a vercel.json redirect source', () => {
  const hits = scanRepo();
  assert.strictEqual(hits.length, 0, hits.map(h => `${h.file}:${h.line} ${h.href} -> ${h.destination}`).join('\n'));
});

test('redirects with a permanent flag are 308, not 307 (opera)', () => {
  const r = require(path.join(ROOT, 'vercel.json')).redirects.filter(x => x.destination.startsWith('/opera/'));
  assert(r.length > 0);
  assert.deepStrictEqual(r.filter(x => !x.permanent).map(x => x.source), []);
});

test('static /browse and /guides links resolve to a real config', () => {
  const browse = new Set([...fs.readFileSync(path.join(ROOT, 'src/config/browse-pages.ts'), 'utf8').matchAll(/^\s{2}'?([a-z0-9-]+)'?:\s*\{/gm)].map(m => m[1]));
  const guides = new Set([...fs.readFileSync(path.join(ROOT, 'src/config/guide-pages.ts'), 'utf8').matchAll(/^\s{2}'?([a-z0-9-]+)'?:\s*\{/gm)].map(m => m[1]));
  const bad = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    if (!/\.tsx?$/.test(e.name)) return;
    for (const l of extractLinks(fs.readFileSync(p, 'utf8'))) {
      const m = l.href.match(/^\/(browse|guides)\/([a-z0-9-]+)$/);
      if (!m || m[2].endsWith('-')) continue; // `-` suffix = template-built slug
      const set = m[1] === 'browse' ? browse : guides;
      const staticPage = m[1] === 'guides' && fs.existsSync(path.join(ROOT, 'src/app/guides', m[2]));
      if (set.size && !set.has(m[2]) && !staticPage) bad.push(`${path.relative(ROOT, p)}:${l.line} ${l.href}`);
    }
  });
  walk(path.join(ROOT, 'src'));
  assert.deepStrictEqual(bad, []);
});

process.exit(failed ? 1 : 0);
