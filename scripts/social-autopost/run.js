#!/usr/bin/env node
/**
 * Social autopost (BRO-6242): the morning after a show's opening night, a Critic
 * Score card (design D4) goes to Instagram, Facebook, X, Threads and Bluesky through
 * Buffer. Every score is posted. Runs hourly from .github/workflows/social-autopost.yml.
 *
 *   node scripts/social-autopost/run.js                  # verify past posts, post what is due
 *   node scripts/social-autopost/run.js --check          # count due work (writes due= to GITHUB_OUTPUT)
 *   node scripts/social-autopost/run.js --dry-run        # render cards + captions only
 *   node scripts/social-autopost/run.js --dry-run --show=ID   # preview one show's card
 *   node scripts/social-autopost/run.js --list-channels  # which Buffer channels it would use
 *   node scripts/social-autopost/run.js --self-test      # draft post on every channel, then delete it
 *   node scripts/social-autopost/run.js --cancel-queued  # delete every not-yet-sent post it created
 *   node scripts/social-autopost/run.js --brief=HASH     # post an approved brief (BRO-6368, from brief.js --post)
 *
 * Options: --now=ISO (pretend time), --out=DIR (where cards are written).
 * Env: BUFFER_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
 *      (art check), SOCIAL_AUTOPOST_DISABLED=true (kill switch), SOCIAL_CHROMIUM_PATH.
 * State: data/social-autopost-ledger.json, written by this script only (one workflow,
 * one concurrency group), one entry per show score post and one per brief post.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getScoreTierId, getScoreTierLabel, getGoldThreshold } = require('../lib/score-tiers');
const { findScoreEvents, scheduleEvents, splitBacklog, isEligibleShow, morningAfter, inWindow, nextWindowSlot, zonedTime } = require('./select');
const { buildCaptions, postMarkers, compareMarkers, pathMarker, validateHook, strayNumbers, productionLabel } = require('./captions');
const { resolvePoster } = require('./art');
const { renderCard, closeBrowser } = require('./render');
const { CHANNEL_SETS, MARKETS, SCORE_LOOKBACK_DAYS } = require('./config');
const { targetSets, tagChannels, channelKey } = require('./routing');
const briefs = require('./briefs');

const ROOT = path.resolve(__dirname, '..', '..');
const LEDGER_FILE = path.join(ROOT, 'data', 'social-autopost-ledger.json');
const MAX_LEDGER = 500;
const MAX_CHANNEL_ATTEMPTS = 3;
const MAX_SHOW_ATTEMPTS = 3; // a show that fails on every network (or will not render) stops after this many runs
const RETRY_WINDOW_MS = 12 * 36e5; // a failed network is retried until 12h after the post's slot
const VERIFY_AFTER_MS = 30 * 60e3; // read a post's outcome back 30 min after it was due
const VERIFY_WINDOW_MS = 3 * 864e5;
const BRIEF_QUOTA_MARGIN = 10; // Buffer requests kept back for the hourly run and retries

const args = process.argv.slice(2);
const arg = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = name => args.includes(`--${name}`);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function loadLedger() {
  const l = readJson(LEDGER_FILE, null) || { posts: [] };
  l._meta = { description: 'Social autopost: one entry per show posted (scripts/social-autopost/run.js)', ...(l._meta || {}) };
  if (!Array.isArray(l.posts)) l.posts = [];
  return l;
}

// The ledger is a site data file (the /links bio page reads it, BRO-6377), so a
// commit to it deploys the site. Only bump lastUpdated when something else
// changed, or the hourly run would deploy every hour with nothing new.
function writeLedger(ledger, file = LEDGER_FILE) {
  ledger.posts = ledger.posts.slice(-MAX_LEDGER);
  const prev = readJson(file, null);
  const strip = (l) => JSON.stringify({ ...l, _meta: { ...((l && l._meta) || {}), lastUpdated: undefined } });
  if (prev && strip(prev) === strip(ledger)) return;
  ledger._meta = { ...(ledger._meta || {}), lastUpdated: new Date().toISOString() };
  fs.writeFileSync(file, `${JSON.stringify(ledger, null, 2)}\n`);
}

function loadContext() {
  const showsRaw = readJson(path.join(ROOT, 'data', 'shows.json'), null);
  if (!showsRaw) throw new Error('data/shows.json missing');
  const shows = Array.isArray(showsRaw) ? showsRaw : showsRaw.shows;
  const reviewsRaw = readJson(path.join(ROOT, 'data', 'reviews.json'), []);
  const reviews = Array.isArray(reviewsRaw) ? reviewsRaw : (reviewsRaw.reviews || []);
  const reviewsByShow = {};
  for (const r of reviews) (reviewsByShow[r.showId] = reviewsByShow[r.showId] || []).push(r);
  const reg = readJson(path.join(ROOT, 'data', 'outlet-registry.json'), {});
  const outlets = reg.outlets || reg;
  const getOutletTier = id => (outlets[id] && outlets[id].tier) || 3;
  const slimDir = path.join(ROOT, 'public', 'data', 'shows');
  const slim = new Proxy({}, {
    get(cache, id) {
      if (!(id in cache)) cache[id] = readJson(path.join(slimDir, `${id}.json`), null);
      return cache[id];
    },
  });
  return { shows, reviewsByShow, getOutletTier, slim, ledger: loadLedger() };
}

/**
 * Rave/Positive/Mixed/Negative counts, the same buckets as the site's breakdown bar
 * (src/components/show-cards/ScoreBreakdownBar.tsx getBreakdownTier): rounded score
 * vs the market's gold threshold, 70, 55. Takes the public show file's review
 * scores (rv[].s), the list the site's bar and review count are built from.
 */
