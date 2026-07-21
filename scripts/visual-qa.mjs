#!/usr/bin/env node
// scripts/visual-qa.mjs — local multi-width screenshot sweep + optional two-model LLM review
//
// Forcing function for visual QA. Run before pushing UI changes so the agent
// (and the user) can SEE the change at multiple breakpoints + at full pixel
// resolution. The companion hook (.claude/hooks/pre-push-visual-gate.sh)
// requires `.claude/visual-qa/<branch>/verdict.json` newer than the latest
// UI edit OR an explicit `APPROVED: <contentHash>` from the user before any
// push touching src/**/*.{tsx,jsx,css,scss} can proceed.
//
// CLI:
//   --url <required>            localhost URL of the running dev server
//   --paths <comma-sep>         routes to capture (default "/")
//   --elements <css-selectors>  comma-separated selectors to crop at full size per viewport
//   --refs <paths|"none">       comma-separated reference images for LLM review (or omit)
//   --branch <name>             defaults to current git branch
//   --out <dir>                 defaults to .claude/visual-qa/<branch>/
//
// Exit codes: 0 success/PASS, 1 bad args, 2 dev-server unreachable / LLM FAIL
//
// See sprint-plan-visual-qa-gate.md and .claude/skills/visual-qa/skill.md.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { computeContentHash, generateRunId, VERDICT_SCHEMA_VERSION } from './lib/verdict-hash.mjs';

// Load .env into process.env without external dotenv dependency.
// Only sets keys not already in env (so explicit env overrides .env).
function loadDotenv(path = '.env') {
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch { /* ignore */ }
}
loadDotenv();

const WIDTHS = [360, 414, 768, 1024, 1440];

function parseArgs(argv) {
  const args = {
    url: null,
    paths: ['/'],
    elements: [],
    refs: null,
    refRoles: null, // null → all default to 'goal'; otherwise aligned with refs[]
    branch: null,
    out: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (eq >= 0) {
      key = a.slice(0, eq).replace(/^--/, '');
      val = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      key = a.slice(2);
      val = argv[++i];
    } else {
      continue;
    }
    if (key === 'url') args.url = val;
    else if (key === 'paths') args.paths = val.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'elements') args.elements = val.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'refs') args.refs = val === 'none' ? null : val.split(',').map(s => s.trim()).filter(Boolean);
    else if (key === 'ref-roles' || key === 'ref-role') {
      // Comma-separated per-ref roles aligned with --refs. Accepts 'goal' or 'before'.
      //   --refs a.png,b.png --ref-roles goal,before
      // Or a single value applies to all refs.
      args.refRoles = val.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    }
    else if (key === 'branch') args.branch = val;
    else if (key === 'out') args.out = val;
  }
  return args;
}

function normalizeRefRoles(refs, requestedRoles) {
  if (!refs || refs.length === 0) return [];
  if (!requestedRoles || requestedRoles.length === 0) {
    return refs.map(() => 'goal');
  }
  // Validate values.
  const valid = new Set(['goal', 'before']);
  const bad = requestedRoles.find(r => !valid.has(r));
  if (bad) {
    throw new Error(`--ref-roles: unknown role "${bad}". Allowed: goal, before`);
  }
  if (requestedRoles.length === 1) {
    return refs.map(() => requestedRoles[0]);
  }
  if (requestedRoles.length !== refs.length) {
    throw new Error(`--ref-roles count (${requestedRoles.length}) must equal --refs count (${refs.length}), or be exactly 1.`);
  }
  return requestedRoles;
}

