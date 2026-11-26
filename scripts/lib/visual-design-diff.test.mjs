// BRO-7888: fix-only UI diffs ship on the session's own visual QA; design diffs still wait for the owner's yes.
// Part 1 replays REAL main commits through the real classifier (scripts/lib/visual-design-diff.js).
// Part 2 pins adversarial "looks like a fix, renders differently" fixtures (the second-opinion review found 9 that passed).
// Part 3 replays the REAL hook (.claude/hooks/pre-push-visual-gate.sh) in a scratch repo, three ways plus a red control:
//   fix-only + passing verdict -> exit 0 with no owner yes; design diff -> blocked; kill switch -> blocked again;
//   and with the self-clear block cut out of the hook the fix-only case is blocked (proves the test sees the change).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { spawnSyncStdinFile } from '../../tests/helpers/spawn-stdin-file.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('./visual-design-diff.js');
const DURABLE = require('./visual-approval-durable.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const HOOK = join(REPO_ROOT, '.claude', 'hooks', 'pre-push-visual-gate.sh');
const hasTs = !!D._loadTs();
const SKIP_TS = !hasTs && 'typescript is not installed (the classifier fails closed without it)';

// ---------- Part 1: real commits from main ----------
const commitKnown = (sha) => { try { execFileSync('git', ['-C', REPO_ROOT, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; } };
function replay(sha) {
  const files = execFileSync('git', ['-C', REPO_ROOT, 'diff', '--name-only', `${sha}^`, sha], { encoding: 'utf8' }).split('\n').filter((f) => /^src\/.*\.(tsx|jsx)$/.test(f));
  return D.designFiles(`${sha}^...${sha}`, files, REPO_ROOT);
}
for (const [sha, want, why] of [
  ['944f472a1', 'fix', 'sentry chunk filter: a type field only'],
  ['8086bd7b9', 'fix', 'sentry chunk filter: an import, a comment and an early return null inside an effect'],
  ['0334f150b', 'design', 'Predict the Score: new props on rendered components'],
  ['b7303ef89', 'design', 'fix plus a wrapper element: the mix waits for the owner'],
]) {
  test(`real commit ${sha} classifies as ${want} (${why})`, { skip: SKIP_TS || (!commitKnown(sha) && `commit ${sha} not in this clone (shallow)`) }, () => {
    const r = replay(sha);
    assert.equal(r.length > 0, want === 'design', JSON.stringify(r));
    if (sha === 'b7303ef89') assert.ok(r.some((f) => /CallTheScore/.test(f.file)), 'the wrapper element file is the design one: ' + JSON.stringify(r));
  });
}

// ---------- Part 2: fixtures ----------
const wrap = (body, head = "import {A,B} from 'a'; import {u} from './u';") => `${head} export default function X(){${body}}`;
const cls = (a, b) => D.classifyFile({ file: 'src/x.tsx', oldSource: wrap(a), newSource: wrap(b) }).design;
const DESIGN_CASES = {
  'const class swapped for a design-system class': [`const C="card"; return <div className={C}/>;`, `const C="card-premium"; return <div className={C}/>;`],
  'cn() argument': [`const c=cn("card"); return <div className={c}/>;`, `const c=cn("card-premium"); return <div className={c}/>;`],
  'style object value': [`const s={color:"red"}; return <div style={s}/>;`, `const s={color:"blue"}; return <div style={s}/>;`],
  'component alias retargeted': [`const Comp=A; return <Comp/>;`, `const Comp=B; return <Comp/>;`],
  'tag import retargeted': [`return <A/>;`, `return <A/>;`, "import {A} from 'other';"],
  'condition replaced by a literal': [`return <div>{a && <A/>}</div>;`, `return <div>{true && <A/>}</div>;`],
  'prop flipped': [`return <B compact={isM}/>;`, `return <B compact={!isM}/>;`],
  'list grown': [`const L=[1,2,3]; return <ul>{L.map(i=><li key={i}/>)}</ul>;`, `const L=[1,2,3,4,5,6,7,8]; return <ul>{L.map(i=><li key={i}/>)}</ul>;`],
  'helper returns another class': [`const g=()=>"card"; return <div className={g()}/>;`, `const g=()=>"card-premium"; return <div className={g()}/>;`],
  'added element': [`return <div><A/></div>;`, `return <div><A/><A/></div>;`],
  'early return null in the component itself': [`return <A/>;`, `if (x) return null; return <A/>;`],
  'imported component swapped (same local name)': [`return <A/>;`, `return <A/>;`, "import {A} from 'other';"],
  'imported binding now another export': [`return <A/>;`, `return <A/>;`, "import {B as A} from 'a';"],
  'children identifier swapped': [`return <div>{a && <A/>}</div>;`, `return <div>{b && <A/>}</div>;`],
  'conditional identifier swapped': [`return <div>{a ? <A/> : <B/>}</div>;`, `return <div>{c ? <A/> : <B/>}</div>;`],
  'ternary class swapped': [`return <div className={on ? "p-2" : "p-4"}/>;`, `return <div className={on ? "p-4" : "p-2"}/>;`],
  'aria attribute changed': [`return <div aria-hidden="true"/>;`, `return <div aria-hidden="false"/>;`],
  'aria expression changed': [`return <div aria-hidden={a}/>;`, `return <div aria-hidden={b}/>;`],
  'data attribute changed (css can select on it)': [`return <div data-state="open"/>;`, `return <div data-state="closed"/>;`],
  'id attribute changed (css can select on it)': [`return <div id="x"/>;`, `return <div id="y"/>;`],
  'DOM style write in an effect': [`useEffect(()=>{ el.style.width = 100; },[]); return <A/>;`, `useEffect(()=>{ el.style.width = 200; },[]); return <A/>;`],
  'DOM class write in an effect': [`useEffect(()=>{ el.classList.add("a"); },[]); return <A/>;`, `useEffect(()=>{ el.classList.add("b"); },[]); return <A/>;`],
  'BigInt literal changed': [`const n = 10n; return <A n={n}/>;`, `const n = 20n; return <A n={n}/>;`],
  'regex literal changed': [`const r = /a+/; return <A r={r}/>;`, `const r = /b+/; return <A r={r}/>;`],
  're-export retargeted': [`return <A/>;`, `return <A/>;`, "export { default } from './NewCard'; import {A} from 'a';"],
  'unary sign flipped': [`return <div style={{marginTop:-8}}/>;`, `return <div style={{marginTop:+8}}/>;`],
  'state setter value in an effect': [`useEffect(()=>{ setS(true) },[]); return <A/>;`, `useEffect(()=>{ setS(false) },[]); return <A/>;`],
  'state setter arg negated in an effect': [`useEffect(()=>{ setS(a) },[]); return <A/>;`, `useEffect(()=>{ setS(!a) },[]); return <A/>;`],
  'layout effect height': [`useLayoutEffect(()=>{ setH(200) },[]); return <A/>;`, `useLayoutEffect(()=>{ setH(800) },[]); return <A/>;`],
  'dialog show vs close in an effect': [`useEffect(()=>{ r.current.showModal(); },[]); return <A/>;`, `useEffect(()=>{ r.current.close(); },[]); return <A/>;`],
  'timer delay in an effect': [`useEffect(()=>{ setTimeout(f,0) },[]); return <A/>;`, `useEffect(()=>{ setTimeout(f,99999) },[]); return <A/>;`],
  'ref callback hidden flag': [`return <div ref={el=>{ if(el) el.hidden=false }}/>;`, `return <div ref={el=>{ if(el) el.hidden=true }}/>;`],
  'custom component name prop': [`return <A name={s}/>;`, `return <A name={c}/>;`],
  'render prop attributes': [`return <A onRenderItem={()=> <B big={true} n={2}/>}/>;`, `return <A onRenderItem={()=> <B big={false} n={9}/>}/>;`],
  'base class swapped': [`class P extends A {} return <A/>;`, `class P extends B {} return <A/>;`],
  'module-level constant changed': [`return <A/>;`, `return <A/>;`, "import {A} from 'a'; const W = 4;"],
};
for (const [name, [a, b, headB]] of Object.entries(DESIGN_CASES)) {
  test(`design (fail closed): ${name}`, { skip: SKIP_TS }, () => {
    const o = D.classifyFile({ file: 'src/x.tsx', oldSource: wrap(a), newSource: wrap(b, headB) });
    assert.equal(o.design, true, o.reason);
  });
}
const FIX_CASES = {
  'reworded copy': [`return <p>Hello</p>;`, `return <p>Hi there</p>;`],
  'changed href expression': [`return <a href={u(x)}>go</a>;`, `return <a href={u(y)}>go</a>;`],
  'changed inline handler logic': [`return <button onClick={()=>{ if(!a) return; run(a); }}/>;`, `return <button onClick={()=>{ if(!a||!b) return; run(a); }}/>;`],
  'effect added with an early return null': [`return <A/>;`, `useEffect(()=>{ if (u()) return null; },[]); return <A/>;`],
  'changed key expression': [`return <ul>{L.map(i=><li key={i.id}/>)}</ul>;`, `return <ul>{L.map(i=><li key={i.slug}/>)}</ul>;`],
  'effect gains a call and an early return null': [`return <A/>;`, `useEffect(()=>{ if (u()) return null; },[]); return <A/>;`],
};
for (const [name, [a, b]] of Object.entries(FIX_CASES)) {
  test(`fix: ${name}`, { skip: SKIP_TS }, () => assert.equal(cls(a, b), false));
}
// ---------- Part 2b (BRO-8177): logic-only edits (named handlers, URL builders, log/analytics strings) ----------
// Class guard: every LOGIC_FIX case was classed as design before BRO-8177 (checked by the RED test below with the
// exemption switched off), so reverting the exemption fails these tests.
const LINK_HEAD = "import {A,B} from 'a'; import Link from 'next/link'; import {u} from './u';";
const cls8177 = (a, b, env = {}) => D.classifyFile({ file: 'src/x.tsx', oldSource: wrap(a, LINK_HEAD), newSource: wrap(b, LINK_HEAD), env });
const LOGIC_FIX = {
  'named handler logic changed': [`const h=()=>{ if(!a) return; run(a); }; return <button onClick={h}/>;`, `const h=()=>{ if(!a||!b) return; run(a); }; return <button onClick={h}/>;`],
  'useCallback handler changed': [`const h=useCallback(()=>{ go(a) },[a]); return <button onClick={h}/>;`, `const h=useCallback(()=>{ if(b) go(a) },[a,b]); return <button onClick={h}/>;`],
  'href URL string on <a>': [`return <a href={\`/s/\${id}?utm=a\`}>go</a>;`, `return <a href={\`/s/\${id}?utm=b\`}>go</a>;`],
  'href URL string on next/link Link': [`return <Link href="/shows/a">go</Link>;`, `return <Link href="/shows/b">go</Link>;`],
  'URL builder const used only in href': [`const s=\`https://x.com/s/\${id}?utm=a\`; return <a href={s}>go</a>;`, `const s=\`https://x.com/s/\${id}?utm=b\`; return <a href={s}>go</a>;`],
  'URL builder function used only in href': [`const mk=(s)=>"/shows/"+s; return <a href={mk(id)}>go</a>;`, `const mk=(s)=>"/show/"+s+"?x=1"; return <a href={mk(id)}>go</a>;`],
  'module-level URL builder': [`return <a href={mk(id)}>go</a>;`, `return <a href={mk(id)}>go</a>;`],
  'window.open URL in a named handler': [`const h=()=>window.open(\`https://t.co/?u=\${a}\`); return <button onClick={h}/>;`, `const h=()=>window.open(\`https://t.co/?u=\${b}&v=1\`); return <button onClick={h}/>;`],
  'router.push path in a handler': [`return <button onClick={()=>router.push("/a")}/>;`, `return <button onClick={()=>router.push("/b")}/>;`],
  'copy-only string in a non-rendered position: analytics event name': [`return <button onClick={()=>track("share_a",{via:"x"})}/>;`, `return <button onClick={()=>track("share_b",{via:"y"})}/>;`],
  'copy-only string in a non-rendered position: console message in an effect': [`useEffect(()=>{ console.error("bad a") },[]); return <A/>;`, `useEffect(()=>{ console.error("bad b") },[]); return <A/>;`],
  'new named handler wired to an existing element': [`return <button>x</button>;`, `const h=()=>run(a); return <button onClick={h}>x</button>;`],
};
// The module-level builder case differs in the head, not the body.
const MODULE_HEADS = { 'module-level URL builder': [`${LINK_HEAD} function mk(s){ return "/shows/"+s; }`, `${LINK_HEAD} function mk(s){ return "/show/"+s+"?ref=x"; }`] };
const run8177 = (name, [a, b], env) => {
  const h = MODULE_HEADS[name];
  return h ? D.classifyFile({ file: 'src/x.tsx', oldSource: wrap(a, h[0]), newSource: wrap(b, h[1]), env }) : cls8177(a, b, env);
};
for (const [name, pair] of Object.entries(LOGIC_FIX)) {
  test(`BRO-8177 fix (no owner approval): ${name}`, { skip: SKIP_TS }, () => {
    const o = run8177(name, pair, {});
    assert.equal(o.design, false, o.reason);
  });
}
test('BRO-8177 RED: with VISUAL_LOGIC_ONLY_DISABLED=1 every logic-only case is design again (the exemption is what clears them)', { skip: SKIP_TS }, () => {
  for (const [name, pair] of Object.entries(LOGIC_FIX)) {
    assert.equal(run8177(name, pair, { VISUAL_LOGIC_ONLY_DISABLED: '1' }).design, true, name);
  }
});
const LOGIC_DESIGN = {
  'className change': [`return <div className="p-2"/>;`, `return <div className="p-4"/>;`],
  'JSX structure change next to a handler edit': [`const h=()=>run(a); return <div><button onClick={h}/></div>;`, `const h=()=>run(b); return <div><button onClick={h}/><A/></div>;`],
  'rendered string literal in JSX': [`return <p>{"Hi"}</p>;`, `return <p>{"Hello"}</p>;`],
  'same-page query href (switches what the page shows)': [`return <Link href="?tab=a">go</Link>;`, `return <Link href="?tab=b">go</Link>;`],
  'hash href': [`return <a href="#a">go</a>;`, `return <a href="#b">go</a>;`],
  'href built from an unknown base': [`return <a href={\`\${base}/a\`}>go</a>;`, `return <a href={\`\${base}/b\`}>go</a>;`],
  'href on a custom component (may derive an active class)': [`return <NavItem href="/a"/>;`, `return <NavItem href="/b"/>;`],
  'href on <link> (a stylesheet)': [`return <link href="/a.css"/>;`, `return <link href="/b.css"/>;`],
  'named handler sets different state': [`const h=()=>setS("a"); return <button onClick={h}/>;`, `const h=()=>setS("b"); return <button onClick={h}/>;`],
  'handler also used for a class': [`const h=()=>"a"; return <button onClick={h} className={h()}/>;`, `const h=()=>"b"; return <button onClick={h} className={h()}/>;`],
  'URL const also passed to a component prop': [`const s="/a"; return <><a href={s}/><A url={s}/></>;`, `const s="/b"; return <><a href={s}/><A url={s}/></>;`],
  'URL const rendered as text': [`const t="/a"; return <p>{t}</p>;`, `const t="/b"; return <p>{t}</p>;`],
  'handler that returns JSX': [`const h=()=><A big={true}/>; return <B onRender={h}/>;`, `const h=()=><A big={false}/>; return <B onRender={h}/>;`],
  'error message (error.tsx can draw it)': [`return <button onClick={()=>{ throw new Error("a") }}/>;`, `return <button onClick={()=>{ throw new Error("b") }}/>;`],
  'same-page query link (view/sort switch)': [`return <a href="/shows?sort=score"/>;`, `return <a href="/shows?sort=date"/>;`],
  'router.replace with a query': [`return <button onClick={()=>router.replace("/?m=a")}/>;`, `return <button onClick={()=>router.replace("/?m=b")}/>;`],
  'template URL with a query tail': ["return <a href={`/s/${id}?view=a`}/>;", "return <a href={`/s/${id}?view=b`}/>;"],
  'hook-backed value only used in href': [`const s=useThing("a"); return <a href={s}/>;`, `const s=useThing("b"); return <a href={s}/>;`],
};
for (const [name, [a, b]] of Object.entries(LOGIC_DESIGN)) {
  test(`BRO-8177 design (owner approval still needed): ${name}`, { skip: SKIP_TS }, () => {
    const o = cls8177(a, b);
    assert.equal(o.design, true, o.reason);
  });
}
test('BRO-8177: an exported handler is recorded in full (callers live in other files)', { skip: SKIP_TS }, () => {
  const src = (v) => `${LINK_HEAD} export const h=()=>run("${v}"); export default function X(){ return <button onClick={h}/>; }`;
  assert.equal(D.classifyFile({ file: 'src/x.tsx', oldSource: src('a'), newSource: src('b') }).design, true);
});

test('CSS, new files and deleted files are always design', { skip: SKIP_TS }, () => {
  assert.equal(D.classifyFile({ file: 'src/app/globals.css', oldSource: 'a{}', newSource: 'a{}' }).design, true);
  assert.equal(D.classifyFile({ file: 'src/x.tsx', oldSource: null, newSource: 'export const a=1' }).design, true);
  assert.equal(D.classifyFile({ file: 'src/x.tsx', oldSource: 'export const a=1', newSource: null }).design, true);
  assert.equal(D.classifyFile({ file: 'src/x.tsx', oldSource: 'export const a=1', newSource: 'export const a=(' }).design, true);
});

// ---------- Part 3: the real hook in a scratch repo ----------
const BRANCH = 'feat-ui';
const FILE = 'src/components/Foo.tsx';
const BASE_SRC = `export default function Foo({a,b}: any){ return <div className="p-4"><button onClick={() => { if (a) run(a); }}>Hi</button></div>; }\n`;
const FIX_SRC = BASE_SRC.replace('if (a)', 'if (a && b)');
const DESIGN_SRC = BASE_SRC.replace('p-4', 'p-8');
const MIX_FILE2 = 'src/components/Bar.tsx';
const BAR_BASE = `export default function Bar(){ return <div className="m-2">x</div>; }\n`;

const cleanEnv = (extra = {}) => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && !k.startsWith('VISUAL_'))), ...extra });
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: cleanEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (repo, rel, text, msg) => { mkdirSync(join(repo, dirname(rel)), { recursive: true }); writeFileSync(join(repo, rel), text); git(repo, 'add', '--', rel); git(repo, 'commit', '-q', '-m', msg); };