function breakdownFor(scores, category) {
  const gold = getGoldThreshold(category);
  const b = { rave: 0, positive: 0, mixed: 0, negative: 0 };
  for (const raw of scores || []) {
    if (!Number.isFinite(raw)) continue;
    const s = Math.round(raw);
    if (s >= gold) b.rave++; else if (s >= 70) b.positive++; else if (s >= 55) b.mixed++; else b.negative++;
  }
  return b;
}

/** Everything the card and captions need for one show, read now (not when it was selected). */
function describe(show, ctx) {
  const pub = ctx.slim[show.id] || {};
  if (!Number.isFinite(pub.cs)) throw new Error(`${show.id}: no Critic Score in public/data/shows`);
  // Rounded the way the site badge shows it (scripts/lib/canonical-critic-scores.ts).
  const score = Math.round(pub.cs);
  const breakdown = breakdownFor((pub.rv || []).map(r => r.s), show.category);
  const counted = breakdown.rave + breakdown.positive + breakdown.mixed + breakdown.negative;
  // The caption says "from N critics' reviews" next to the tally: they must agree.
  if (counted !== pub.rc) throw new Error(`${show.id}: breakdown counts ${counted} reviews, the site says ${pub.rc}`);
  return { show, score, tierId: getScoreTierId(score, show.category), tierLabel: getScoreTierLabel(score, show.category), reviewCount: pub.rc, breakdown };
}

// venue-write-guard-ok: show.venue is only read here (card text / vision-check context), never written back
/**
 * Owner rule (2026-10-26): never post without the show's poster. A show with no usable
 * poster throws NO_POSTER and waits. Only the self-test (drafts, deleted) and dry-run
 * previews pass requirePoster: false to render the typographic card.
 */
async function buildCard(desc, outDir, { requirePoster = true } = {}) {
  const poster = await resolvePoster(desc.show);
  if (!poster.poster && requirePoster) {
    const err = new Error(`no usable poster (${poster.reason})`);
    err.code = 'NO_POSTER';
    throw err;
  }
  if (!poster.poster) console.log(`  [art] ${desc.show.id}: typographic poster (${poster.reason}); a live run would hold this post`);
  const card = {
    market: desc.show.category, title: desc.show.title, venue: desc.show.venue,
    score: desc.score, tierId: desc.tierId, tierLabel: desc.tierLabel, breakdown: desc.breakdown,
    poster: poster.poster ? poster : null,
  };
  const out = path.join(outDir, `${desc.show.id}.png`);
  await renderCard(card, out);
  return { path: out, poster: poster.poster ? `${poster.width}x${poster.height} ${poster.source}` : `none (${poster.reason})` };
}

async function allowedChannels(buffer) {
  const all = tagChannels(await buffer.listChannels(), CHANNEL_SETS);
  const usable = all.filter(c => c.set && c.network && !c.isQueuePaused && !c.isDisconnected && !c.isLocked);
  const missing = Object.entries(CHANNEL_SETS).flatMap(([set, ids]) => Object.entries(ids)
    .filter(([, id]) => !usable.some(c => c.id === id)).map(([svc]) => channelKey(set, svc)));
  return { usable, missing };
}

/**
 * The usable channels a brief posts to: the newer production's home set (routing.js;
 * Broadway until that market's accounts are configured). Never cross-posted.
 */
function briefChannels(channels, newer) {
  const route = targetSets(newer, null, CHANNEL_SETS);
  return channels.filter(c => route.includes(c.set));
}

/** How a ledger entry is named in messages: the show id, or brief:<hash>. */
const entryName = p => p.showId || p.id;

/** Dedupe markers for a ledger entry's captions (captions.js). */
function entryMarkers(p) {
  return p.type === 'brief' ? compareMarkers({ slug: p.slug }, p.olderLabel) : postMarkers({ id: p.showId, slug: p.slug });
}

