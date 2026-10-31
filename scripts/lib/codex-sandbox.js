'use strict';
/**
 * Run code from a Codex-written tree as a separate OS user that holds no runner secrets (BRO-5649).
 *
 * A scrubbed env is not enough: a child running as the runner's own uid reads the runner's
 * secrets (ANTHROPIC_API_KEY, the push PAT, GH_TOKEN, LINEAR_API_KEY) from /proc/<ppid>/environ
 * (proven 2026-10-18). So the tree's tests, its test collector and the land preflight run as a
 * per-slot user under `env -i`, with their own HOME/TMPDIR and git config, holding no key. The
 * Claude reviewer runs as that user too, but with no tool that runs code, so the Claude auth it
 * needs (through a 0600 file, never argv: every process's cmdline is world-readable) is never
 * reachable from the tree's code.
 *
 * Callers fail closed: ensure() says why the sandbox cannot run, and the runner then refuses to
 * judge the change rather than judging it unsandboxed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const JSON_MARK = '@@SANDBOX_JSON@@';
// Non-secret vars a test run may read. Everything else (keys, tokens, the runner's HOME) stays out.
// No proxy vars: a cloud container's egress proxy adds GitHub auth, so ensure() also firewalls it.
const PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'CI', 'GITHUB_ACTIONS', 'TERM'];
// CA bundles the runner may point at (cloud keeps its proxy CA under /root, which the sandbox cannot read).
const CA_ENV = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
const PUSH_BLOCK = 'https://push-blocked.invalid/';
const PUSH_PREFIXES = ['https://github.com/', 'http://github.com/', 'git@github.com:', 'ssh://git@github.com/'];
// Runs inside the sandbox: loads the secrets file (then deletes it) and runs the real command.
const SECRET_LAUNCHER = [
  "const fs=require('fs');const f=process.env.SANDBOX_SECRET_FILE;delete process.env.SANDBOX_SECRET_FILE;",
  "Object.assign(process.env,JSON.parse(fs.readFileSync(f,'utf8')));fs.rmSync(f,{force:true});",
  "const r=require('child_process').spawnSync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});",
  'process.exit(r.status==null?1:r.status);',
].join('');

/** One sandbox user per runner slot, so one slot's cleanup never kills a sibling's step. */
const sandboxUser = (slot = 0) => `codexsb${Number(slot) || 0}`;

/** The sandbox's whole environment: PASS_ENV from `env`, its own HOME/TMPDIR, isolated git config. */
function sandboxEnv(env, { home, extra = {} }) {
  const out = {};
  for (const k of PASS_ENV) if (typeof env[k] === 'string') out[k] = env[k];
  Object.assign(out, {
    HOME: home, TMPDIR: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    // GIT_CONFIG_GLOBAL drops the runner's identity; tests that commit in temp repos need one.
    GIT_AUTHOR_NAME: 'codex-sandbox', GIT_AUTHOR_EMAIL: 'codex-sandbox@invalid',
    GIT_COMMITTER_NAME: 'codex-sandbox', GIT_COMMITTER_EMAIL: 'codex-sandbox@invalid',
  });
  const cfg = [['safe.directory', '*'], ['core.hooksPath', '/dev/null'], ...PUSH_PREFIXES.map((p) => [`url.${PUSH_BLOCK}.pushInsteadOf`, p])];
  cfg.forEach(([k, v], i) => { out[`GIT_CONFIG_KEY_${i}`] = k; out[`GIT_CONFIG_VALUE_${i}`] = v; });
  out.GIT_CONFIG_COUNT = String(cfg.length);
  return { ...out, ...extra };
}