function printHelp() {
  console.log(`Usage: node scripts/visual-qa.mjs --url=<localhost-url> [options]

Required:
  --url <url>               localhost URL of the dev server (https://, file://, prod
                            URLs are rejected — gate is "local preview before push")

Options:
  --paths <a,b,c>           comma-separated routes; default "/"
  --elements <sel,sel>      CSS selectors to crop at full pixel resolution per viewport.
                            Use this for anything the agent needs to legibility-check
                            (a thumbnail-Read of a 5-width full-page screenshot is the
                            silent-PASS root cause).
  --refs <path,path|none>   reference design images for LLM diff review (GPT-4o + Gemini).
                            Omit OR pass "none" to skip LLM review (structural-only verdict).
  --ref-roles <r1,r2,...>   per-reference role aligned with --refs. Values: goal | before.
                            Single value applies to all refs. Default: goal (current).
                              - goal:   impl MUST match this reference
                              - before: impl MUST differ from this reference (requested change).
  --branch <name>           git branch (defaults to current). Used in output dir naming.
  --out <dir>               output directory (defaults to .claude/visual-qa/<branch>/)

Widths swept (fixed): ${WIDTHS.join(', ')}

Exit codes:
  0  success / overall PASS
  1  bad args
  2  dev server unreachable OR LLM review returned FAIL OR localhost-only violation
`);
}

function getCurrentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim() || 'no-branch';
  } catch {
    return 'no-branch';
  }
}

function slugify(s) {
  return s.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'root';
}

async function captureWithRetry(page, attempts, action, label) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await action(); }
    catch (err) {
      lastErr = err;
      console.error(`[visual-qa] ${label} attempt ${i + 1} failed: ${err?.message}`);
    }
  }
  throw lastErr;
}

// In-browser overflow probe: returns selectors for elements whose content
// is clipped horizontally or vertically by their box. Catches the FeaturedSpot
// "HISTORICAL ACCURA" silent failure (one-line pill in a constrained grid
// column with whitespace-nowrap on long text).
//
// The +1 tolerance absorbs sub-pixel rounding; the parent-overflow:hidden
// guard scopes to clipping the user would actually SEE (not internal
// scroll-containers that are scrollable by design).
function overflowProbeScript() {
  const PROBE = () => {
    const out = [];
    const seen = new Set();
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const sw = el.scrollWidth, cw = el.clientWidth;
      const sh = el.scrollHeight, ch = el.clientHeight;
      const xClip = sw > cw + 1;
      const yClip = sh > ch + 1;
      if (!xClip && !yClip) continue;
      if (el === document.body || el === document.documentElement) continue;

      const cs = getComputedStyle(el);

      // Skip screen-reader-only (sr-only): clientWidth/Height ≤ 4 means the
      // element is intentionally hidden visually but kept in DOM for a11y.
      if (cw <= 4 && ch <= 4) continue;
      // Skip invisible / display-none
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      // Skip clip-path-based sr-only (skip-to-content links and similar).
      // The CSS `clip` property is deprecated but still used; `clip-path` is modern.
      if (cs.clip && cs.clip !== 'auto' && cs.clip !== 'none') continue;
      if (cs.clipPath && cs.clipPath !== 'none') continue;

      // Skip intentional text-truncate (overflow content rendered as ellipsis
      // is a design choice, not a bug). Check self AND parent — Tailwind's
      // `truncate` puts overflow:hidden on the element + text-overflow:ellipsis.
      const selfEllipsis = cs.textOverflow === 'ellipsis' && (cs.overflowX === 'hidden' || cs.overflowX === 'clip');
      if (selfEllipsis) continue;

      // Skip if the immediate parent is a scroll container (overflow-x:auto/scroll)
      // — that's a carousel/scroller pattern where content > viewport is the design.
      const parent = el.parentElement;
      if (parent) {
        const pcs = getComputedStyle(parent);
        if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll') continue;
        if (pcs.overflowY === 'auto' || pcs.overflowY === 'scroll') continue;
      }

      // Determine if the element is actually clipped (parent overflow:hidden
      // or self overflow:hidden / clip), vs. legitimately scrollable.
      const overflowX = cs.overflowX;
      const overflowY = cs.overflowY;
      const selfClips = overflowX === 'hidden' || overflowX === 'clip' || overflowY === 'hidden' || overflowY === 'clip';
      let ancestorClips = false;
      for (let p = el.parentElement; p; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'hidden' || pcs.overflowX === 'clip' || pcs.overflowY === 'hidden' || pcs.overflowY === 'clip') {
          ancestorClips = true; break;
        }
      }
      if (!selfClips && !ancestorClips) continue;
      // Build a short selector path
      function shortSel(node) {
        if (!node || node.nodeType !== 1) return '';
        let s = node.tagName.toLowerCase();
        if (node.id) s += '#' + node.id;
        if (node.className && typeof node.className === 'string') {
          const cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
          if (cls) s += '.' + cls;
        }
        return s;
      }
      const path = [];
      let cur = el;
      while (cur && cur !== document.body && path.length < 4) {
        path.unshift(shortSel(cur));
        cur = cur.parentElement;
      }
      const sel = path.join(' > ');
      if (seen.has(sel)) continue;
      seen.add(sel);
      const text = (el.textContent || '').trim().slice(0, 60);
      out.push({
        selector: sel,
        xClip,
        yClip,
        scrollWidth: sw,
        clientWidth: cw,
        scrollHeight: sh,
        clientHeight: ch,
        textPreview: text,
      });
      if (out.length >= 25) break; // cap report size
    }
    return out;
  };
  return `(${PROBE.toString()})()`;
}

