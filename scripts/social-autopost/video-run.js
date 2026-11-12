#!/usr/bin/env node
/**
 * Automatic TikTok + YouTube Shorts (BRO-7414). One video per qualifying show event, at most one per network per New
 * York day, posted through Buffer and read back until Buffer says sent.
 *
 *   node scripts/social-autopost/video-run.js                 dry run: lists what is due, renders and posts nothing
 *   node scripts/social-autopost/video-run.js --report-days=21 dry run over the last 3 weeks: what would have posted
 *   node scripts/social-autopost/video-run.js --live           make and post the due video (needs BUFFER_API_KEY)
 *   --verify      read earlier posts back from Buffer and record sent/failed (cheap; no rendering)
 *   --check       print due=0|1 to $GITHUB_OUTPUT so the workflow can skip rendering setup
 *   --self-test   make the due video, save it as a Buffer DRAFT on each channel, delete the drafts (nothing is published or recorded)
 *   --live-limit=N (default 1)   --show=ID [--fmt=compare] (dry run only)   --cancel-queued   --now=ISO   --out=DIR
 *
 * Kill switch: SOCIAL_VIDEO_DISABLED=true. Selection is video-select.js (reuses select.js decisions). The voice is
 * scripts/video-proto/tts.js, the picture is scripts/video-proto/render.js per channel, captions are channel-captions.js
 * as they are (BRO-7244 owner test). Ledger: data/social-video-ledger.json.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const C = require('./config');
const S = require('./select');
const V = require('./video-select');
const buffer = require('./buffer');
const { hostVideo } = require('./host');

const ROOT = path.resolve(__dirname, '..', '..');
const PROTO = path.join(ROOT, 'scripts', 'video-proto');
const LEDGER_FILE = path.join(ROOT, 'data', 'social-video-ledger.json');
const HISTORY_FILE = path.join(ROOT, 'data', 'social-video-phrases.json');
const MAX_LEDGER = 300;
const VERIFY_AFTER_MS = 20 * 60e3; // read a post back this long after it was due
const VERIFY_WINDOW_MS = 3 * 864e5;
const MIN_QUOTA = 12; // Buffer requests needed for one video (channels, 2 listings, 2 posts) plus margin

const args = process.argv.slice(2);
const arg = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = name => args.includes(`--${name}`);

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const log = m => console.log(`[video] ${m}`);

function loadLedger() {
  const l = readJson(LEDGER_FILE, null) || {};
  return { _meta: { description: 'Social video lane: one entry per show video (scripts/social-autopost/video-run.js)', ...(l._meta || {}) }, posts: l.posts || [], failures: l.failures || [] };
}

function writeLedger(ledger) {
  ledger.posts = ledger.posts.slice(-MAX_LEDGER);
  ledger.failures = ledger.failures.slice(-MAX_LEDGER);
  ledger._meta = { ...ledger._meta, lastUpdated: new Date().toISOString() };
  fs.writeFileSync(LEDGER_FILE, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Pure: the Buffer title of a video (YouTube allows 100 characters). */
function videoTitle(plan, show, score) {
  const t = plan.fmt === 'compare' ? `${show.title}: same show, two cities` : `${show.title}: Critic Score ${score}/100`;
  return t.length <= 100 ? t : `${t.slice(0, 97).trimEnd()}...`;
}

const COMPARE_CAPTION = /same show, two cities/i; // the compare template's opening line (scripts/video-proto/compare-script.js)

/**
 * Pure: text a duplicate guard looks for in an existing post: the show title and the score in any caption. A show gets a score
 * video and a compare video with the same title and score, so the guard also tells the two formats apart (BRO-7418).
 */
function duplicateMarker(title, score, fmt = 'reveal') {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); // punctuation folds too: London "Ghost – The Musical" vs NY "Ghost The Musical" is one show
  const t = norm(title), sc = String(score);
  return text => { const x = norm(text); return x.includes(t) && new RegExp(`(^|[^0-9])${sc}([^0-9]|$)`).test(x) && COMPARE_CAPTION.test(String(text)) === (fmt === 'compare'); };
}

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: opts.cwd || PROTO, env: { ...process.env, ...(opts.env || {}) }, encoding: 'utf8', maxBuffer: 64 << 20, timeout: opts.timeout || 20 * 60e3 });
  if (r.status !== 0) throw new Error(`${path.basename(cmdArgs[0])} failed (${r.status}${r.signal ? ' ' + r.signal : ''}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-4).join(' | ').slice(0, 500)}`);
  return r.stdout;
}