/** argv running `cmd args` as `user` with exactly `env`: runuser when root (no sudo PAM/pty), else sudo -n. */
function sandboxArgv(user, cmd, args, env, { root = process.getuid && process.getuid() === 0 } = {}) {
  const as = root ? ['runuser', '-u', user, '--'] : ['sudo', '-n', '-u', user, '--'];
  return [...as, '/usr/bin/env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), cmd, ...args];
}

/** The last `JSON_MARK<json>` line of sandboxed output, parsed; null when there is none. */
function parseMarked(out) {
  const line = String(out || '').split('\n').reverse().find((l) => l.startsWith(JSON_MARK));
  if (!line) return null;
  try { return JSON.parse(line.slice(JSON_MARK.length)); } catch { return null; }
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  return { code: r.status == null ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}`, stdout: r.stdout || '' };
};
const isRoot = () => Boolean(process.getuid && process.getuid() === 0);
/** As root: directly when this process is root, else through passwordless sudo. */
const asRoot = (cmd, args, opts) => (isRoot() ? run(cmd, args, opts) : run('sudo', ['-n', cmd, ...args], opts));
// The state follows the LAST ')': the command name before it is the sandbox's to choose.
const isZombie = (pid) => { try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st[st.lastIndexOf(')') + 2] === 'Z'; } catch { return true; } };
/** The loopback port of the egress proxy the runner was given, or null (GitHub runners have none). */
function loopbackProxyPort(env) {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    try {
      const u = new URL(env[k]);
      if (/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(u.hostname)) return Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch { /* unset or not a URL */ }
  }
  return null;
}
/**
 * A file the sandbox wrote, read by the runner: a regular file only (O_NOFOLLOW, fstat), at most
 * `max` bytes, so a planted symlink to /proc/self/environ or a runner file reads as null.
 */
function readSandboxFile(p, max = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max);
    return buf.subarray(0, fs.readSync(fd, buf, 0, max, 0)).toString('utf8');
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
const short = (s) => String(s || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);

// Proves the isolation on every run: the sandbox must not read this process's environ.
// and, with a proxy port, must not connect to it.
const PROBE = "let s='';try{s=require('fs').readFileSync('/proc/'+process.argv[1]+'/environ','utf8')}catch(e){s=e.code}const port=Number(process.argv[2]);const done=(ok)=>console.log(s==='EACCES'&&ok?'isolated':'LEAK');if(!port)done(true);else{const c=require('net').connect(port,'127.0.0.1');c.setTimeout(5000);c.on('connect',()=>{c.destroy();done(false)});c.on('error',()=>done(true));c.on('timeout',()=>{c.destroy();done(true)})}";

/**
 * A sandbox for one runner slot. `root` is the checkout the sandbox must be able to reach.
 * -> { user, ensure, withTrees, dropStale, remove, run, runMarked }
 */
function createSandbox({ user, root }) {
  let ready = null;
  // kill -1 as the sandbox signals all of its processes in one call; repeat for any forked
  // meanwhile, and throw rather than hand a tree back while one still runs.
  const kill = () => {
    for (let i = 0; i < 50; i++) {
      const [bin, ...rest] = sandboxArgv(user, 'kill', ['-KILL', '-1'], { PATH: '/usr/bin:/bin' });
      run(bin, rest);
      if (run('pgrep', ['-u', user]).stdout.split('\n').filter(Boolean).every(isZombie)) return;
    }
    throw new Error(`a ${user} process survived 50 kill passes`);
  };

  /** Create the user if needed and prove the isolation. -> { ok: true } | { ok: false, why }. Cached once ok. */
  function ensure() {
    if (ready && ready.ok) return ready;
    if (process.platform !== 'linux') return (ready = { ok: false, why: `the test sandbox needs Linux (this is ${process.platform})` });
    // withTrees chowns the tree back with -R: without this a hardlink the sandbox made to a runner
    // file would be chowned with it.
    let hard = '';
    try { hard = fs.readFileSync('/proc/sys/fs/protected_hardlinks', 'utf8').trim(); } catch { /* checked below */ }
    if (hard !== '1') return (ready = { ok: false, why: `the test sandbox needs fs.protected_hardlinks=1 (it is ${hard || 'unreadable'})` });
    if (run('id', ['-u', user]).code !== 0) {
      const r = asRoot('useradd', ['--system', '--no-create-home', '--shell', '/usr/sbin/nologin', user]);
      if (r.code !== 0 && run('id', ['-u', user]).code !== 0) return (ready = { ok: false, why: `could not create user ${user}: ${short(r.out)}` });
    }
    // The sandbox must reach the checkout (GitHub's /home/runner is 750): traverse only, no listing.
    for (let d = path.resolve(root); ; d = path.dirname(d)) {
      try { if ((fs.statSync(d).mode & 0o001) === 0) asRoot('chmod', ['o+x', d]); } catch { /* the probe below decides */ }
      if (path.dirname(d) === d) break;
    }
    // The egress proxy (cloud) authenticates GitHub for whoever connects: refuse the sandbox uid.
    const port = loopbackProxyPort(process.env);
    if (port) {
      const rule = ['OUTPUT', '-p', 'tcp', '-d', '127.0.0.0/8', '--dport', String(port), '-m', 'owner', '--uid-owner', user, '-j', 'REJECT'];
      if (asRoot('iptables', ['-C', ...rule]).code !== 0) {
        const r = asRoot('iptables', ['-I', ...rule]);
        if (r.code !== 0) return (ready = { ok: false, why: `could not firewall the egress proxy from ${user}: ${short(r.out)}` });
      }
    }
    const probe = runIn(root, 'node', ['-e', PROBE, String(process.pid), String(port || 0)], { timeoutMs: 60_000 });
    if (probe.code !== 0) return (ready = { ok: false, why: `cannot run node as ${user}: ${short(probe.out)}` });
    if (!/^isolated$/m.test(probe.stdout)) return (ready = { ok: false, why: `${user} can read the runner's environment` });
    return (ready = { ok: true });
  }

  /**
   * Run `fn` with `dirs` owned by the sandbox, then take them back. Each dir's `.git` pointer is
   * restored afterwards: a sandbox owning the tree could aim it at a git config whose fsmonitor
   * or filters would run as the runner on its next git command. -h: symlinks (node_modules ->
   * the runner's copy, data links) are not followed, so the sandbox never owns what they point at.
   */
  function withTrees(dirs, fn) {
    const live = dirs.filter((d) => d && fs.existsSync(d));
    const pointers = live.map((d) => { const p = path.join(d, '.git'); try { return fs.lstatSync(p).isFile() ? [p, fs.readFileSync(p, 'utf8')] : null; } catch { return null; } }).filter(Boolean);
    try {
      for (const d of live) {
        const r = asRoot('chown', ['-R', '-h', `${user}:`, d]);
        if (r.code !== 0) throw new Error(`could not hand ${d} to the test sandbox: ${short(r.out)}`);
      }
      return fn();
    } finally {
      let failed = null;
      try { kill(); } catch (e) { failed = e; }
      // Every dir is taken back and its pointer restored even when one fails; dropStale removes
      // a tree left sandbox-owned or with a pointer it did not write on the next run.
      for (const d of live) {
        const r = asRoot('chown', ['-R', '-h', `${process.getuid()}:${process.getgid()}`, d]);
        if (r.code !== 0) failed = failed || new Error(`could not take ${d} back from the test sandbox: ${short(r.out)}`);
        // chown keeps modes: a file the sandbox made 0666 would stay writable to it.
        else if (asRoot('chmod', ['-R', 'go-w', d]).code !== 0) failed = failed || new Error(`could not drop the sandbox's write bits in ${d}`);
        for (const [p, text] of pointers.filter(([p]) => path.dirname(p) === d)) {
          try { fs.rmSync(p, { recursive: true, force: true }); fs.writeFileSync(p, text); } catch (e) { failed = failed || e; }
        }
      }
      if (failed) throw failed; // eslint-disable-line no-unsafe-finally -- a tree the runner cannot trust beats fn's own error
    }
  }

  /**
   * Run `cmd args` in `cwd` as the sandbox. -> { code, out, stdout } (the runner's sh() shape).
   * `env` adds non-secret vars; `secretEnv` goes through a 0600 file the launcher deletes.
   * Each run gets its own HOME, removed (as root: the sandbox owns it) with anything it started.
   */
  function runIn(cwd, cmd, args, { timeoutMs = 600_000, input, env = {}, secretEnv = null } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `codex-sandbox-${user}-`));
    try {
      fs.chmodSync(home, 0o700);
      let argv = [cmd, ...args];
      const extra = { ...env };
      for (const k of CA_ENV) {
        if (!process.env[k]) continue;
        const f = path.join(home, `${k.toLowerCase()}.pem`);
        try { fs.copyFileSync(process.env[k], f); extra[k] = f; } catch { /* the runner cannot read it either */ }
      }
      if (secretEnv && Object.keys(secretEnv).length) {
        const f = path.join(home, '.secret-env.json');
        fs.writeFileSync(f, JSON.stringify(secretEnv), { mode: 0o600 });
        extra.SANDBOX_SECRET_FILE = f;
        argv = ['node', '-e', SECRET_LAUNCHER, ...argv];
      }
      const own = asRoot('chown', ['-R', `${user}:`, home]);
      if (own.code !== 0) return { code: -1, out: `could not prepare the sandbox home: ${short(own.out)}`, stdout: '' };
      const [bin, ...rest] = sandboxArgv(user, argv[0], argv.slice(1), sandboxEnv(process.env, { home, extra }));
      return run(bin, rest, { cwd, timeout: timeoutMs, input: input ?? '' });
    } finally {
      kill();
      asRoot('rm', ['-rf', '--', home]);
    }
  }

  /** runIn for a node one-liner that prints `JSON_MARK<json>`. -> { value, out } (value null on any failure). */
  function runMarked(cwd, code, args = [], opts = {}) {
    const r = runIn(cwd, 'node', ['-e', code, ...args], opts);
    return { value: r.code === 0 ? parseMarked(r.stdout) : null, out: r.out, code: r.code };
  }

  /**
   * Remove `dir` when a run that died inside withTrees left it owned by the sandbox, or its `.git`
   * is not a pointer into `gitCommon`/worktrees: the runner's next git command there would read
   * a config the sandbox chose. The caller recreates the tree. -> true when removed.
   */
  function dropStale(dir, { gitCommon } = {}) {
    let st;
    try { st = fs.lstatSync(dir); } catch { return false; }
    const git = path.join(dir, '.git');
    kill(); // nothing of a dead run may change the tree while it is judged
    let foreign = st.uid !== process.getuid();
    try {
      const g = fs.lstatSync(git);
      foreign = foreign || g.uid !== process.getuid();
      if (gitCommon && !foreign) {
        const text = readSandboxFile(git, 64 * 1024);
        const m = text === null ? null : /^gitdir: (.+)\n?$/.exec(text);
        const to = m && path.resolve(dir, m[1]); // git resolves a relative pointer from the tree
        foreign = !to || path.dirname(to) !== path.join(path.resolve(gitCommon), 'worktrees');
      }
    } catch { /* no .git: the caller adds the worktree */ }
    if (!foreign) return false;
    const r = asRoot('rm', ['-rf', '--', dir]);
    if (r.code !== 0) throw new Error(`could not remove ${dir}, left by a test sandbox run that did not finish: ${short(r.out)}`);
    return true;
  }

  /** Remove a dir the sandbox may have written into (as root: the runner cannot delete its files). */
  const remove = (dir) => { asRoot('rm', ['-rf', '--', dir]); };

  return { user, ensure, withTrees, dropStale, remove, run: runIn, runMarked };
}

