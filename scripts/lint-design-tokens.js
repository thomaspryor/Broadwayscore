#!/usr/bin/env node
/**
 * Design-token drift guard.
 *
 * Enforces memory/design-system.md:
 *   - Borders must use design tokens (border-white/N, border-border), never Tailwind gray/slate/zinc.
 *   - Dark surfaces must use bg-surface / bg-surface-raised / bg-surface-overlay / bg-surface-elevated,
 *     never bg-zinc-*, bg-slate-*, bg-gray-700/800/900/950.
 *   - Text neutrals use text-gray-*, never text-zinc-* or text-slate-*.
 *
 * Two previous cleanup sessions (2026-04-12: 129 zinc refs, 2026-04-13: 44 gray/slate refs) burned
 * time because nothing enforced this. Without a gate, drift reappears in ~2 weeks.
 *
 * Exemption: add `// design-lint-ok: <reason>` on the same line for legit one-offs.
 */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');

const RULES = [
  {
    id: 'border-neutral',
    pattern: /\bborder-(gray|slate|zinc)-\d{2,3}\b/g,
    fix: 'Use border-white/5, border-white/10, or a design token (see memory/design-system.md).',
  },
  {
    id: 'bg-slate-zinc',
    pattern: /\bbg-(slate|zinc)-\d{2,3}(?:\/\d+)?\b/g,
    fix: 'Use bg-surface / bg-surface-raised / bg-surface-overlay / bg-surface-elevated, or a neutral gray-500/N alpha variant.',
  },
  {
    id: 'bg-gray-dark',
    pattern: /\bbg-gray-(700|800|900|950)(?:\/\d+)?\b/g,
    fix: 'Dark surfaces must use bg-surface / bg-surface-raised / bg-surface-overlay / bg-surface-elevated.',
  },
  {
    id: 'text-slate-zinc',
    pattern: /\btext-(slate|zinc)-\d{2,3}\b/g,
    fix: 'Use text-gray-* (typography neutrals are not migrated yet) or a semantic token.',
  },
];

const EXEMPT_RE = /\/\/\s*design-lint-ok\b/;
const EXT_RE = /\.(ts|tsx|js|jsx|css|mdx)$/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry.name)) out.push(full);
  }
  return out;
}

function lintFile(file) {
  const violations = [];
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (EXEMPT_RE.test(line)) continue;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let m;
      while ((m = rule.pattern.exec(line)) !== null) {
        violations.push({ file, lineNo: i + 1, match: m[0], rule });
      }
    }
  }
  return violations;
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`Source directory not found: ${SRC_DIR}`);
    process.exit(2);
  }
  const files = walk(SRC_DIR);
  const all = [];
  for (const f of files) all.push(...lintFile(f));

  if (all.length === 0) {
    console.log(`Design-token lint clean — scanned ${files.length} files under src/.`);
    return;
  }

  const byRule = new Map();
  for (const v of all) {
    if (!byRule.has(v.rule.id)) byRule.set(v.rule.id, []);
    byRule.get(v.rule.id).push(v);
  }

  console.error(`Design-token drift detected — ${all.length} violation(s) across ${files.length} files.\n`);
  for (const [id, vs] of byRule) {
    const rule = RULES.find((r) => r.id === id);
    console.error(`[${id}] ${rule.fix}`);
    for (const v of vs) {
      const rel = path.relative(process.cwd(), v.file);
      console.error(`  ${rel}:${v.lineNo}  ${v.match}`);
    }
    console.error('');
  }
  console.error('Fix violations or add `// design-lint-ok: <reason>` to the offending line.');
  console.error('See memory/design-system.md for the canonical token list.');
  process.exit(1);
}

main();