/** Ledger entries with networks still owed a post (an earlier run's channel error). */
function pendingRetries(ledger, now) {
  return (ledger.posts || []).filter(p => p.pending && Object.keys(p.pending).length
    && (p.attempts || 1) < MAX_CHANNEL_ATTEMPTS && Date.parse(p.dueAt) > now - RETRY_WINDOW_MS);
}

/** Networks no longer retried (attempts or time used up): reported once, then dropped. */
function abandonRetries(ledger, now) {
  const problems = [];
  const owed = new Set(pendingRetries(ledger, now));
  for (const p of ledger.posts || []) {
    if (!p.pending || !Object.keys(p.pending).length || owed.has(p)) continue;
    problems.push(`${entryName(p)}: gave up on ${Object.keys(p.pending).join(', ')} after ${p.attempts || 1} attempt(s); post it by hand in Buffer if wanted`);
    p.abandoned = Object.keys(p.pending);
    delete p.pending;
    delete p.altText;
  }
  return problems;
}

/** Posts whose slot passed long enough ago to read their outcome back from Buffer. */
function postsToVerify(ledger, now) {
  const out = [];
  for (const p of ledger.posts || []) {
    const due = Date.parse(p.dueAt || '');
    if (!p.channels || !Number.isFinite(due) || now - due < VERIFY_AFTER_MS || now - due > VERIFY_WINDOW_MS) continue;
    for (const [service, c] of Object.entries(p.channels)) if (c.postId && !c.result) out.push({ entry: p, service, c });
  }
  return out;
}

/** Record whether each due post really published. Returns problems to alert on. */
async function verifySent(ledger, buffer, now) {
  const problems = [];
  for (const { entry, service, c } of postsToVerify(ledger, now)) {
    try {
      const post = await buffer.getPost(c.postId);
      if (!post) { c.result = 'missing'; problems.push(`${entryName(entry)} on ${service}: post ${c.postId} no longer exists in Buffer`); continue; }
      if (post.status === 'sent') { c.result = 'sent'; c.link = post.externalLink || null; continue; }
      if (post.status === 'error') { c.result = 'error'; problems.push(`${entryName(entry)} on ${service}: ${post.error && post.error.message || 'publishing failed'}`); continue; }
      if (now - Date.parse(entry.dueAt) > 3 * 36e5) { c.result = post.status; problems.push(`${entryName(entry)} on ${service}: still '${post.status}' 3h after it was due`); }
    } catch (e) {
      problems.push(`${entryName(entry)} on ${service}: could not read back (${e.message.slice(0, 120)})`);
    }
  }
  return problems;
}

async function retryFailedChannels(ledger, channels, buffer, now, summary) {
  let errors = 0;
  for (const entry of pendingRetries(ledger, now)) {
    const markers = entryMarkers(entry);
    const tries = Object.keys(entry.pending).filter(key => channels.some(c => c.key === key));
    if (!tries.length) continue; // the channel itself is down; allowedChannels() already reports it
    entry.attempts = (entry.attempts || 1) + 1;
    for (const service of tries) { // `service` is the ledger key (routing.js channelKey)
      const text = entry.pending[service];
      const ch = channels.find(c => c.key === service);
      try {
        const existing = await buffer.findExistingPost({ channel: ch, markers, sinceIso: new Date(now - 4 * 864e5).toISOString() });
        const post = existing || await buffer.createImagePost({ channel: ch, text, imageUrl: entry.imageUrl, altText: entry.altText || '', dueAt: new Date(Math.max(Date.parse(entry.dueAt), now + 10 * 60e3)) });
        entry.channels[service] = { postId: post.id };
        delete entry.pending[service];
        delete entry.errors[service];
        summary.push(`| ${entry.title || entryName(entry)} (retry) | ${entry.dueAt} | ${service} | - |`);
      } catch (e) {
        errors++;
        entry.errors[service] = e.message.slice(0, 300);
        console.log(`::error::retry ${entryName(entry)} on ${service} (attempt ${entry.attempts}/${MAX_CHANNEL_ATTEMPTS}): ${e.message}`);
      }
    }
    if (!Object.keys(entry.pending).length) { delete entry.pending; delete entry.altText; }
    if (entry.errors && !Object.keys(entry.errors).length) delete entry.errors;
    writeLedger(ledger);
  }
  return errors;
}

/** Host one rendered card and return its permanent public URL. */
async function hostCard(cardPath, show, now) {
  const { encodeForSocial, hostImage } = require('./host');
  const jpeg = await encodeForSocial(cardPath);
  // Content-addressed: a re-render never replaces the image under a scheduled post.
  const hash = crypto.createHash('sha1').update(jpeg.buffer).digest('hex').slice(0, 10);
  return hostImage(jpeg.buffer, `${new Date(now).toISOString().slice(0, 7)}/${show.id}-${hash}.jpg`);
}