async function captureScreenshots({ url, paths, branch, outDir, elements }) {
  const browser = await chromium.launch();
  const screenshots = [];
  const elementCrops = [];
  const overflowReport = [];
  const redirectReport = [];
  try {
    for (const path of paths) {
      const pathSlug = slugify(path);
      for (const width of WIDTHS) {
        const dir = join(outDir, pathSlug);
        mkdirSync(dir, { recursive: true });
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
        const page = await context.newPage();
        try {
          await captureWithRetry(page, 2, async () => {
            await page.goto(url + path, { waitUntil: 'load', timeout: 15000 });
            // Belt-and-suspenders: 'load' fires when network requests for the
            // initial HTML resolve, but client-side hydration may still be
            // running. 'networkidle' is deprecated/flaky in Playwright so we
            // use a small fixed wait instead.
            await page.waitForTimeout(2000);
          }, `goto ${path} @ ${width}`);

          // Client-side redirects (feature-flag gates, auth guards, dead
          // routes) land the browser somewhere else AFTER 'load' fires, so
          // the goto() above succeeds while the screenshot below silently
          // captures the WRONG page. Compare pathname+search, not full URL
          // (origin can differ on redirect to a different host/port) and not
          // trailing-slash-sensitive. A session burned ~1hr on exactly this:
          // /test/rating-editor-fixture bounced to '/' via a feature-flag
          // guard, and every screenshot + overflow probe below was quietly
          // auditing the homepage instead (2026-07-21).
          const expected = new URL(url + path);
          const actual = new URL(page.url());
          const norm = u => u.pathname.replace(/\/$/, '') + u.search;
          if (norm(actual) !== norm(expected)) {
            redirectReport.push({ path, viewport: width, expected: path, actual: actual.pathname + actual.search });
          }

          const file = join(dir, `${width}.png`);
          await page.screenshot({ path: file, fullPage: true });
          screenshots.push({ path, width, file });

          // Structural overflow probe — runs in the page, fast (<200ms typical).
          try {
            const clipped = await page.evaluate(overflowProbeScript());
            for (const item of clipped) {
              overflowReport.push({ path, viewport: width, ...item });
            }
          } catch (err) {
            console.error(`[visual-qa] WARN: overflow probe failed at ${path} @ ${width}: ${err?.message}`);
          }

          for (const sel of elements) {
            try {
              const locator = page.locator(sel).first();
              if (await locator.count() === 0) {
                console.error(`[visual-qa] WARN: element "${sel}" not found at ${path} @ ${width}`);
                continue;
              }
              const cropFile = join(dir, `${width}__${slugify(sel)}.png`);
              await locator.screenshot({ path: cropFile });
              // Geometry digest: bounding box at capture time. Layout collapses
              // (e.g. badge width going from 80px → 40px) always rotate the
              // contentHash even if pixel-bytes happen to compress similarly.
              let geometry = null;
              try {
                const box = await locator.boundingBox();
                if (box) geometry = {
                  w: Math.round(box.width), h: Math.round(box.height),
                  x: Math.round(box.x), y: Math.round(box.y),
                };
              } catch { /* ignore — best-effort */ }
              elementCrops.push({ path, width, selector: sel, file: cropFile, geometry });
            } catch (err) {
              console.error(`[visual-qa] WARN: crop failed for "${sel}" @ ${width}: ${err?.message}`);
            }
          }
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  return { screenshots, elementCrops, overflowReport, redirectReport };
}

// ── LLM review ──────────────────────────────────────────────────────────────
// Checklist baked into the prompt (was references/checklist.md in the
// earlier draft — moved inline so the runner is the single source of truth).
const REVIEW_CHECKLIST = `You are comparing an IMPLEMENTATION screenshot to a REFERENCE design image.

CRITICAL ANTI-HALLUCINATION RULES:
- If the two images appear IDENTICAL or near-identical, return {"verdict": "PASS", "issues": []}.
- If you cannot identify a SPECIFIC, NAMEABLE difference with a quoted text snippet or a measurable
  visual property (color hex/pill width/etc.), DO NOT INVENT ONE. Return PASS.
- Vision models commonly hallucinate small numeric/text differences in show titles, scores, dates —
  if you find yourself listing "score X in ref vs Y in impl" for many items, you are HALLUCINATING.
  Stop and return PASS unless you can quote the exact pixel coordinates where the difference appears.
- The reference image and the implementation may differ in dynamic content (today's date, scores
  that change with new data). DO NOT flag dynamic content differences. Flag only LAYOUT, COPY,
  STYLING, COLOR, and TYPOGRAPHY issues.
- If the reference shows a single UI component (a card, a pill, a section) and the implementation
  shows a full page, look ONLY at the implementation region that corresponds to the reference.

Return ONLY a JSON object: {"verdict": "PASS" | "FAIL", "issues": ["specific issue 1", ...]}.
No markdown wrapper, no commentary, no leading text.

HARD FAILURES (auto FAIL — must be specific & quotable):
1. Copy mismatch — STATIC text content differs (label, button text, headline).
   Example: design says "HISTORICAL ACCURACY", implementation says "ACCURACY" → FAIL.
   NOT a failure: show titles, scores, dates (those are dynamic data).
2. Typography case mismatch — UPPERCASE in design rendered as lowercase (or vice versa),
   tracked letter-spacing dropped, font weight obviously changed.
3. Missing element — design shows a UI element implementation does not render at all.
4. Layout overflow — content extends past viewport/container; text VISIBLY clipped/cut-off (not
   just truncated with ellipsis); horizontal scroll where there shouldn't be one.
5. Tap-target violation on mobile widths (≤414) — interactive element height < 44px.

SOFT SIGNALS (note but only FAIL if severe):
6. Color/glow intensity dramatically different (e.g., gold pill vs no gold pill).
7. Proportion >25% off.
8. Border-radius mismatch only if visually jarring.

If you cannot see one of the images, return {"verdict": "FAIL", "issues": ["could not load image: <which one>"]}.`;

function imageToBase64(path) {
  return readFileSync(path).toString('base64');
}

// Per-ref roles change the PASS criterion. Default ('goal') keeps current
// behaviour: implementation MUST match the reference. The 'before' role
// flips it: the reference is the state the user wants CHANGED, so the
// implementation MUST differ from the reference. Mixed sets are supported —
// each reference's role is announced inline before its image.
function rolePromptHeader(refRoles) {
  if (!refRoles || refRoles.length === 0) return REVIEW_CHECKLIST;
  const hasBefore = refRoles.includes('before');
  if (!hasBefore) return REVIEW_CHECKLIST;
  return REVIEW_CHECKLIST + `\n\nPER-REFERENCE ROLES (override the default PASS criterion):
- A reference labelled GOAL is the state to match — pass if impl resembles it (default).
- A reference labelled BEFORE is the state to move AWAY from — pass if impl differs
  from it in the intended direction. A diff against a BEFORE reference is the user's
  requested change, not a regression. Do NOT FAIL the verdict because the impl differs
  from a BEFORE reference; only FAIL if the impl looks identical to the BEFORE reference
  (the change didn't land) or if there are NEW regressions unrelated to the BEFORE diff.`;
}

async function reviewWithOpenAI({ refPaths, refRoles, implPaths, apiKey, model = 'gpt-4o' }) {
  const roles = refRoles && refRoles.length === refPaths.length ? refRoles : refPaths.map(() => 'goal');
  const refBlocks = [];
  for (let i = 0; i < refPaths.length; i++) {
    refBlocks.push({ type: 'text', text: `REFERENCE #${i + 1} (role=${roles[i].toUpperCase()}):` });
    refBlocks.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${imageToBase64(refPaths[i])}` } });
  }
  const messages = [{
    role: 'system',
    content: rolePromptHeader(roles),
  }, {
    role: 'user',
    content: [
      ...refBlocks,
      { type: 'text', text: `\nIMPLEMENTATION screenshots at multiple widths follow:` },
      ...implPaths.map(p => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${imageToBase64(p)}` } })),
      { type: 'text', text: '\nReturn the verdict JSON now.' },
    ],
  }];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: 2048, temperature: 0 }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenAI returned no content');
  return parseVerdictJson(content);
}