const planName = ev => (ev.fmt === 'compare' ? 'compare' : 'reveal');

/** A skip is not a failure: the event waits out the day and is tried again (no poster yet, no audience grade yet). */
function skipError(msg) { const err = new Error(msg); err.skip = true; return err; }

/** Plan, voice and render one event for each target network. Returns { plan, planFile, files: {network: mp4 path} }. */
function makeVideo(ev, targets, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const id = ev.show.id, name = planName(ev), planFile = path.join(outDir, `${name}.plan.json`);
  if (ev.fmt !== 'reveal' && ev.fmt !== 'compare') throw new Error(`video format ${ev.fmt} is not wired into the live path`);
  if (ev.fmt === 'compare') {
    // portrait posters of both productions (the compare card's art rule); no usable poster means no video (owner rule 2026-10-26), tried again tomorrow
    const art = run('node', ['fetch-art.js', '--poster', id, ev.london.id]);
    const held = art.split('\n').find(l => /HELD|UNKNOWN SHOW/.test(l));
    if (held) throw skipError(`no usable poster: ${held.slice(0, 160)}`);
    // the fixed compare template, copy-reviewed (up to 3 tries); a blocked script exits non-zero and the event waits
    run('node', ['compare-make.js', id, ev.london.id, outDir, name]);
  } else {
    run('node', ['fetch-art.js', id]);
    // the two-model copy review runs inside voscript; a blocked script exits non-zero and the event waits
    try { run('node', ['voscript.js', 'reveal', id, outDir, name], { env: { VO_REVIEW: '1', VO_HISTORY: HISTORY_FILE } }); } catch (e) {
      if (/no audience grade/.test(e.message)) throw skipError('no audience grade yet');
      throw e;
    }
  }
  const plan = readJson(planFile, null);
  if (!plan || !plan.review || !plan.review.pass) throw new Error('plan did not pass copy review');
  run('node', ['tts.js', planFile, outDir, name]);
  const comp = ev.fmt === 'compare' ? 'compare' : 'reveal-voiced', files = {};
  for (const n of targets) {
    run('node', ['render.js', comp, outDir, `--channel=${n}`], { env: { VO_DIR: outDir, VO_NAME: name, ...(ev.fmt === 'reveal' ? { VO_OFF: '0.15' } : {}), VO_FUZZY_CUES: '1' }, timeout: 25 * 60e3 });
    const f = path.join(outDir, `${comp}-${n}.mp4`);
    if (!fs.existsSync(f)) throw new Error(`render produced no ${f}`);
    files[n] = f;
  }
  return { plan, planFile, files };
}

function captionFor(planFile, network) {
  return run('node', ['channel-captions.js', planFile, network]).replace(/\n+$/, '');
}

/** Channels for the video networks: pinned ids, and not locked, disconnected or paused. Throws with the reason otherwise. */
async function videoChannels(targets) {
  const all = await buffer.listChannels();
  const out = {};
  for (const n of targets) {
    const ch = all.find(c => c.id === C.VIDEO.channels[n]);
    if (!ch) throw new Error(`${n}: pinned Buffer channel ${C.VIDEO.channels[n]} not found`);
    if (ch.network !== n) throw new Error(`${n}: channel ${ch.id} is a ${ch.service} channel, not ${n}`);
    const bad = [ch.isLocked && 'locked (Buffer plan)', ch.isDisconnected && 'disconnected', ch.isQueuePaused && 'queue paused'].filter(Boolean);
    if (bad.length) throw new Error(`${n}: Buffer channel is ${bad.join(', ')}`);
    out[n] = ch;
  }
  return out;
}