/**
 * Create one post on every channel, or adopt the one an earlier run already made
 * (matched by `markers`). One channel's failure does not stop the others.
 * Returns {posted: {service: {postId}}, errors: {service: message}}.
 */
async function publishEvent({ channels, buffer, captions, imageUrl, markers, dueAt, label, now }) {
  const sinceIso = new Date(now - 4 * 864e5).toISOString();
  const posted = {}, errors = {};
  for (const ch of channels) {
    try {
      const existing = await buffer.findExistingPost({ channel: ch, markers, sinceIso });
      const post = existing || await buffer.createImagePost({ channel: ch, text: captions[ch.network], imageUrl, altText: captions.altText, dueAt });
      posted[ch.key] = { postId: post.id };
      console.log(`  ${existing ? '=' : '✓'} ${ch.key} ${existing ? 'already in Buffer' : 'scheduled'} (${post.id})`);
    } catch (e) {
      errors[ch.key] = e.message.slice(0, 300);
      console.log(`::error::${label} on ${ch.key}: ${e.message}`);
    }
  }
  return { posted, errors };
}

/**
 * Local days on which each show of a brief already has a post (cross-lane rule,
 * buffer.js): every post in Buffer that links the show, on any of the channels, plus
 * the day its score post is still owed (score posts win). Fails closed on a
 * listing that errors or misses posts the ledger knows about.
 */
async function briefBusyDays({ shows, channels, buffer, ledger, now }) {
  const startIso = new Date(now - 2 * 864e5).toISOString();
  const endIso = new Date(now + 16 * 864e5).toISOString();
  const lists = [];
  for (const ch of channels) {
    const posts = await buffer.listChannelPosts({ channel: ch, startIso, endIso });
    const expected = (ledger.posts || []).filter(p => p.channels && p.channels[ch.key] && p.channels[ch.key].postId
      && !['cancelled', 'missing', 'error'].includes(p.channels[ch.key].result)
      && Date.parse(p.dueAt) >= Date.parse(startIso) && Date.parse(p.dueAt) <= Date.parse(endIso)).map(p => p.channels[ch.key].postId);
    const problem = buffer.listingProblem(posts, expected);
    if (problem) throw new Error(`Buffer ${ch.key}: ${problem}; not posting the brief (fail closed)`);
    lists.push(...posts);
  }
  const done = new Set((ledger.posts || []).filter(p => p.showId).map(p => `${p.type || 'score'}:${p.showId}`));
  return shows.map(show => {
    const tz = MARKETS[show.category].tz;
    const busy = buffer.busyDays(lists, { marker: pathMarker(show), tz });
    // The ledger's own posts count too, so a partial listing cannot free a taken day.
    for (const p of ledger.posts || []) {
      const live = Object.values(p.channels || {}).some(c => c.postId && !['cancelled', 'missing', 'error'].includes(c.result));
      if (live && p.dueAt && (p.showId === show.id || (p.showIds || []).includes(show.id))) busy.add(buffer.localDay(Date.parse(p.dueAt), tz));
    }
    if (isEligibleShow(show) && !done.has(`score:${show.id}`)) {
      const slot = morningAfter(show);
      if (slot > now - SCORE_LOOKBACK_DAYS * 864e5) busy.add(buffer.localDay(slot, tz));
    }
    return { id: show.id, tz, busy };
  });
}

/** Buffer requests a brief needs: one listing page per channel, then an adopt check, a create and a read-back per target, plus a margin. */
const briefQuotaNeed = (listed, targets) => listed + 3 * targets + BRIEF_QUOTA_MARGIN;

/**
 * Post an approved brief (brief.js --post dispatches the workflow with its hash).
 * Refuses unless the stored manifest still hashes to `hash`, the owner's approval is
 * stored, every fact is unchanged, the hook and numbers pass, and neither this
 * brief nor the same pair (30 days) was posted before.
 */