async function reviewWithGemini({ refPaths, refRoles, implPaths, apiKey, model = 'gemini-2.5-pro' }) {
  const roles = refRoles && refRoles.length === refPaths.length ? refRoles : refPaths.map(() => 'goal');
  const parts = [{ text: rolePromptHeader(roles) }];
  for (let i = 0; i < refPaths.length; i++) {
    parts.push({ text: `\nREFERENCE #${i + 1} (role=${roles[i].toUpperCase()}):` });
    parts.push({ inlineData: { mimeType: 'image/png', data: imageToBase64(refPaths[i]) } });
  }
  parts.push({ text: '\nIMPLEMENTATION screenshots at multiple widths:' });
  for (const p of implPaths) parts.push({ inlineData: { mimeType: 'image/png', data: imageToBase64(p) } });
  parts.push({ text: '\nReturn the verdict JSON now.' });

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      // gemini-2.5-pro REQUIRES thinking mode (thinkingBudget=0 → HTTP 400).
      // Omit thinkingConfig to use the model's default budget. maxOutputTokens
      // must cover thinking tokens TOO — at 2048 the model's thoughts alone hit
      // the cap and it returns no content (finishReason=MAX_TOKENS, empty
      // candidates) on multi-ref reviews. 8192 leaves room for both.
      generationConfig: { temperature: 0, maxOutputTokens: 8192 },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  const content = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Gemini returned no content (' + JSON.stringify(body).slice(0, 200) + ')');
  return parseVerdictJson(content);
}