/** Read earlier posts back from Buffer: status, link and error. */
async function verifySent(ledger, now) {
  let changed = 0;
  for (const p of ledger.posts) {
    if (now - Date.parse(p.dueAt) > VERIFY_WINDOW_MS || now - Date.parse(p.dueAt) < VERIFY_AFTER_MS) continue;
    for (const [n, c] of Object.entries(p.channels || {})) {
      if (!c || !c.postId || c.result === 'sent' || c.result === 'cancelled') continue;
      const post = await buffer.getPost(c.postId);
      if (!post) { c.result = 'gone'; changed++; continue; }
      if (post.status === 'sent') { c.result = 'sent'; c.externalLink = post.externalLink || null; c.sentAt = post.sentAt || null; changed++; log(`${p.showId} on ${n} is sent: ${c.externalLink || 'no link yet'}`); }
      else if (post.status === 'error') { c.result = 'error'; c.error = (post.error && post.error.message) || 'unknown'; c.failedPostId = c.postId; delete c.postId; changed++; /* frees the network so the show can be retried within the attempt limits */ ledger.failures.push({ key: `${p.type}:${p.showId}`, at: new Date(now).toISOString(), error: `${n}: Buffer rejected the post: ${c.error}`.slice(0, 400) }); log(`::warning::${p.showId} on ${n} failed in Buffer: ${c.error}`); }
    }
  }
  return changed;
}

/** What the lane would have posted on each of the last `days` days, using today's data (a dry run for the owner). */
function lookbackReport(ctx, now, days) {
  const sim = { posts: [], failures: [] }, rows = [];
  for (let d = days; d >= 0; d--) {
    const t = now - d * 864e5;
    const { events } = V.findVideoEvents({ shows: ctx.shows, textLedger: ctx.ledger, videoLedger: sim, now: t, reviewsByShow: ctx.reviewsByShow, slim: ctx.slim, getOutletTier: ctx.getOutletTier });
    const { pick } = V.pickToday(events, sim, t);
    if (!pick) continue;
    const entry = { type: pick.type, showId: pick.show.id, createdAt: new Date(t).toISOString(), dueAt: new Date(t).toISOString(), channels: Object.fromEntries(pick.targets.map(n => [n, { postId: 'sim', createdAt: new Date(t).toISOString() }])) };
    const row = sim.posts.find(p => p.type === entry.type && p.showId === entry.showId);
    if (row) Object.assign(row.channels, entry.channels); else sim.posts.push(entry);
    rows.push({ day: V.nyDay(t), fmt: pick.fmt, id: pick.show.id, title: pick.show.title, category: pick.show.category, targets: pick.targets });
  }
  return rows;
}

