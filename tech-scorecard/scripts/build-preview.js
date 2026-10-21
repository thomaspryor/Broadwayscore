#!/usr/bin/env node
// Turns the static export in out/ into ONE self-contained HTML file
// (preview/index.html) with hash navigation, for sharing a preview link
// where the full site is not hosted yet. Run after `next build`.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const read = (p) => fs.readFileSync(path.join(OUT, p), 'utf8');

const cssDir = path.join(OUT, '_next/static/css');
const css = fs.readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(cssDir, f), 'utf8')).join('\n');

const views = [{ id: 'home', file: 'index.html' }, { id: 'methodology', file: 'methodology/index.html' }];
for (const slug of fs.readdirSync(path.join(OUT, 'product'))) views.push({ id: slug, file: `product/${slug}/index.html` });

const between = (html, open, close) => {
  const a = html.indexOf(open);
  const b = html.lastIndexOf(close);
  if (a < 0 || b < 0) throw new Error(`markers ${open} ${close} not found`);
  return html.slice(a + open.length, b);
};
const stripScripts = (html) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*rel="(?:preload|modulepreload)"[^>]*>/g, '');
const rewriteLinks = (html) => html
  .replace(/href="\/"/g, 'href="#home"')
  .replace(/href="\/methodology\/"/g, 'href="#methodology"')
  .replace(/href="\/product\/([a-z0-9-]+)\/"/g, 'href="#$1"');

const home = read('index.html');
const header = rewriteLinks(stripScripts(home.match(/<header[\s\S]*?<\/header>/)[0]));
const footer = rewriteLinks(stripScripts(home.match(/<footer[\s\S]*?<\/footer>/)[0]));
const titles = {};
const sections = views.map(({ id, file }) => {
  const html = read(file);
  titles[id] = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || 'Tech Scorecard';
  const main = rewriteLinks(stripScripts(between(html, '<main>', '</main>')));
  return `<section data-view="${id}"${id === 'home' ? '' : ' hidden'}>${main}</section>`;
});

const page = `<title>Tech Scorecard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>:root{color-scheme:light}
${css}
body{background:#fff;color:#14141a}</style>
<div class="min-h-screen font-sans">
${header}
<main>
${sections.join('\n')}
</main>
${footer}
</div>
<script>
(function () {
  var titles = ${JSON.stringify(titles)};
  function show() {
    var id = (location.hash || '#home').slice(1);
    var views = document.querySelectorAll('[data-view]');
    var found = false;
    views.forEach(function (v) { var on = v.getAttribute('data-view') === id; v.hidden = !on; if (on) found = true; });
    if (!found) document.querySelector('[data-view="home"]').hidden = false;
    document.title = titles[id] || titles.home;
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', show);
  show();
})();
</script>
`;
fs.mkdirSync(path.join(ROOT, 'preview'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'preview/index.html'), page);
console.log(`preview/index.html: ${views.length} views, ${(page.length / 1024).toFixed(0)} KB`);