function parseVerdictJson(content) {
  // LLMs sometimes wrap JSON in ```json ... ``` despite instructions; strip.
  let s = content.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1];
  let parsed;
  try { parsed = JSON.parse(s); }
  catch (err) { throw new Error(`Invalid JSON in verdict: ${err.message} — content was: ${s.slice(0, 200)}`); }
  if (!parsed || typeof parsed !== 'object') throw new Error('Verdict is not an object');
  if (parsed.verdict !== 'PASS' && parsed.verdict !== 'FAIL') throw new Error(`Verdict must be "PASS" or "FAIL", got "${parsed.verdict}"`);
  if (!Array.isArray(parsed.issues)) throw new Error('Issues must be an array');
  return { verdict: parsed.verdict, issues: parsed.issues.map(String) };
}

// Wraps a single LLM call with one retry + fail-closed error capture.
async function safeLLMReview(label, fn) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await fn();
      return { ...result, attempts: attempt };
    } catch (err) {
      console.error(`[visual-qa] ${label} attempt ${attempt} failed: ${err.message}`);
      if (attempt === 2) {
        // Fail-closed: any error → FAIL verdict, surface error so caller knows
        return { verdict: 'FAIL', issues: [`${label} provider error: ${err.message}`], error: err.message, attempts: attempt };
      }
    }
  }
}