async function main() {
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const selfTest = flag('self-test');
  const live = (flag('live') || selfTest) && !flag('dry-run');
  if (process.env.SOCIAL_VIDEO_DISABLED === 'true' && !flag('cancel-queued')) { log('disabled by SOCIAL_VIDEO_DISABLED'); return; }
  if (live && !process.env.BUFFER_API_KEY) throw new Error('--live needs BUFFER_API_KEY (refusing to run without it)');
  const outDir = arg('out') || path.join(require('os').tmpdir(), 'social-video');
  const { loadContext } = require('./run.js');
  const ctx = loadContext();
  const ledger = loadLedger();

  if (flag('cancel-queued')) {
    let n = 0;
    for (const p of ledger.posts) for (const [net, c] of Object.entries(p.channels || {})) {
      if (!c || !c.postId || c.result) continue;
      const post = await buffer.getPost(c.postId);
      if (post && (post.status === 'sent' || post.status === 'sending')) { c.result = post.status; continue; }
      if (post) await buffer.deletePost(c.postId);
      c.result = 'cancelled'; n++; log(`cancelled ${p.showId} on ${net} (${c.postId})`);
    }
    writeLedger(ledger); log(`cancelled ${n} queued post(s)`); return;
  }

  if (process.env.BUFFER_API_KEY && !flag('dry-run') && !flag('check')) { const n = await verifySent(ledger, now); if (n) writeLedger(ledger); }
  if (flag('verify')) { if (!process.env.BUFFER_API_KEY) throw new Error('--verify needs BUFFER_API_KEY'); return; }

  const days = arg('report-days');
  if (days) {
    const rows = lookbackReport(ctx, now, +days);
    log(`dry run over the last ${days} days (today's scores, the text ledger's sent score posts): ${rows.length} video day(s)`);
    for (const r of rows) console.log(`  ${r.day}  ${r.fmt.padEnd(7)} ${r.category.padEnd(12)} ${r.title} (${r.id}) -> ${r.targets.join(', ')}`);
    return;
  }

  let found;
  if (arg('show')) {
    if (live) throw new Error('--show is for previews; drop --live');
    const show = ctx.shows.find(s => s.id === arg('show'));
    if (!show) throw new Error(`--show=${arg('show')}: not in shows.json`);
    let ev = { type: 'score', fmt: 'reveal', show, slot: now };
    if (arg('fmt') === 'compare') {
      const { london, reason } = require('../lib/transfer-detection').findLondonRun(show, ctx.shows, { hasScore: id => S.hasSiteScore(ctx.slim, id) });
      if (!london) throw new Error(`--show=${show.id} --fmt=compare: no London pair (${reason})`);
      ev = { type: 'london-compare', fmt: 'compare', show, london, slot: now };
    }
    found = { events: [ev], skipped: [] };
  } else {
    found = V.findVideoEvents({ shows: ctx.shows, textLedger: ctx.ledger, videoLedger: ledger, now, reviewsByShow: ctx.reviewsByShow, slim: ctx.slim, getOutletTier: ctx.getOutletTier });
  }
  const reasons = {}; for (const s of found.skipped) reasons[s.why] = (reasons[s.why] || 0) + 1;
  log(`due now: ${found.events.length}; not due: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  for (const e of found.events.slice(0, 10)) log(`  ${e.fmt}: ${e.show.title} (${e.show.id}), slot ${new Date(e.slot).toISOString().slice(0, 10)}`);
  const { pick, why } = V.pickToday(found.events, ledger, now);
  if (flag('check')) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${pick ? 1 : 0}\n`); log(pick ? `due: ${pick.show.id}` : `nothing due: ${why}`); return; }
  if (!pick) { log(`nothing to post: ${why}`); return; }
  log(`${live ? 'making' : 'would make'} ${pick.fmt} video for ${pick.show.title} -> ${pick.targets.join(', ')}`);
  if (!live) return;

  const limit = Math.max(1, +(arg('live-limit') || 1));
  // live_limit bounds the events made in one run; the one-per-network-per-day cadence already caps what posts
  let ev = pick;
  if (selfTest) return selfTestEvent(ev, outDir, now, ctx);
  for (let i = 0; i < limit && ev; i++) {
    await postEvent(ev, ledger, outDir, now, ctx);
    ev = V.pickToday(V.findVideoEvents({ shows: ctx.shows, textLedger: ctx.ledger, videoLedger: ledger, now, reviewsByShow: ctx.reviewsByShow, slim: ctx.slim, getOutletTier: ctx.getOutletTier }).events, ledger, now).pick;
  }
}

/** Full pipeline for one event with Buffer drafts instead of posts: proves render, hosting and each channel's metadata. */
async function selfTestEvent(ev, outDir, now, ctx) {
  const dir = path.join(outDir, `${ev.show.id}-${ev.fmt}`);
  const made = makeVideo(ev, ev.targets, dir);
  if (!ctx.slim[ev.show.id]) throw new Error(`no site score for ${ev.show.id}`);
  const channels = await videoChannels(ev.targets);
  const score = Math.round(ctx.slim[ev.show.id].cs), title = videoTitle(made.plan, ev.show, score);
  for (const n of ev.targets) {
    const url = await hostVideo(fs.readFileSync(made.files[n]), `selftest/${ev.show.id}-${ev.fmt}-${n}.mp4`);
    const text = captionFor(made.planFile, n);
    const post = await buffer.createVideoPost({ channel: channels[n], text, videoUrl: url, title, thumbnailOffsetMs: C.VIDEO.thumbnailOffsetMs, dueAt: new Date(now + 864e5), draft: true });
    log(`${n}: draft ${post.id} accepted (${post.status}); title "${title}"; caption ${text.length} chars`);
    await buffer.deletePost(post.id); log(`${n}: draft deleted`);
  }
}

