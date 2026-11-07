// Finds static internal links in src/ that point at a vercel.json redirect
// source or at a page that does not exist (BRO-5970). Pure functions so the
// unit test can require() the real logic.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// ":slug" -> one segment, ":path*" -> anything (or nothing), ":path+" -> anything.
function sourceToRegex(source) {
  let re = '';
  for (const seg of source.split('/').filter(Boolean)) {
    if (/^:\w+\*$/.test(seg)) re += '(?:/.*)?';
    else if (/^:\w+\+$/.test(seg)) re += '/.+';
    else if (/^:\w+$/.test(seg)) re += '/[^/]+';
    else re += '/' + seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + (re || '/') + '/?$');
}

// Path-only redirects (host-conditional "has" rules are skipped).
function loadRedirectMatchers(vercelJson) {
  return (vercelJson.redirects || [])
    .filter(r => !r.has && r.source.startsWith('/') && !r.destination.startsWith('http'))
    .map(r => ({ source: r.source, destination: r.destination, re: sourceToRegex(r.source) }));
}

// Quoted paths used as link targets: href="/x", href={'/x'}, url: '/x', `${BASE_URL}/x`.
const LINK_PATTERNS = [
  /\b\w*(?:[Hh]ref|[Uu]rl|[Ll]ink|canonical|to)\s*[=:]\s*\{?\s*[`'"](\/[A-Za-z0-9\-_/.]*)(?=[`'"?#$])/g,
  /\b(?:push|replace|redirect)\(\s*[`'"](\/[A-Za-z0-9\-_/.]*)(?=[`'"?#$])/g,
  /\$\{\s*(?:BASE_URL|SITE_URL|baseUrl)\s*\}(\/[A-Za-z0-9\-_/.]*)(?=[`'"?#$])/g,
];

function extractLinks(source) {
  const out = [];
  for (const re of LINK_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const line = source.slice(0, m.index).split('\n').length;
      out.push({ href: m[1].replace(/\/$/, '') || '/', line });
    }
  }
  return out;
}

function findRedirectingLinks(source, matchers) {
  return extractLinks(source).flatMap(l => {
    const hit = matchers.find(m => m.re.test(l.href));
    return hit ? [{ ...l, redirect: hit.source, destination: hit.destination }] : [];
  });
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?|mjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

function scanRepo({ srcDir = path.join(ROOT, 'src'), vercelJson = require(path.join(ROOT, 'vercel.json')) } = {}) {
  const matchers = loadRedirectMatchers(vercelJson);
  const hits = [];
  for (const file of walk(srcDir)) {
    if (/[\\/]dev[\\/]/.test(file)) continue;
    for (const h of findRedirectingLinks(fs.readFileSync(file, 'utf8'), matchers)) {
      hits.push({ file: path.relative(ROOT, file), ...h });
    }
  }
  return hits;
}

module.exports = { sourceToRegex, loadRedirectMatchers, extractLinks, findRedirectingLinks, scanRepo };

if (require.main === module) {
  const hits = scanRepo();
  for (const h of hits) console.log(`${h.file}:${h.line} ${h.href} -> redirect ${h.redirect} -> ${h.destination}`);
  console.log(`${hits.length} internal link(s) point at a redirect`);
  process.exit(hits.length ? 1 : 0);
}
