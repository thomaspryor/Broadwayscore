// TESTS-VS-DERIVED-DATA-EXEMPT: names data/awards.json only in import-pattern regexes; reads source files, never data
/**
 * Page-weight guards (BRO-5985). Each one pins a fix that took a large
 * script off every page; a test fails if it comes back.
 *
 * 1. The Supabase SDK (~45kB gz) loads on demand. A static value import of
 *    '@supabase/supabase-js' in browser code puts it back in the bundle every
 *    page ships (it was, via the root layout, from 2026-10-02 to the fix).
 * 2. PostHog replay is sampled before init, so unsampled tabs never fetch the
 *    ~68kB recorder, and surveys (none exist) stay off.
 * 3. No server module imports the next-sanity barrel (its client components
 *    rode along into show pages).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sampledForReplay, RECORDING_SAMPLE_KEY, RECORDING_SAMPLE_RATE } from '../../src/lib/analytics/replay-sample';

const ROOT = join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

// 'use client' must be the first statement, but comments may precede it.
const CLIENT_DIRECTIVE_RE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/;
function isClientModule(src: string): boolean {
  return CLIENT_DIRECTIVE_RE.test(src);
}

// Server-only modules may import the SDK statically: route handlers and the
// server client never reach the browser bundle.
const SERVER_ONLY = [/^src\/app\/api\//, /^src\/lib\/supabase-server\.ts$/];

test('no browser module statically imports the Supabase SDK', () => {
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (SERVER_ONLY.some((re) => re.test(rel))) continue;
    const src = readFileSync(file, 'utf8');
    // `import type` is erased; `import('@supabase/supabase-js')` is lazy.
    if (/^\s*import\s+(?!type\b)[^;]*?from\s+['"]@supabase\/supabase-js['"]/m.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], 'Load it through getSupabaseClient() in src/lib/supabase.ts instead');
});

test('only the Studio imports the next-sanity barrel', () => {
  // The barrel re-exports next-sanity's 'use client' live/visual-editing
  // components; a server module importing it put ~47kB gz of them on every
  // show page. Use '@sanity/client' and 'groq' directly.
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (rel.startsWith('src/app/studio/')) continue;
    const src = readFileSync(file, 'utf8');
    if (/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]next-sanity['"]/m.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('browser components do not import the outlet logo registry', () => {
  // ~115kB of JSON (~28kB gz). Resolve badges on the server with
  // getOutletBadge() and pass them in (ReviewsList, BRO-5985). The Tony
  // press-picks logo predates this and only loads on that page.
  const ALLOWED = new Set(['src/components/tony/OutletPickLogo.tsx']);
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const src = readFileSync(file, 'utf8');
    if (!isClientModule(src)) continue;
    if (/^\s*import\s+(?!type\b)[^;]*?from\s+['"]@\/config\/outlet-logos['"]/m.test(src) && !ALLOWED.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('awards data stays out of the browser bundle', () => {
  // data/awards.json is 1.4MB (~112kB gz); it shipped on every show page
  // through AwardsCard/AwardScoreCard. awards-scoring.ts is shared with client
  // components, so it stays pure; lookups live in data-awards.ts and
  // awards-site-score.ts and run on the server (getAwardsSummary).
  const scoring = readFileSync(join(ROOT, 'src/lib/awards-scoring.ts'), 'utf8');
  assert.doesNotMatch(scoring, /^\s*import\s[^;]*from\s+['"][^'"]*awards\.json['"]/m);
  const offenders: string[] = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split('\\').join('/');
    const src = readFileSync(file, 'utf8');
    if (!isClientModule(src)) continue;
    if (/^\s*import\s+(?!type\b)[^;]*?from\s+['"](@\/lib\/(data-awards|awards-site-score)|[./]+(data\/)?awards\.json)['"]/m.test(src)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('lib/supabase.ts loads the SDK with a dynamic import', () => {
  const src = readFileSync(join(ROOT, 'src/lib/supabase.ts'), 'utf8');
  assert.match(src, /import\(['"]@supabase\/supabase-js['"]\)/);
});

test('AuthProvider skips the SDK for visitors with no saved sign-in', () => {
  const src = readFileSync(join(ROOT, 'src/contexts/AuthContext.tsx'), 'utf8');
  assert.match(src, /hasStoredSupabaseSession\(\)\s*\|\|\s*isAuthCallbackPath\(/);
  assert.match(src, /onSupabaseClientReady\(attach\)/);
});

test('PostHog: surveys off, replay sampled before init', () => {
  const src = readFileSync(join(ROOT, 'src/components/AnalyticsWrapper.tsx'), 'utf8');
  assert.match(src, /disable_surveys:\s*true/);
  assert.match(src, /disable_session_recording:[^\n]*!sampledForReplay\(\)/);
});

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

test('isClientModule sees the directive after leading comments', () => {
  assert.equal(isClientModule("'use client';\nimport x from 'y';"), true);
  assert.equal(isClientModule("/**\n * Card.\n */\n'use client';\n"), true);
  assert.equal(isClientModule("// note\n\"use client\";\n"), true);
  assert.equal(isClientModule("import x from 'y';\n// 'use client' later\n"), false);
});

test('sampledForReplay keeps one decision per tab', () => {
  const s = memStore();
  assert.equal(sampledForReplay(() => 0.05, () => s), true);
  assert.equal(s.m.get(RECORDING_SAMPLE_KEY), '1');
  // A later page in the same tab keeps the decision whatever the dice say.
  assert.equal(sampledForReplay(() => 0.99, () => s), true);

  const t = memStore();
  assert.equal(sampledForReplay(() => 0.5, () => t), false);
  assert.equal(sampledForReplay(() => 0.01, () => t), false);
});

test('sampledForReplay ignores junk and survives blocked storage', () => {
  const s = memStore({ [RECORDING_SAMPLE_KEY]: 'yes' });
  assert.equal(sampledForReplay(() => 0.5, () => s), false);
  assert.equal(s.m.get(RECORDING_SAMPLE_KEY), '0');
  const blocked = () => { throw new Error('SecurityError'); };
  assert.equal(sampledForReplay(() => RECORDING_SAMPLE_RATE - 0.01, blocked), true);
  assert.equal(sampledForReplay(() => RECORDING_SAMPLE_RATE + 0.01, blocked), false);
  assert.equal(sampledForReplay(() => 0.01, () => undefined), true);
});

test('urlHasAuthResult spots an OAuth return on any page', async () => {
  const { urlHasAuthResult } = await import('../../src/lib/supabase');
  const g = globalThis as unknown as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  const at = (hash: string, search = '') => { g.window = { location: { hash, search } }; return urlHasAuthResult(); };
  try {
    assert.equal(at('#access_token=abc&refresh_token=def'), true);
    assert.equal(at('#error=access_denied&error_description=x'), true);
    assert.equal(at('', '?error=server_error&error_code=500'), true);
    assert.equal(at('', '?tab=diary&error_description=x'), true);
    // Implicit flow: a bare ?code= is someone else's (promo links etc.).
    assert.equal(at('', '?code=123'), false);
    assert.equal(at('', '?myerror=1'), false);
    assert.equal(at('#reviews'), false);
    assert.equal(at('', '?promo=code-x'), false);
    assert.equal(at(''), false);
  } finally {
    if (had) g.window = prev; else delete g.window;
  }
});