async function runBrief(hash, { ctx, buffer, channels, now, summary, problems }) {
  if (!briefs.HASH_RE.test(hash)) throw new Error(`--brief=${hash}: not a brief hash (12 hex characters)`);
  const { getBriefFile } = require('./host');
  const manifest = await getBriefFile(hash, 'manifest.json');
  if (!manifest) throw new Error(`brief ${hash}: no manifest stored; run brief.js --preview first`);
  if (briefs.hashManifest(manifest) !== hash) throw new Error(`brief ${hash}: the stored manifest no longer matches its hash; refusing`);
  const approval = await getBriefFile(hash, 'approval.json');
  if (!approval || !String(approval.words || '').trim()) throw new Error(`brief ${hash}: no owner approval stored; run brief.js --post=${hash} --approved="..."`);

  const pair = briefs.pairKey(manifest.ids);
  const { sameHash, samePair } = briefs.briefConflicts(ctx.ledger, { hash, pair }, now);
  if (sameHash) { console.log(`[autopost] brief ${hash} already posted (due ${sameHash.dueAt}); nothing to do`); return; }
  if (samePair) throw new Error(`brief ${hash}: ${pair} was already posted on ${samePair.dueAt} (brief ${samePair.hash}); one post per pair in ${briefs.PAIR_DEDUPE_DAYS} days`);

  const shows = manifest.ids.map(id => ctx.shows.find(s => s.id === id));
  if (shows.some(s => !s)) throw new Error(`brief ${hash}: a show in it is no longer in shows.json`);
  const changed = briefs.factChanges(manifest.facts, briefs.factsOf(shows.map(show => describe(show, ctx))));
  if (changed.length) throw new Error(`brief ${hash}: facts changed since the preview (${changed.join('; ')}); make a new preview`);
  const hookProblem = validateHook(manifest.hook);
  if (hookProblem) throw new Error(`brief ${hash}: ${hookProblem}`);
  const allowed = briefs.allowedNumbers(shows, manifest.facts, manifest.delta);
  for (const [net, text] of Object.entries(manifest.captions)) {
    const stray = strayNumbers(text, allowed);
    if (stray.length) throw new Error(`brief ${hash}: ${net} caption carries number(s) that are not facts: ${stray.join(', ')}`);
  }
  const newer = shows.find(s => s.id === manifest.newer);
  if (!newer) throw new Error(`brief ${hash}: manifest names no newer production`);
  const olderLabel = productionLabel(shows.find(s => s !== newer));

  const targets = briefChannels(channels, newer);
  if (!targets.length) throw new Error(`brief ${hash}: no usable channel for ${newer.category}`);
  const notValidated = unvalidated(ctx.ledger, targets);
  if (notValidated.length) throw new Error(`brief ${hash}: ${notValidated.map(c => c.key).join(', ')} never passed the Buffer self-test; run the workflow with self_test first`);

  const quota = buffer.quotaProblem(buffer.rateLimit(), briefQuotaNeed(channels.length, targets.length));
  if (quota) throw new Error(`brief ${hash}: ${quota}`);
  const busy = await briefBusyDays({ shows, channels, buffer, ledger: ctx.ledger, now });
  const taken = (ctx.ledger.posts || []).map(p => Date.parse(p.dueAt || '')).filter(Number.isFinite);
  const t = briefs.pickBriefSlot({ now, tz: MARKETS[newer.category].tz, shows: busy, taken, inWindow, nextWindowSlot, zonedTime, localDay: buffer.localDay });
  if (t == null) throw new Error(`brief ${hash}: no free day in the next ${briefs.MAX_SLOT_DAYS} days for ${shows.map(s => s.id).join(' and ')}`);
  const dueAt = new Date(t);
  console.log(`[autopost] brief ${hash} (${manifest.template}: ${pair}) goes out ${dueAt.toISOString()}; approved: "${approval.words}"`);

  const { posted, errors } = await publishEvent({ channels: targets, buffer, captions: manifest.captions, imageUrl: manifest.imageUrl, markers: compareMarkers(newer, olderLabel), dueAt, label: `brief:${hash}`, now });
  if (!Object.keys(posted).length) throw new Error(`brief ${hash}: failed on every network (${Object.values(errors)[0]})`);
  const entry = {
    type: 'brief', id: `brief:${hash}`, hash, template: manifest.template, pair, showIds: manifest.ids,
    date: new Date(now).toISOString().slice(0, 10), slug: newer.slug || newer.id, olderLabel, title: newer.title, dueAt: dueAt.toISOString(),
    imageUrl: manifest.imageUrl, text: manifest.captions.twitter, channels: posted,
    approved: String(approval.words).slice(0, 300), approvedAt: approval.at || null,
  };
  if (Object.keys(errors).length) {
    entry.errors = errors;
    entry.pending = Object.fromEntries(targets.filter(c => errors[c.key]).map(c => [c.key, manifest.captions[c.network]]));
    entry.altText = manifest.captions.altText;
    entry.attempts = 1;
    problems.push(`brief ${hash}: failed on ${Object.keys(errors).join(', ')} (will retry)`);
  }
  ctx.ledger.posts.push(entry);
  writeLedger(ctx.ledger);
  summary.push(`| ${newer.title} (brief ${hash}) | ${entry.dueAt} | ${Object.keys(posted).join(', ')} | ${Object.keys(errors).join(', ') || '-'} |`);
}

/**
 * Usable channels that never passed the draft self-test. Ledgers from before per-market
 * routing hold only bufferValidatedAt, which validated the Broadway set; channels added
 * later (the West End accounts) get their own self-test before the first real post.
 */