async function runLLMReview({ refPaths, refRoles, screenshots, elementCrops }) {
  // Prefer element crops (per-viewport, tight to the changed UI) over full-page
  // screenshots — the latter trigger hallucination on dynamic content
  // (scores, dates, titles) that differs between ref-capture-time and now.
  let implPaths;
  if (elementCrops && elementCrops.length > 0) {
    // Use crops at 3 representative widths.
    const REVIEW_WIDTHS = new Set([360, 768, 1440]);
    implPaths = elementCrops
      .filter(c => REVIEW_WIDTHS.has(c.width))
      .map(c => c.file);
  } else {
    const REVIEW_WIDTHS = new Set([360, 768, 1440]);
    implPaths = screenshots
      .filter(s => REVIEW_WIDTHS.has(s.width))
      .map(s => s.file);
  }
  if (implPaths.length === 0) return null;

  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  const [openai, gemini] = await Promise.all([
    openaiKey
      ? safeLLMReview('openai', () => reviewWithOpenAI({ refPaths, refRoles, implPaths, apiKey: openaiKey }))
      : Promise.resolve({ verdict: 'FAIL', issues: ['OPENAI_API_KEY missing'], error: 'missing-key' }),
    geminiKey
      ? safeLLMReview('gemini', () => reviewWithGemini({ refPaths, refRoles, implPaths, apiKey: geminiKey }))
      : Promise.resolve({ verdict: 'FAIL', issues: ['GEMINI_API_KEY missing'], error: 'missing-key' }),
  ]);

  return { openai, gemini };
}

// ── Verdict assembly + pruning ──────────────────────────────────────────────
// Hash logic lives in scripts/lib/verdict-hash.mjs so both the runner and tests
// share one implementation. See that file for the inputs that participate.

function sha256OfFile(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
  } catch { return null; }
}

function getHeadSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

function safeReadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function pruneStaleVerdictDirs(currentBranch, baseDir = '.claude/visual-qa') {
  if (!existsSync(baseDir)) return [];
  const STALE_MS = 48 * 60 * 60 * 1000;
  const now = Date.now();
  const pruned = [];
  for (const name of readdirSync(baseDir)) {
    if (name === currentBranch) continue;
    const dir = join(baseDir, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      // Newest file mtime under the dir — the dir's own mtime is unreliable
      // (touched by every mkdir during a fresh run). Fall back to dir mtime
      // only if the dir is empty.
      let newest = 0;
      let sawFile = false;
      for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (f.isFile()) {
          // Node 18 used `f.path` as the relative parent; Node 20+ added
          // `f.parentPath` as the full path. Prefer parentPath when present.
          const fp = f.parentPath ? join(f.parentPath, f.name) : join(dir, f.path || '', f.name);
          try { newest = Math.max(newest, statSync(fp).mtimeMs); sawFile = true; } catch { /* ignore */ }
        }
      }
      if (!sawFile) newest = st.mtimeMs;
      if (now - newest > STALE_MS) {
        rmSync(dir, { recursive: true, force: true });
        pruned.push(name);
      }
    } catch { /* skip */ }
  }
  return pruned;
}

