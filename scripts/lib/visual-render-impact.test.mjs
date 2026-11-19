import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const { isNonRenderingChange, filterFiles } = createRequire(import.meta.url)('./visual-render-impact.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = readFileSync(join(HERE, '../../src/components/AnalyticsWrapper.tsx'), 'utf8');
const F = 'src/components/AnalyticsWrapper.tsx';
// import resolution used by the real gate: only a known .ts/.js module counts as non-rendering.
const resolveTs = (spec) => (spec.startsWith('@/lib/') ? 'ts' : 'unknown');

function swap(src, from, to) {
  assert.ok(src.includes(from), `fixture anchor missing: ${from}`);
  return src.replace(from, to);
}
const check = (next, opts = {}) => isNonRenderingChange({ file: F, oldSource: BASE, newSource: next, resolveImport: resolveTs, ...opts });

// The AnalyticsWrapper.tsx diff of commit 276c5ca65 (branch claude/sentry-37-truncated-chunk), rebuilt on the current file:
// an import of a .ts module, a type widening, and `if (isTruncatedChunkError(event)) return null;` inside useEffect's beforeSend.
function sentry37() {
  let n = swap(BASE, "import { sampledForReplay } from '@/lib/analytics/replay-sample';",
    "import { sampledForReplay } from '@/lib/analytics/replay-sample';\nimport { isTruncatedChunkError } from '@/lib/analytics/truncated-chunk';");
  n = swap(n, 'interface SentryEvent {\n', 'interface SentryEvent {\n  message?: string;\n');
  n = swap(n, 'beforeSend(event: SentryEvent) {', 'beforeSend(event: SentryEvent | null) {');
  n = swap(n, '              const frames =\n', '              if (isTruncatedChunkError(event)) return null;\n              const frames =\n');
  return n;
}

test('sentry-37 AnalyticsWrapper diff is exempt (non-rendering)', () => {
  const r = check(sentry37());
  assert.equal(r.exempt, true, r.reason);
});

test('identical file is exempt-able only when something non-rendering changed; no change at all stays safe', () => {
  assert.equal(check(BASE).exempt, true);
});

test('className change stays gated', () => {
  const n = swap(BASE, '<Script id="gtag-init" strategy="lazyOnload">', '<Script id="gtag-init" className="x" strategy="lazyOnload">');
  assert.equal(check(n).exempt, false);
  assert.equal(check(swap(sentry37(), 'return hasOurCode ? sentryScrub(event) : null;', "return hasOurCode ? sentryScrub(event) : null; // className tweak\n              el.className = 'x';")).exempt, false);
});

test('JSX change stays gated', () => {
  const n = swap(BASE, '<Analytics beforeSend={vercelBeforeSend} />', '<Analytics beforeSend={vercelBeforeSend} debug />');
  assert.equal(check(n).exempt, false);
  assert.equal(check(swap(BASE, '<SpeedInsights beforeSend={vercelBeforeSend} />', '<SpeedInsights beforeSend={vercelBeforeSend} sampleRate={1} />')).exempt, false);
});

test('setState inside an effect stays gated', () => {
  const n = swap(BASE, "localStorage.setItem('bwsc-owner', 'true');", "localStorage.setItem('bwsc-owner', 'true');\n        setOwner(true);");
  assert.equal(check(n).exempt, false);
});

test('import of a .tsx module stays gated (and so does an unresolvable one)', () => {
  const n = swap(BASE, "import { useEffect } from 'react';", "import { useEffect } from 'react';\nimport { Banner } from '@/components/Banner';");
  assert.equal(check(n, { resolveImport: () => 'tsx' }).exempt, false);
  assert.equal(check(n, { resolveImport: () => 'unknown' }).exempt, false);
  assert.equal(check(n, { resolveImport: () => 'css' }).exempt, false);
  const css = swap(BASE, "import Script from 'next/script';", "import Script from 'next/script';\nimport './x.css';");
  assert.equal(check(css, { resolveImport: () => 'ts' }).exempt, false);
});

test('return null in render stays gated', () => {
  const n = swap(BASE, '  const pathname = usePathname();\n', '  const pathname = usePathname();\n  if (!pathname) return null;\n');
  assert.equal(check(n).exempt, false);
});

test('state hook / non-effect logic change stays gated', () => {
  const n = swap(BASE, "const POSTHOG_KEY = 'phc_xVenlxA1HzyJz0Yjlj3UkF9JVLCPe86Td6vQEK41SF7';", "const POSTHOG_KEY = 'phc_other';");
  assert.equal(check(n).exempt, false);
});

test('effect dependency array change stays gated (second argument is not the effect body)', () => {
  const n = swap(BASE, '  }, [pathname]);', '  }, [pathname, GA_MEASUREMENT_ID]);');
  assert.equal(check(n).exempt, false);
});

test('DOM mutation inside an effect stays gated', () => {
  for (const line of ["document.body.dataset.x = '1';", 'el.style.color = "red";', 'el.classList.add("a");', 'el.innerHTML = "x";', 'document.head.appendChild(n);']) {
    const n = swap(BASE, "localStorage.setItem('bwsc-owner', 'true');", `localStorage.setItem('bwsc-owner', 'true');\n        ${line}`);
    assert.equal(check(n).exempt, false, line);
  }
});

test("'use client' change stays gated", () => {
  assert.equal(check(swap(BASE, "'use client';", '// removed')).exempt, false);
});

test('type-only changes are exempt; a type-only import too; runtime import of a type-only name is not hidden', () => {
  const n = swap(BASE, 'interface SentryEvent {\n', 'interface SentryEvent {\n  extra?: number;\n');
  assert.equal(check(n).exempt, true);
  const t = swap(BASE, "import { useEffect } from 'react';", "import { useEffect } from 'react';\nimport type { Foo } from '@/components/Foo';");
  assert.equal(check(t).exempt, true);
});

test('parse error in either side fails closed', () => {
  assert.equal(check(swap(BASE, 'export default function AnalyticsWrapper() {', 'export default function AnalyticsWrapper( {')).exempt, false);
  assert.equal(isNonRenderingChange({ file: F, oldSource: 'const = ;', newSource: BASE, resolveImport: resolveTs }).exempt, false);
});

test('css / scss / non-tsx files are never exempt; missing old or new side is never exempt', () => {
  assert.equal(isNonRenderingChange({ file: 'src/app/globals.css', oldSource: 'a{}', newSource: 'a{}\n', resolveImport: resolveTs }).exempt, false);
  assert.equal(isNonRenderingChange({ file: 'tailwind.config.ts', oldSource: 'export {}', newSource: 'export {};', resolveImport: resolveTs }).exempt, false);
  assert.equal(isNonRenderingChange({ file: F, oldSource: null, newSource: BASE, resolveImport: resolveTs }).exempt, false);
  assert.equal(isNonRenderingChange({ file: F, oldSource: BASE, newSource: null, resolveImport: resolveTs }).exempt, false);
});

test('filterFiles drops only exempt files and logs each exemption; helper errors keep the file', () => {
  const logged = [];
  const files = [F, 'src/app/page.tsx', 'src/app/globals.css'];
  const read = (side, f) => (f === F ? (side === 'old' ? BASE : sentry37()) : f === 'src/app/page.tsx' ? (side === 'old' ? 'export default function P(){return <p>a</p>}' : 'export default function P(){return <p className="b">a</p>}') : 'a{}');
  const kept = filterFiles(files, read, resolveTs, (m) => logged.push(m));
  assert.deepEqual(kept, ['src/app/page.tsx', 'src/app/globals.css']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /AnalyticsWrapper/);
  const boom = filterFiles([F], () => { throw new Error('git failed'); }, resolveTs, () => {});
  assert.deepEqual(boom, [F]);
});

test('RENDER_IMPACT_DISABLED=1 kill switch keeps every file gated', () => {
  const read = (side) => (side === 'old' ? BASE : sentry37());
  const prev = process.env.RENDER_IMPACT_DISABLED;
  try {
    process.env.RENDER_IMPACT_DISABLED = '1';
    assert.deepEqual(filterFiles([F], read, resolveTs, () => {}), [F]);
    delete process.env.RENDER_IMPACT_DISABLED;
    assert.deepEqual(filterFiles([F], read, resolveTs, () => {}), []);
  } finally {
    if (prev === undefined) delete process.env.RENDER_IMPACT_DISABLED; else process.env.RENDER_IMPACT_DISABLED = prev;
  }
});

test('CLI --filter on a real git range exempts the sentry-37 diff and keeps a className diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vri-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const w = (p, s) => { const full = join(dir, p); execFileSync('mkdir', ['-p', dirname(full)]); writeFileSync(full, s); };
  w(F, BASE); w('src/lib/analytics/truncated-chunk.ts', 'export const isTruncatedChunkError = (e: unknown) => !!e;\n'); w('src/app/page.tsx', 'export default function P(){return <p>a</p>}\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('branch', 'base0');
  git('checkout', '-q', '-b', 'feature');
  w(F, sentry37()); w('src/app/page.tsx', 'export default function P(){return <p className="b">a</p>}\n');
  git('add', '-A'); git('commit', '-qm', 'change');
  const log = join(dir, 'bypass.log');
  const out = execFileSync('node', [join(HERE, 'visual-render-impact.js'), '--filter', 'base0...feature'], {
    cwd: dir, encoding: 'utf8', input: `${F}\nsrc/app/page.tsx\n`, env: { ...process.env, CLAUDE_LOG_DIR: dir, VISUAL_RENDER_IMPACT_LOG: log },
  });
  assert.equal(out.trim(), 'src/app/page.tsx');
  assert.ok(existsSync(log));
  assert.match(readFileSync(log, 'utf8'), /render-impact-exempt\t.*AnalyticsWrapper/);
});

// --- second-opinion findings (BRO-7849): each of these was exempt in the first draft ---
const inEffect = (line) => swap(BASE, "localStorage.setItem('bwsc-owner', 'true');", `localStorage.setItem('bwsc-owner', 'true');\n        ${line}`);

test('effect-body bypasses stay gated: aliased setter, split call, scroll/focus/hidden, computed document, helper calls', () => {
  for (const line of ['const s = setOwner; s(true);', 'setOwner\n        (true);', 'window.scrollTo(0, 0);', 'ref.current.focus();', 'el.hidden = true;', 'globalThis["document"].body.dataset.theme = "x";', 'applyTheme();', 'router.push("/x");']) {
    assert.equal(check(inEffect(line)).exempt, false, line);
  }
});

test('changing an existing import (module swap, alias swap, removal) stays gated', () => {
  assert.equal(check(swap(BASE, "import Script from 'next/script';", "import Script from 'next/legacy/script';")).exempt, false);
  assert.equal(check(swap(BASE, "import { useEffect } from 'react';", '')).exempt, false);
  const aliased = swap(BASE, "import { useEffect } from 'react';", "import { useEffect } from 'react';\nimport { MustSeeCrown as Analytics } from '@/lib/b';");
  assert.equal(check(aliased).exempt, false);
});

test('a newly imported name used outside an effect guard stays gated', () => {
  const n = swap(BASE, "import { useEffect } from 'react';", "import { useEffect } from 'react';\nimport { fmt } from '@/lib/b';");
  assert.equal(check(swap(n, 'const pathname = usePathname();', 'const pathname = usePathname();\n  const label = fmt(pathname);')).exempt, false);
});

test('useInsertionEffect bodies are never exempt (they inject styles)', () => {
  const old = "import { useInsertionEffect } from 'react';\nexport default function A() {\n  useInsertionEffect(() => {\n    if (a) return null;\n  }, []);\n  return <p>x</p>;\n}\n";
  const next = old.replace('if (a) return null;', 'if (b) return null;');
  assert.equal(isNonRenderingChange({ file: F, oldSource: old, newSource: next, resolveImport: resolveTs }).exempt, false);
  // a guard directly in an effect body is also gated now: an early return can skip later setState / DOM writes
  const eff = old.replaceAll('useInsertionEffect', 'useEffect');
  assert.equal(isNonRenderingChange({ file: F, oldSource: eff, newSource: eff.replace('if (a) return null;', 'if (b) return null;'), resolveImport: resolveTs }).exempt, false);
});

test('a template-literal line that starts with // is not skipped as a comment', () => {
  const old = 'import { useEffect } from "react";\nexport default function A() {\n  useEffect(() => {\n    const u = `\n//cdn.a.com/x`;\n    void u;\n  }, []);\n  return <p>x</p>;\n}\n';
  assert.equal(isNonRenderingChange({ file: F, oldSource: old, newSource: old.replace('//cdn.a.com/x', '//cdn.b.com/x'), resolveImport: resolveTs }).exempt, false);
});

test('regex/string list edits inside an effect (ignoreErrors style) are exempt', () => {
  assert.equal(check(swap(BASE, '/Script error\\.?$/i,', '/Script error\\.?$/i,\n              /ChunkLoadError/,')).exempt, true);
});

// BRO-7849 ship-check: rendering changes the first detector wrongly exempted. Each must stay gated.
const eff = (body, extra = '') => `import { useEffect, useState } from 'react';\nimport { isBot, applyTheme } from '@/lib/x';\n${extra}export default function A() {\n  const [d, setD] = useState(0);\n  useEffect(() => {\n${body}  }, []);\n  return <p>{d}</p>;\n}\n`;
const gated = (a, b, msg) => assert.equal(isNonRenderingChange({ file: F, oldSource: a, newSource: b, resolveImport: resolveTs }).exempt, false, msg);
test('early return in an effect that skips a later setState stays gated', () => {
  gated(eff('    setD(1);\n'), eff('    if (!d) return;\n    setD(1);\n'));
  gated(eff('    document.title = "x";\n'), eff('    if (!d) return;\n    document.title = "x";\n'));
});
test('guard inside a nested event handler stays gated', () => {
  const o = eff('    const cb = (e) => {\n      setD(2);\n    };\n    window.addEventListener("x", cb);\n');
  gated(o, o.replace('      setD(2);', '      if (e.detail) return;\n      setD(2);'));
});
test('new element in a multi-line array that is an argument to a setter or classList stays gated', () => {
  const o = eff('    setD([\n      "a",\n    ]);\n');
  gated(o, o.replace('"a",', '"a",\n      "hidden-banner",'));
  const c = eff('    document.body.classList.add(...[\n      "a",\n    ]);\n');
  gated(c, c.replace('"a",', '"a",\n      "dark",'));
});
test('guard conditions with side effects stay gated', () => {
  gated(eff('    setD(1);\n'), eff('    if (applyTheme("dark")) return;\n    setD(1);\n'));
  const hook = (cond) => `import { isBot, hide } from '@/lib/x';\nexport default function A() {\n  Sentry.init({ beforeSend(e) {\n${cond}    return e;\n  } });\n  return <p>x</p>;\n}\n`;
  gated(hook(''), hook('    if (els.some(hide)) return null;\n'));
  gated(hook(''), hook('    if (hide(e)) return null;\n'));
});
test('a guard in an inert beforeSend is exempt, but not when the hook also writes to the DOM or an outer variable', () => {
  const hook = (body) => `import { isBot } from '@/lib/x';\nlet seen = 0;\nexport default function A() {\n  Sentry.init({ beforeSend(e) {\n${body}    return e;\n  } });\n  return <p>x</p>;\n}\n`;
  const ok = isNonRenderingChange({ file: F, oldSource: hook(''), newSource: hook('    if (isBot(e)) return null;\n'), resolveImport: resolveTs });
  assert.equal(ok.exempt, true, ok.reason);
  gated(hook('    seen++;\n'), hook('    seen++;\n    if (isBot(e)) return null;\n'));
  gated(hook('    seen = 1;\n'), hook('    seen = 1;\n    if (isBot(e)) return null;\n'));
});
test('new bare-package import and unused new import stay gated', () => {
  const o = eff('    setD(1);\n');
  gated(o, o.replace("import { isBot, applyTheme } from '@/lib/x';", "import { isBot, applyTheme } from '@/lib/x';\nimport { toast } from 'sonner';"));
  gated(o, o.replace("import { isBot, applyTheme } from '@/lib/x';", "import { isBot, applyTheme } from '@/lib/x';\nimport { unusedThing } from '@/lib/x';"));
});
test('whitespace-only change inside a string literal stays gated', () => {
  const o = eff('    const s = "a  b";\n    void s;\n');
  gated(o, o.replace('"a  b"', '"a b"'));
});

// Second ship-check round: bypasses found by probing the hardened detector.
const hk = (body, pre = '', imp = "import { isBot, showBanner } from '@/lib/x';\n") => `${imp}${pre}export default function A() {\n  Sentry.init({ beforeSend(e) {\n${body}    return e;\n  } });\n  return <p>x</p>;\n}\n`;
const ex = (a, b) => isNonRenderingChange({ file: F, oldSource: a, newSource: b, resolveImport: resolveTs });
test('live code after a // line start inside a block comment stays gated', () => {
  const o = eff('    setD(1);\n');
  assert.equal(ex(o, o.replace('    setD(1);', '    /*\n// note */ label = label + label; /*\n*/\n    setD(1);')).exempt, false);
  assert.equal(ex(o, o.replace('    setD(1);', '    // just a comment\n    setD(1);')).exempt, true);
});
test('pattern list / filter hook outside an init() options object stays gated', () => {
  const lst = (items) => `export default function A() {\n  const cfg = { denyUrls: [\n    'a',\n${items}  ] };\n  return <ul>{cfg.denyUrls.map((u) => <li key={u}>{u}</li>)}</ul>;\n}\n`;
  assert.equal(ex(lst(''), lst("    'Sold out tonight',\n")).exempt, false);
  const fmt = (g) => `export default function A({ name }: { name: string }) {\n  const fmt = { beforeSend: (s: string) => {\n${g}    return s;\n  } };\n  return <p>{fmt.beforeSend(name)}</p>;\n}\n`;
  assert.equal(ex(fmt(''), fmt('    if (s) return null;\n')).exempt, false);
});
test('hook calling a non-predicate imported helper stays gated (an early return could skip it)', () => {
  assert.equal(ex(hk('    showBanner(e);\n'), hk('    if (e.level) return null;\n    showBanner(e);\n')).exempt, false);
});
test('shadowed import name, methods on foreign objects and getters stay gated', () => {
  const sh = (g) => `import { isBot } from '@/lib/bot';\nexport default function A() {\n  const isBot2 = 1; void isBot2;\n  function setup() {\n    const isBot = () => { (window as any).__open = true; return false; };\n    Sentry.init({ beforeSend(e) {\n${g}      return e;\n    } });\n  }\n  return <p onClick={setup}>x</p>;\n}\n`;
  assert.equal(ex(sh(''), sh('      if (isBot()) return null;\n')).exempt, false);
  const ui = (g) => `const ui = { has(_: unknown) { return false; }, get hide() { return false; } };\nexport default function A() {\n  Sentry.init({ beforeSend(e) {\n${g}    return e;\n  } });\n  return <p>{String(ui)}</p>;\n}\n`;
  assert.equal(ex(ui(''), ui('    if (ui.has(e)) return null;\n')).exempt, false);
  assert.equal(ex(ui(''), ui('    if (ui.hide) return null;\n')).exempt, false);
});
test('an added project import is exempt only when the module is declaration-only', () => {
  const { filterRange } = createRequire(import.meta.url)('./visual-render-impact.js');
  const dir = mkdtempSync(join(tmpdir(), 'vri2-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const w = (pth, src) => { const full = join(dir, pth); execFileSync('mkdir', ['-p', dirname(full)]); writeFileSync(full, src); };
  const comp = (imp, g) => `${imp}export default function A() {\n  Sentry.init({ beforeSend(e) {\n${g}    return e;\n  } });\n  return <p>x</p>;\n}\n`;
  w('src/c.tsx', comp('', ''));
  git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base0');
  w('src/c.tsx', comp("import { isBot } from '@/lib/pure';\n", '    if (isBot(e)) return null;\n'));
  w('src/lib/pure.ts', 'export function isBot(e: unknown) { return !!e; }\n');
  git('add', '-A'); git('commit', '-qm', 'pure');
  assert.deepEqual(filterRange('base0...HEAD', ['src/c.tsx'], dir), []);
  w('src/lib/pure.ts', "document.documentElement.dataset.theme = 'x';\nexport function isBot(e: unknown) { return !!e; }\n");
  git('add', '-A'); git('commit', '-qm', 'impure');
  assert.deepEqual(filterRange('base0...HEAD', ['src/c.tsx'], dir), ['src/c.tsx']);
  w('src/lib/pure.ts', 'export function isBot(e: unknown) { document.title = "x"; return !!e; }\n');
  git('add', '-A'); git('commit', '-qm', 'impure2');
  assert.deepEqual(filterRange('base0...HEAD', ['src/c.tsx'], dir), ['src/c.tsx']);
});

// Third round.
test('a local function named init, or one whose result is used, is not a telemetry host', () => {
  const loc = (g) => `const init = (o: any) => o.beforeSend({ a: 1 });\nexport default function P() {\n  const v = init({\n    beforeSend(e: any) {\n${g}      return e;\n    },\n  });\n  return <div>{v ? 'Tickets on sale' : 'SOLD OUT'}</div>;\n}\n`;
  assert.equal(ex(loc('      if (e.a === 2) return null;\n'), loc('      if (e.a === 1) return null;\n')).exempt, false);
  const mem = (g) => `const Cfg: any = { init: (o: any) => o.beforeSend({ a: 1 }) };\nexport default function P() {\n  const v = Cfg.init({\n    beforeSend(e: any) {\n${g}      return e;\n    },\n  });\n  return <div>{v ? 'on' : 'off'}</div>;\n}\n`;
  assert.equal(ex(mem(''), mem('      if (e.a === 1) return null;\n')).exempt, false);
  const stmt = (g) => `const Cfg: any = { init: (o: any) => o.beforeSend({ a: 1 }) };\nexport default function P() {\n  Cfg.init({\n    beforeSend(e: any) {\n${g}      return e;\n    },\n  });\n  return <div>x</div>;\n}\n`;
  assert.equal(ex(stmt(''), stmt('      if (e.a === 1) return null;\n')).exempt, false);
});
test('declaration-only check rejects load-time code in unary operands, object methods, Function()', () => {
  const ts = createRequire(import.meta.url)('typescript');
  const { filterRange } = createRequire(import.meta.url)('./visual-render-impact.js');
  const dir = mkdtempSync(join(tmpdir(), 'vri3-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  const w = (pth, src) => { const full = join(dir, pth); execFileSync('mkdir', ['-p', dirname(full)]); writeFileSync(full, src); };
  const comp = (imp, g) => `${imp}export default function A() {\n  Sentry.init({ beforeSend(e) {\n${g}    return e;\n  } });\n  return <p>x</p>;\n}\n`;
  w('src/c.tsx', comp('', '')); git('add', '-A'); git('commit', '-qm', 'base'); git('branch', 'base0');
  w('src/c.tsx', comp("import { isA } from '@/lib/e';\n", '    if (isA(e)) return null;\n'));
  for (const body of [
    "export const isA = (e: any) => !!e;\nexport const z = -{ valueOf: () => 1 };\n",
    "export const isA = (e: any) => !!e;\nexport const z = { m() { return 1; } };\n",
    "export const isA = (e: any) => !!e;\nexport const z = { f: () => 1 };\n",
    "export const isA = (e: any) => Function('return 1')();\n",
  ]) {
    w('src/lib/e.ts', body); git('add', '-A'); git('commit', '-qm', 'x', '--allow-empty');
    assert.deepEqual(filterRange('base0...HEAD', ['src/c.tsx'], dir), ['src/c.tsx'], body);
  }
  w('src/lib/e.ts', 'export const isA = (e: any) => !!e;\nexport const PATTERNS = [/a/, "b", -1];\n'); git('add', '-A'); git('commit', '-qm', 'ok');
  assert.deepEqual(filterRange('base0...HEAD', ['src/c.tsx'], dir), []);
  assert.ok(ts);
});