/** Any throw outside the per-network try (channel lookup, missing slim entry) is still a recorded failure, so the retry limits hold. */
async function postEvent(ev, ledger, outDir, now, ctx) {
  try { await postEventInner(ev, ledger, outDir, now, ctx); } catch (e) {
    ledger.failures.push({ key: V.keyOf(ev), at: new Date(now).toISOString(), error: String(e.message).slice(0, 400) });
    writeLedger(ledger); log(`::error::${ev.show.title}: ${e.message}`); process.exitCode = 1;
  }
}

async function postEventInner(ev, ledger, outDir, now, ctx) {
  const key = V.keyOf(ev);
  if (!ctx.slim[ev.show.id]) throw new Error(`no site score for ${ev.show.id}`);
  const dir = path.join(outDir, `${ev.show.id}-${ev.fmt}`);
  let made;
  try {
    made = makeVideo(ev, ev.targets, dir);
  } catch (e) {
    if (e.skip) { ledger.failures.push({ key, at: new Date(now).toISOString(), kind: 'skip', error: String(e.message).slice(0, 200) }); writeLedger(ledger); log(`skipped ${ev.show.title}: ${e.message}`); return; }
    ledger.failures.push({ key, at: new Date(now).toISOString(), error: String(e.message).slice(0, 400) });
    writeLedger(ledger); log(`::error::${ev.show.title}: ${e.message}`); process.exitCode = 1; return;
  }
  const channels = await videoChannels(ev.targets);
  const score = Math.round(ctx.slim[ev.show.id].cs); // the site's own number, the one the script says
  const title = videoTitle(made.plan, ev.show, score);
  const isDup = duplicateMarker(ev.show.title, score, ev.fmt);
  let row = ledger.posts.find(p => p.type === ev.type && p.showId === ev.show.id && !V.entryDone(p));
  if (!row) { row = { type: ev.type, fmt: ev.fmt, showId: ev.show.id, title: ev.show.title, score, createdAt: new Date(now).toISOString(), dueAt: null, channels: {} }; ledger.posts.push(row); }
  const planFile = made.planFile;
  const year = new Date(now).getUTCFullYear(), month = String(new Date(now).getUTCMonth() + 1).padStart(2, '0');
  for (const n of ev.targets) {
    try {
      const ch = channels[n];
      const q = buffer.quotaProblem(buffer.rateLimit(), MIN_QUOTA); if (q) throw new Error(q);
      const existing = (await buffer.listChannelPostsAll({ channel: ch })).find(p => isDup(p.text));
      if (existing) { row.channels[n] = { postId: existing.id, createdAt: new Date(now).toISOString(), result: existing.status === 'sent' ? 'sent' : undefined, note: 'already on the channel' }; log(`${n}: already posted (${existing.id}), not posting again`); continue; }
      const url = await hostVideo(fs.readFileSync(made.files[n]), `${year}/${month}/${ev.show.id}-${ev.fmt}-${n}.mp4`);
      const dueAt = new Date(S.nextWindowSlot(now + 10 * 60e3, C.MARKETS[ev.show.category].tz));
      const post = await buffer.createVideoPost({ channel: ch, text: captionFor(planFile, n), videoUrl: url, title, thumbnailOffsetMs: C.VIDEO.thumbnailOffsetMs, dueAt });
      row.channels[n] = { postId: post.id, url, createdAt: new Date(now).toISOString() };
      row.dueAt = row.dueAt && Date.parse(row.dueAt) > dueAt.getTime() ? row.dueAt : dueAt.toISOString();
      writeLedger(ledger); // checkpoint: a later failure must not forget this post
      log(`${n}: scheduled ${post.id} for ${dueAt.toISOString()} (${url})`);
    } catch (e) {
      ledger.failures.push({ key, at: new Date(now).toISOString(), error: `${n}: ${String(e.message).slice(0, 380)}` });
      log(`::error::${ev.show.title} on ${n}: ${e.message}`); process.exitCode = 1;
    }
  }
  if (!row.dueAt) row.dueAt = new Date(now).toISOString();
  writeLedger(ledger);
}

module.exports = { makeVideo, videoTitle, duplicateMarker, lookbackReport, verifySent, loadLedger, LEDGER_FILE };

if (require.main === module) main().catch(e => { console.error(`[video] ${e.message}`); process.exit(1); });