function isLocalhost(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

async function devServerReachable(url) {
  // Health check: dev server must respond with >1KB HTML. Catches the
  // "Playwright happily captures a blank page as PASS" failure mode.
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = await res.text();
    if (body.length < 1024) return { ok: false, reason: `response too small (${body.length} bytes)` };
    if (!/<html|<!doctype/i.test(body)) return { ok: false, reason: 'response not HTML' };
    return { ok: true, bytes: body.length };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }

  if (!args.url) {
    console.error('ERROR: --url is required.\nRun with --help for usage.');
    process.exit(1);
  }

  if (!isLocalhost(args.url)) {
    console.error(`ERROR: --url must be a localhost URL (got "${args.url}").
The gate enforces "show it to me locally first" — prod URLs do not count
as local preview. Start the dev server (\`npm run dev\`) and use http://localhost:3000.`);
    process.exit(2);
  }

  const health = await devServerReachable(args.url);
  if (!health.ok) {
    console.error(`ERROR: dev server not reachable at ${args.url}: ${health.reason}.
Start it first:  npm run dev
Then re-run this command.`);
    process.exit(2);
  }

  const branch = args.branch || getCurrentBranch();
  const outDir = args.out || `.claude/visual-qa/${branch}`;

  console.error(`[visual-qa] url=${args.url} branch=${branch} paths=${args.paths.join(',')} widths=${WIDTHS.join(',')} elements=${args.elements.length} refs=${args.refs ? args.refs.length : 'none'}`);
  console.error(`[visual-qa] out=${outDir}`);
  console.error(`[visual-qa] dev server OK (${health.bytes} bytes HTML)`);

  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const { screenshots, elementCrops, overflowReport, redirectReport } = await captureScreenshots({
    url: args.url, paths: args.paths, branch, outDir, elements: args.elements,
  });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.error(`[visual-qa] captured ${screenshots.length} full-page + ${elementCrops.length} element crop(s) + ${overflowReport.length} overflow finding(s) in ${elapsed}s`);
  if (redirectReport.length > 0) {
    console.error('[visual-qa] 🛑 REDIRECT MISMATCH — screenshots below are of the WRONG PAGE:');
    for (const r of redirectReport) {
      console.error(`  - ${r.viewport}px requested "${r.path}" but landed on "${r.actual}" — likely a feature-flag/auth guard or dead route. Fix the redirect cause (e.g. NEXT_PUBLIC_FEATURES=userAccounts) and re-run before trusting any finding below.`);
    }
  }
  if (overflowReport.length > 0) {
    console.error('[visual-qa] OVERFLOW FINDINGS:');
    for (const o of overflowReport.slice(0, 10)) {
      const axes = [o.xClip ? `xClip(sw=${o.scrollWidth},cw=${o.clientWidth})` : null, o.yClip ? `yClip(sh=${o.scrollHeight},ch=${o.clientHeight})` : null].filter(Boolean).join(' ');
      console.error(`  - ${o.viewport}px ${o.path} ${o.selector} ${axes} text="${o.textPreview}"`);
    }
  }

  // Roles must be computed before LLM review so the prompt branches by role.
  let refRoles = [];
  try {
    refRoles = normalizeRefRoles(args.refs, args.refRoles);
  } catch (err) {
    console.error(`[visual-qa] ERROR: ${err.message}`);
    process.exit(1);
  }

  let verdicts = null;
  if (args.refs && args.refs.length > 0) {
    const missingRefs = args.refs.filter(p => !existsSync(p));
    if (missingRefs.length > 0) {
      console.error(`[visual-qa] ERROR: reference image(s) not found: ${missingRefs.join(', ')}`);
      process.exit(1);
    }
    const roleSummary = refRoles.length === args.refs.length ? ` roles=${refRoles.join(',')}` : '';
    console.error(`[visual-qa] running two-model review (${args.refs.length} ref(s)${roleSummary} vs 360/768/1440 implementation)…`);
    const tLLM = Date.now();
    verdicts = await runLLMReview({ refPaths: args.refs, refRoles, screenshots, elementCrops });
    const llmElapsed = Math.round((Date.now() - tLLM) / 1000);
    if (verdicts) {
      console.error(`[visual-qa] LLM review done in ${llmElapsed}s`);
      console.error(`  openai: ${verdicts.openai.verdict}${verdicts.openai.issues.length ? ' — ' + verdicts.openai.issues.join('; ') : ''}`);
      console.error(`  gemini: ${verdicts.gemini.verdict}${verdicts.gemini.issues.length ? ' — ' + verdicts.gemini.issues.join('; ') : ''}`);
    }
  }

  const overallPass = redirectReport.length > 0
    ? false // screenshots are of the wrong page — nothing below can be trusted
    : verdicts
      ? verdicts.openai.verdict === 'PASS' && verdicts.gemini.verdict === 'PASS'
      : true; // structural-only mode (no refs) trusts the agent + user to eye the screenshots

  // Build the verdict using stable inputs only — see scripts/lib/verdict-hash.mjs
  // for the full inputs list. Anything mutable (timestamps, runIds, raw file
  // paths) is stored on the verdict for human readability but excluded from
  // the hash so re-runs on identical pixels yield an identical contentHash.
  const refsDigest = (args.refs || []).map((p, idx) => ({
    bytesSha: sha256OfFile(p),
    role: refRoles[idx] || 'goal',
  }));
  const screenshotsDigest = screenshots.map(s => ({
    path: s.path, width: s.width, bytesSha: sha256OfFile(s.file),
  }));
  const elementCropsDigest = elementCrops.map(c => ({
    path: c.path,
    width: c.width,
    selector: c.selector,
    geometry: c.geometry || null, // captured in S1-T2
    bytesSha: sha256OfFile(c.file),
  }));
  const overflowReportForHash = overflowReport.map(({ textPreview, ...rest }) => rest);
  const headSha = getHeadSha();

  const verdict = {
    schemaVersion: VERDICT_SCHEMA_VERSION,
    branch,
    headSha,
    url: args.url,
    paths: args.paths,
    widths: WIDTHS,
    elements: args.elements,
    refsDigest,
    screenshotsDigest,
    elementCropsDigest,
    overflowReportForHash,
    redirectReport,
    verdicts,
    overallPass,
    // Metadata — NOT part of hash:
    screenshots,
    elementCrops,
    refs: args.refs || [],
    overflowReport,
    timestamp: new Date().toISOString(),
    runId: generateRunId(),
    contentHash: null, // filled in next
  };
  verdict.contentHash = computeContentHash(verdict);

  const verdictPath = join(outDir, 'verdict.json');
  // S1-T8: skip rewrite if computed contentHash matches existing file.
  const existing = existsSync(verdictPath)
    ? safeReadJson(verdictPath) : null;
  if (existing && existing.contentHash === verdict.contentHash) {
    console.error(`[visual-qa] contentHash unchanged (${verdict.contentHash}); preserving existing verdict.json`);
  } else {
    writeFileSync(verdictPath, JSON.stringify(verdict, null, 2));
    console.error(`[visual-qa] wrote ${verdictPath} (contentHash=${verdict.contentHash})`);
  }

  const pruned = pruneStaleVerdictDirs(branch);
  if (pruned.length > 0) {
    console.error(`[visual-qa] pruned stale branch dirs: ${pruned.join(', ')}`);
  }

  // Manifest the agent should paste back to the user.
  console.log('━'.repeat(60));
  console.log(`VISUAL QA — branch ${branch} — overallPass=${overallPass}`);
  console.log(`URL: ${args.url}  Paths: ${args.paths.join(', ')}`);
  console.log(`Content hash: ${verdict.contentHash}`);
  console.log(`Screenshots: ${screenshots.length}, element crops: ${elementCrops.length}, overflow findings: ${overflowReport.length}`);
  if (redirectReport.length > 0) {
    console.log('');
    console.log(`🛑 REDIRECT MISMATCH (${redirectReport.length}) — every screenshot above is of the WRONG PAGE, not the requested path:`);
    for (const r of redirectReport) console.log(`  - requested "${r.path}" @ ${r.viewport}px → landed on "${r.actual}"`);
    console.log('  Fix the redirect cause and re-run before reading any crop or trusting overallPass.');
  }
  if (verdicts) {
    console.log(`OpenAI: ${verdicts.openai.verdict}${verdicts.openai.issues.length ? ' — ' + verdicts.openai.issues.slice(0, 3).join(' | ') : ''}`);
    console.log(`Gemini: ${verdicts.gemini.verdict}${verdicts.gemini.issues.length ? ' — ' + verdicts.gemini.issues.slice(0, 3).join(' | ') : ''}`);
  }
  console.log('');
  console.log('AGENT INSTRUCTIONS:');
  console.log('  1. Read element crops at FULL RESOLUTION (not the full-page thumbnails):');
  if (elementCrops.length > 0) {
    for (const c of elementCrops.slice(0, 6)) console.log(`     Read ${c.file}`);
    if (elementCrops.length > 6) console.log(`     (+ ${elementCrops.length - 6} more)`);
  } else {
    console.log('     (none — re-run with --elements "<css-sel>" to legibility-check key UI)');
    console.log('     Full-page screenshots:');
    for (const s of screenshots.slice(0, 3)) console.log(`     Read ${s.file}`);
  }
  console.log('  2. Paste the above paths + verdict summary in your next message to the user.');
  console.log(`  3. Wait for the user to reply with: APPROVED: ${verdict.contentHash}`);
  console.log(`     OR: a description of what to fix.`);
  console.log('━'.repeat(60));

  process.exit(overallPass ? 0 : 2);
}

main().catch(err => {
  console.error(`[visual-qa] FATAL: ${err?.stack || err}`);
  process.exit(2);
});