function unvalidated(ledger, channels) {
  const meta = ledger._meta || {};
  const done = new Set(meta.bufferValidatedChannels || (meta.bufferValidatedAt ? Object.values(CHANNEL_SETS.broadway) : []));
  return channels.filter(c => !done.has(c.id));
}

async function selfTest(buffer, channels, outDir, ctx, now) {
  const show = ctx.shows.find(s => s.id === 'billy-crystal-860-2026') || ctx.shows.find(s => ctx.slim[s.id] && Number.isFinite(ctx.slim[s.id].cs));
  const desc = describe(show, ctx);
  const card = await buildCard(desc, outDir, { requirePoster: false });
  const imageUrl = await hostCard(card.path, show, now);
  const problems = await buffer.validateChannels(channels, { imageUrl, altText: buildCaptions(desc).altText });
  if (problems.length) throw new Error(`Buffer self-test failed, nothing posted: ${problems.join(' | ')}`);
  ctx.ledger._meta = { ...(ctx.ledger._meta || {}), bufferValidatedAt: new Date().toISOString(), bufferValidatedChannels: channels.map(c => c.id) };
  writeLedger(ctx.ledger);
  console.log(`[autopost] Buffer self-test passed on ${channels.map(c => c.key).join(', ')} (drafts created and deleted)`);
}

function writeSummary(summary) {
  if (!summary.length || !process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## Scheduled in Buffer', '', '| Show | Goes out (UTC) | Networks | Failed |', '|---|---|---|---|', ...summary,
    '', 'Undo: run this workflow with cancel_queued, or delete the post in Buffer. Stop all posting: set the repository variable SOCIAL_AUTOPOST_DISABLED=true.', ''].join('\n'));
}

