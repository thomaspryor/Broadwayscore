#!/usr/bin/env node
// Static guard against the bug class that broke /cast/[slug] (May 2026):
// `next.config.js` adds `data/cast/**` to `outputFileTracingExcludes`, but
// `src/lib/data-actors.ts` still reads `data/cast/` dynamically at runtime via
// `fs.readdirSync(process.cwd() + '/data/cast')`. In production the directory
// is missing, so the actor map is empty and every /cast/[slug] returns 404.
//
// The two settings disagree silently:
//   - NFT-excluded path = "don't bundle these files"
//   - Runtime dynamic read = "I need these files at runtime"
//
// Tests never catch it because local dev has the files on disk and the NFT
// exclude only takes effect in the Vercel build.
//
// This script extracts `outputFileTracingExcludes` from next.config.js, then
// greps src/ for runtime reads (fs.*, require(...) with a dynamic path) that
// touch any of those paths. Any match fails CI.
//
// Exceptions:
//   - Static `import x from '../../data/foo.json'` (webpack inlines content)
//   - Static `require('../../data/foo.json')` literal string
// These are safe because webpack bundles the file contents into the chunk.
//
// Usage: `node scripts/audit-nft-excluded-runtime-reads.js`
// Exit 0 = clean. Exit 1 = violations found.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIRS = ['src', 'app']; // both, in case app/ is at root later

// -- 1. Extract excluded path globs from next.config.js -----------------------
// We parse the file as text (avoids requiring Next plugins to load). The
// excludes block is small enough that a regex extraction is reliable.
function extractExcludedGlobs() {
  const configPath = path.join(ROOT, 'next.config.js');
  const text = fs.readFileSync(configPath, 'utf-8');
  const blockMatch = text.match(/outputFileTracingExcludes\s*:\s*\{([\s\S]*?)\n\s*\}\s*,?/);
  if (!blockMatch) return [];
  const block = blockMatch[1];
  // Match every quoted string inside the block (the glob values)
  const globs = Array.from(block.matchAll(/['"]([^'"]+)['"]/g)).map(m => m[1]);
  // Drop the route-pattern keys like '**/*' — those are wildcards keyed by
  // the route they apply to, not paths we care about excluding.
  return globs.filter(g => g !== '**/*' && g.includes('/'));
}

// -- 2. For each glob, derive a "directory prefix" string we can grep for ----
// 'data/cast/**' → 'data/cast'
// 'data/audit/**' → 'data/audit'
// 'data/broadway.db' → 'data/broadway.db'
function globToPrefix(glob) {
  return glob.replace(/\/\*\*\/?\*?$/, '').replace(/\/\*\/?$/, '');
}

// -- 3. Walk src/ and look for offending patterns ----------------------------
function listSourceFiles() {
  const out = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
  };
  for (const d of SRC_DIRS) walk(path.join(ROOT, d));
  return out;
}