function fixture(t, branchEdits) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'visual-fix-selfclear-')));
  t.after(() => { try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* best effort */ } });
  const origin = join(root, 'origin.git'); const repo = join(root, 'repo'); const home = join(root, 'home'); const logs = join(root, 'logs');
  for (const d of [repo, home, logs]) mkdirSync(d, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  for (const [k, v] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) git(origin, 'config', k, v);
  git(repo, 'init', '-q', '-b', 'main');
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T'], ['commit.gpgsign', 'false'], ['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false']]) git(repo, 'config', k, v);
  git(repo, 'remote', 'add', 'origin', origin);
  symlinkSync(join(REPO_ROOT, 'scripts'), join(repo, 'scripts'), 'dir'); // the hook's libs, incl. the classifier, are the real ones
  appendFileSync(join(repo, '.git', 'info', 'exclude'), '/scripts\n/.claude/\n');
  put(repo, FILE, BASE_SRC, 'base foo'); put(repo, MIX_FILE2, BAR_BASE, 'base bar');
  git(repo, 'push', '-q', 'origin', 'main'); git(repo, 'fetch', '-q', 'origin');
  git(repo, 'checkout', '-q', '-b', BRANCH);
  for (const [rel, text] of branchEdits) put(repo, rel, text, `edit ${rel}`);
  return { root, repo, home, logs };
}
function verdict(fx, over = {}) {
  const dir = join(fx.repo, '.claude', 'visual-qa', BRANCH); mkdirSync(dir, { recursive: true });
  const uiPatchId = DURABLE.uiPatchId(fx.repo, 'HEAD', 'origin/main');
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ schemaVersion: 2, contentHash: 'abcdef0123456789', overallPass: true, uiPatchId, ...over }));
}
function runHook(fx, { env = {}, hook = HOOK } = {}) {
  const cmd = 'git push origin HEAD:refs/heads/land/bro-7888-x';
  const tr = join(fx.root, 'transcript.jsonl'); // neutral: no owner yes anywhere
  writeFileSync(tr, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'please fix the header bug' }] } }) + '\n');
  const r = spawnSyncStdinFile('bash', [hook], { cwd: fx.repo, input: JSON.stringify({ tool_input: { command: cmd }, session_id: 's-7888', transcript_path: tr, tool_use_id: 'tu1' }), encoding: 'utf8', env: cleanEnv({ HOME: fx.home, CLAUDE_LOG_DIR: fx.logs, ...env }), timeout: 120_000 });
  if (r.error) throw r.error;
  return r;
}
const LIVE = { skip: SKIP_TS || (spawnSync('sh', ['-c', 'command -v jq && command -v timeout'], { encoding: 'utf8' }).status !== 0 && 'jq/timeout missing') };