async function main() {
  const dryRun = flag('dry-run');
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const outDir = arg('out') || path.join(require('os').tmpdir(), 'social-autopost');
  const configured = !!process.env.BUFFER_API_KEY;

  if (flag('list-channels')) {
    const buffer = require('./buffer');
    for (const ch of tagChannels(await buffer.listChannels(), CHANNEL_SETS)) console.log(`${ch.service.padEnd(10)} ${ch.set ? `will post (${ch.set})`.padEnd(22) : 'ignored'.padEnd(22)} ${ch.isDisconnected ? '(DISCONNECTED) ' : ''}${ch.isLocked ? '(LOCKED) ' : ''}${ch.isQueuePaused ? '(queue paused) ' : ''}${ch.displayName || ch.name}  [${ch.id}]`);
    return;
  }
  if (process.env.SOCIAL_AUTOPOST_DISABLED === 'true' && !flag('cancel-queued')) {
    if (flag('self-test')) throw new Error('self-test refused: SOCIAL_AUTOPOST_DISABLED is true');
    if (arg('brief')) throw new Error('brief refused: SOCIAL_AUTOPOST_DISABLED is true');
    console.log('[autopost] disabled by SOCIAL_AUTOPOST_DISABLED');
    return;
  }

  const ctx = loadContext();

  if (flag('cancel-queued')) {
    // Asks Buffer whether each post has gone out (a retried network's post can be
    // due later than its entry's dueAt), and stops the networks still owed a retry.
    const buffer = require('./buffer');
    let n = 0;
    for (const p of ctx.ledger.posts) {
      if (p.pending) { p.abandoned = Object.keys(p.pending); delete p.pending; delete p.altText; console.log(`  stopped retries for ${entryName(p)} on ${p.abandoned.join(', ')}`); }
      if (!p.channels || now - Date.parse(p.dueAt) > VERIFY_WINDOW_MS) continue;
      for (const [service, c] of Object.entries(p.channels)) {
        if (c.result || !c.postId) continue;
        const post = await buffer.getPost(c.postId);
        if (post && (post.status === 'sent' || post.status === 'sending')) { c.result = post.status; continue; }
        if (post) await buffer.deletePost(c.postId);
        c.result = 'cancelled';
        n++;
        console.log(`  cancelled ${entryName(p)} on ${service} (${c.postId})`);
      }
    }
    writeLedger(ctx.ledger);
    console.log(`[autopost] cancelled ${n} queued post(s)`);
    return;
  }

  // A brief run also does the hourly work below: a brief queued in the concurrency
  // group can replace a pending hourly run (GitHub keeps one pending run per group).
  const brief = arg('brief');
  if (brief && (dryRun || !configured || arg('show'))) throw new Error('--brief posts for real: it needs BUFFER_API_KEY, no --dry-run and no --show');

  let events;
  let backlogSkipped = [];
  if (arg('show')) {
    if (!dryRun) throw new Error('--show is for previews; add --dry-run');
    const show = ctx.shows.find(s => s.id === arg('show'));
    if (!show) throw new Error(`--show=${arg('show')}: not in shows.json`);
    events = [{ type: 'score', show, dueAt: new Date(now + 10 * 60e3) }];
  } else {
    const found = findScoreEvents({ shows: ctx.shows, ledger: ctx.ledger, now, reviewsByShow: ctx.reviewsByShow, slim: ctx.slim, getOutletTier: ctx.getOutletTier });
    const { post, skip } = splitBacklog(found, ctx.ledger, now);
    backlogSkipped = skip;
    const failures = ctx.ledger._meta.failures || {};
    events = scheduleEvents(post.filter(ev => !(failures[ev.show.id] && failures[ev.show.id].count >= MAX_SHOW_ATTEMPTS)), ctx.ledger, now);
  }
  const owed = pendingRetries(ctx.ledger, now).length;
  const toVerify = postsToVerify(ctx.ledger, now).length;
  console.log(`[autopost] ${events.length} post(s) due, ${owed} retry(ies) owed, ${toVerify} to read back${backlogSkipped.length ? `, ${backlogSkipped.length} older show(s) skipped at go-live` : ''}${dryRun ? ' (dry run)' : ''}`);

  if (flag('check')) {
    // Workflow gate: install the browser only when there is work. Without a key,
    // scheduled runs do nothing (a manual dispatch still renders as a check).
    // A cron-redispatch run stands in for a dropped scheduled run, so it is not manual.
    const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.INPUT_REDISPATCHED !== 'true';
    if (!configured) console.log('::notice::BUFFER_API_KEY not set: nothing will be posted');
    const due = configured ? events.length + owed + toVerify + backlogSkipped.length + (brief ? 1 : 0) : manual ? events.length : 0;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\nrender=${due ? events.length : 0}\n`);
    for (const ev of events) console.log(`  ${ev.show.id} due ${ev.dueAt.toISOString()}`);
    return;
  }

  const live = !dryRun && configured;
  if (!dryRun && !configured) console.log('::notice::BUFFER_API_KEY not set: cards are rendered as a check, nothing is posted');
  const buffer = live ? require('./buffer') : null;
  const summary = [];
  const problems = [];

  let channels = [];
  if (live) {
    const { usable, missing } = await allowedChannels(buffer);
    channels = usable;
    if (missing.length) problems.push(`Buffer channel(s) not usable (disconnected, locked, paused or removed): ${missing.join(', ')}`);
    if (!channels.length) throw new Error('none of the Buffer channels in config.js CHANNEL_SETS is usable');
    if (backlogSkipped.length) {
      const ymd = new Date(now).toISOString().slice(0, 10);
      for (const ev of backlogSkipped) ctx.ledger.posts.push({ type: 'score', date: ymd, showId: ev.show.id, skipped: 'backlog at go-live' });
      writeLedger(ctx.ledger);
    }
    problems.push(...await verifySent(ctx.ledger, buffer, now));
    problems.push(...abandonRetries(ctx.ledger, now));
    writeLedger(ctx.ledger);
    if (await retryFailedChannels(ctx.ledger, channels, buffer, now, summary)) problems.push('a retried network failed again (see the log above)');
    // A refused brief fails the run (the CLI reads that) but never holds up the score posts below.
    if (brief) {
      try {
        await runBrief(brief, { ctx, buffer, channels, now, summary, problems });
      } catch (e) {
        problems.push(`brief ${brief} refused: ${e.message}`);
      }
    }
  }

  if (flag('self-test')) {
    if (!live) throw new Error('--self-test needs BUFFER_API_KEY and no --dry-run');
    try { await selfTest(buffer, channels, outDir, ctx, now); } finally { await closeBrowser(); }
    return;
  }

  let failed = 0;
  // A held show that ages out of the lookback window stops being retried; drop its note.
  const waitingNotes = ctx.ledger._meta.waitingForPoster || {};
  for (const [id, w] of Object.entries(waitingNotes)) if (now - Date.parse(w.since) > 14 * 864e5) delete waitingNotes[id];
  // Counted per show across runs so one broken show alerts MAX_SHOW_ATTEMPTS times, not hourly for weeks.
  const failures = ctx.ledger._meta.failures = ctx.ledger._meta.failures || {};
  // Outages (hosting, Buffer down, network) are not the show's fault and do not use up its tries.
  const outage = m => /no usable channel|image hosting failed|Buffer HTTP 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|rate limit/i.test(String(m));
  const recordFailure = (id, msg) => {
    if (!live || outage(msg)) return;
    const f = failures[id] = { count: ((failures[id] && failures[id].count) || 0) + 1, lastError: String(msg).slice(0, 300), at: new Date(now).toISOString() };
    if (f.count >= MAX_SHOW_ATTEMPTS) problems.push(`${id}: gave up after ${f.count} failed runs (${f.lastError})`);
    writeLedger(ctx.ledger);
  };
  try {
    if (live && events.length && unvalidated(ctx.ledger, channels).length) await selfTest(buffer, channels, outDir, ctx, now);
    for (const ev of events) {
      // One show's failure must not lose the record of shows already scheduled:
      // each is written to the ledger as soon as Buffer accepts it.
      try {
        const desc = describe(ev.show, ctx);
        const captions = buildCaptions(desc);
        const card = await buildCard(desc, outDir, { requirePoster: live });
        console.log(`\n[autopost] ${ev.show.id} due ${ev.dueAt.toISOString()} card=${card.path} poster=${card.poster}`);
        console.log(`  X/Bluesky: ${captions.twitter.replace(/\n/g, ' | ')}`);
        const route = targetSets(ev.show, ctx.reviewsByShow[ev.show.id], CHANNEL_SETS, ctx.shows);
        console.log(`  routing: ${ev.show.category} -> ${route.join(' + ')} channels${route.length > 1 ? ' (high profile, cross-posted)' : ''}`);
        if (!live) continue;
        const targets = channels.filter(c => route.includes(c.set));
        if (!targets.length) throw new Error(`no usable channel in set(s) ${route.join(', ')}`);

        let imageUrl;
        try { imageUrl = await hostCard(card.path, ev.show, now); } catch (e) { throw new Error(`image hosting failed: ${e.message}`); }
        const { posted, errors } = await publishEvent({ channels: targets, buffer, captions, imageUrl, markers: postMarkers(ev.show), dueAt: ev.dueAt, label: ev.show.id, now });
        if (!Object.keys(posted).length) { failed++; if (!Object.values(errors).some(outage)) recordFailure(ev.show.id, Object.values(errors)[0]); continue; } // nothing went out: the next run tries again
        delete failures[ev.show.id];
        const entry = {
          type: 'score', date: new Date(now).toISOString().slice(0, 10), showId: ev.show.id, slug: ev.show.slug || ev.show.id,
          title: ev.show.title, dueAt: ev.dueAt.toISOString(), score: desc.score, imageUrl, text: captions.twitter, channels: posted,
        };
        if (Object.keys(errors).length) {
          // Retried by retryFailedChannels() on later runs with these exact texts, so
          // every network carries the same numbers.
          entry.errors = errors;
          entry.pending = Object.fromEntries(targets.filter(c => errors[c.key]).map(c => [c.key, captions[c.network]]));
          entry.altText = captions.altText;
          entry.attempts = 1;
          problems.push(`${ev.show.id}: failed on ${Object.keys(errors).join(', ')} (will retry)`);
        }
        ctx.ledger.posts.push(entry);
        if (ctx.ledger._meta.waitingForPoster) delete ctx.ledger._meta.waitingForPoster[ev.show.id];
        writeLedger(ctx.ledger);
        summary.push(`| ${ev.show.title} (${desc.score}) | ${entry.dueAt} | ${Object.keys(posted).join(', ')} | ${Object.keys(errors).join(', ') || '-'} |`);
      } catch (e) {
        if (e.code === 'NO_POSTER') {
          // Not a failure: the show waits (every run retries) until a usable poster exists
          // or it ages out of SCORE_LOOKBACK_DAYS. Reported once so the digest shows it.
          const waiting = ctx.ledger._meta.waitingForPoster = ctx.ledger._meta.waitingForPoster || {};
          if (!waiting[ev.show.id]) problems.push(`${ev.show.id}: held, ${e.message}. Add a full-size poster (at least 440px wide) and it posts on the next run.`);
          waiting[ev.show.id] = { since: (waiting[ev.show.id] || {}).since || new Date(now).toISOString(), reason: e.message.slice(0, 300) };
          console.log(`  [art] ${ev.show.id}: HELD, ${e.message}`);
          writeLedger(ctx.ledger);
          continue;
        }
        failed++;
        console.log(`::error::${ev.show.id}: ${e.message}`);
        if (/self-test failed|BUFFER_API_KEY|HTTP 401|rate limit|image hosting failed/i.test(e.message)) break; // account-level: stop
        recordFailure(ev.show.id, e.message);
      }
    }
  } finally {
    await closeBrowser();
  }

  writeSummary(summary);
  // Every problem fails the job so notify-failure reaches the owner's digest; the
  // ledger already holds what did go out, so nothing is re-posted.
  if (failed) problems.push(`${failed} show(s) failed on every network`);
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(err => { console.error(`[autopost] ${err.stack || err.message}`); process.exit(1); });
}

module.exports = { MAX_SHOW_ATTEMPTS, unvalidated, describe, breakdownFor, pendingRetries, abandonRetries, postsToVerify, writeLedger, loadContext, hostCard, buildCard, publishEvent, entryMarkers, briefChannels, briefBusyDays, briefQuotaNeed, runBrief, LEDGER_FILE };