// Patterns that indicate a *dynamic* runtime read (NFT can't trace these):
//   - fs.readdirSync(...)
//   - fs.readFileSync(...)            ← when arg isn't a static import path
//   - fs.existsSync(...)
//   - fs.promises.readFile(...)
//   - require(<template literal>)     ← dynamic
//   - require(someVariable)           ← dynamic
//   - process.cwd()                   ← strongly correlated with dynamic paths
//
// We don't try to be perfect — we conservatively flag any fs.* call whose
// argument string contains an excluded prefix on the same line OR within the
// previous 5 lines (covers const CAST_DIR = ...; fs.readdirSync(CAST_DIR)).
function scanFile(file, prefixes) {
  const text = fs.readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  const hits = [];

  // First pass: find variable assignments that include an excluded prefix.
  // e.g. `const CAST_DIR = path.join(process.cwd(), 'data', 'cast');`
  // → mark CAST_DIR as tainted with prefix 'data/cast'.
  const tainted = new Map(); // varName → prefix
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const assign = line.match(/(?:const|let|var)\s+(\w+)\s*=([^;]*)/);
    if (!assign) continue;
    const [, name, rhs] = assign;
    for (const pref of prefixes) {
      const segs = pref.split('/').filter(Boolean);
      // Match either the literal path or a path.join(..., 'data', 'cast', ...)
      const literalMatch = rhs.includes(`'${pref}`) || rhs.includes(`"${pref}`) || rhs.includes(`/${pref}`);
      const joinMatch = segs.length > 1 && segs.every(s => rhs.includes(`'${s}'`) || rhs.includes(`"${s}"`));
      if (literalMatch || joinMatch) {
        tainted.set(name, pref);
        break;
      }
    }
  }

  // Second pass: look for dynamic fs.* calls referencing tainted vars or
  // literal excluded paths.
  const dynamicCallRe = /\b(fs\.(?:readdir|readFile|exists|stat|access|opendir)(?:Sync)?|fs\.promises\.(?:readdir|readFile|stat|access)|require)\s*\(([^)]+)\)/g;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip the audit script's own example strings + comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    let m;
    while ((m = dynamicCallRe.exec(line)) !== null) {
      const [, call, arg] = m;
      // require('literal/path') → static, webpack handles it. Skip.
      if (call === 'require' && /^\s*['"][^'"`$]+['"]\s*$/.test(arg)) continue;
      // require(`template ${var}`) → dynamic, flag if path includes an excluded prefix
      let matchedPrefix = null;
      for (const pref of prefixes) {
        if (arg.includes(pref)) { matchedPrefix = pref; break; }
      }
      if (!matchedPrefix) {
        // Check tainted variable references
        for (const [varName, pref] of tainted) {
          // require with a tainted var is the dynamic-require failure mode
          if (call === 'require' && arg.includes(varName)) { matchedPrefix = pref; break; }
          // fs.* with a tainted var arg
          if (call.startsWith('fs') && new RegExp(`\\b${varName}\\b`).test(arg)) {
            matchedPrefix = pref; break;
          }
        }
      }
      if (matchedPrefix) {
        hits.push({ file, line: i + 1, code: line.trim(), call, prefix: matchedPrefix });
      }
    }
  }

  return hits;
}

// -- 4. Run --------------------------------------------------------------------
const globs = extractExcludedGlobs();
if (!globs.length) {
  console.log('[audit-nft-excluded-runtime-reads] outputFileTracingExcludes empty — nothing to audit.');
  process.exit(0);
}
const prefixes = Array.from(new Set(globs.map(globToPrefix))).filter(Boolean);

console.log(`[audit-nft-excluded-runtime-reads] auditing src/ against ${prefixes.length} excluded path(s):`);
for (const p of prefixes) console.log(`  - ${p}`);

const files = listSourceFiles();
const allHits = [];
for (const f of files) {
  allHits.push(...scanFile(f, prefixes));
}

if (!allHits.length) {
  console.log(`\n[audit-nft-excluded-runtime-reads] OK — no runtime reads found against ${prefixes.length} NFT-excluded path(s) in ${files.length} source files.`);
  process.exit(0);
}

console.error(`\n[audit-nft-excluded-runtime-reads] FAIL — ${allHits.length} runtime read(s) target paths excluded from the Vercel serverless bundle:\n`);
for (const hit of allHits) {
  const rel = path.relative(ROOT, hit.file);
  console.error(`  ${rel}:${hit.line}`);
  console.error(`    ${hit.code}`);
  console.error(`    → reads from "${hit.prefix}" which is in next.config.js outputFileTracingExcludes\n`);
}
console.error(`Fix one of:`);
console.error(`  a) Remove the path from outputFileTracingExcludes (will re-bundle the directory)`);
console.error(`  b) Replace the dynamic read with a static-required manifest built in prebuild`);
console.error(`     (see scripts/build-cast-manifest.js for the canonical example)\n`);
process.exit(1);