test('hook: fix-only diff + passing current verdict exits 0 with no owner yes, and logs it', LIVE, (t) => {
  const fx = fixture(t, [[FILE, FIX_SRC]]); verdict(fx);
  const r = runHook(fx);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(fx.logs, 'visual-gate-bypass.log'), 'utf8'), /fix-only-self-clear/);
});
test('hook: a design diff still blocks even with a passing verdict', LIVE, (t) => {
  const fx = fixture(t, [[FILE, DESIGN_SRC]]); verdict(fx);
  const r = runHook(fx);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /Design change|owner has not approved/);
});
test('hook: a mix of fix and design files blocks', LIVE, (t) => {
  const fx = fixture(t, [[FILE, FIX_SRC], [MIX_FILE2, BAR_BASE.replace('m-2', 'm-4')]]); verdict(fx);
  assert.equal(runHook(fx).status, 2);
});
test('hook: the kill switch restores the block for a fix-only diff', LIVE, (t) => {
  const fx = fixture(t, [[FILE, FIX_SRC]]); verdict(fx);
  assert.equal(runHook(fx, { env: { VISUAL_FIX_SELF_CLEAR_DISABLED: '1' } }).status, 2);
});
test('hook: fix-only but a failed, stale or old-schema verdict still blocks', LIVE, (t) => {
  for (const over of [{ overallPass: false }, { uiPatchId: 'deadbeef' }, { schemaVersion: 1 }]) {
    const fx = fixture(t, [[FILE, FIX_SRC]]); verdict(fx, over);
    assert.equal(runHook(fx).status, 2, JSON.stringify(over));
  }
});
test('hook: a fix-only diff with no verdict yet is told not to ask the owner', LIVE, (t) => {
  const fx = fixture(t, [[FILE, FIX_SRC]]);
  const r = runHook(fx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /do NOT ask the owner/);
});
test('RED control: with the self-clear block cut out of the hook, the fix-only case is blocked', LIVE, (t) => {
  const src = readFileSync(HOOK, 'utf8');
  const cut = src.replace(/# >>> BRO-7888 self-clear[\s\S]*?# <<< BRO-7888 self-clear\n/, '');
  assert.notEqual(cut, src, 'markers not found: the block cannot be cut');
  const fx = fixture(t, [[FILE, FIX_SRC]]); verdict(fx);
  const reverted = join(fx.root, 'reverted-hook.sh'); writeFileSync(reverted, cut);
  assert.equal(runHook(fx, { hook: reverted }).status, 2);
  assert.equal(runHook(fx).status, 0); // and the real hook passes the same fixture
});