/**
 * land-preflight.mjs's judgeLand({ cwd, src: 'HEAD', target, fetch: false }) run in `sb`. The caller
 * fetches first. The rebase preview writes its objects to a sandbox-owned object dir, reading the
 * repo's (`objects`) through alternates, so the sandbox never writes the repo. -> { value, out }.
 */
function judgeLandSandboxed(sb, { preflight, cwd, target, objects, timeoutMs = 15 * 60_000 }) {
  const code = [
    "const fs=require('fs'),path=require('path'),os=require('os');",
    "const o=path.join(os.homedir(),'objects');fs.mkdirSync(o,{recursive:true});",
    'process.env.GIT_OBJECT_DIRECTORY=o;process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES=process.argv[3];',
    "import(process.argv[2]).then((m)=>m.judgeLand({cwd:process.argv[4],src:'HEAD',target:process.argv[5],fetch:false}))",
    `.then((v)=>console.log(${JSON.stringify(JSON_MARK)}+JSON.stringify(v)));`,
  ].join('');
  // argv[1] is a placeholder: land-preflight.mjs runs its own CLI when argv[1] names it, and realpaths it.
  return sb.runMarked(cwd, code, ['/dev/null', preflight, objects, cwd, target], { timeoutMs });
}

module.exports = { judgeLandSandboxed, JSON_MARK, PASS_ENV, loopbackProxyPort, sandboxUser, sandboxEnv, sandboxArgv, parseMarked, readSandboxFile, createSandbox };
