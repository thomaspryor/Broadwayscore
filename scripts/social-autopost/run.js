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
 *   node scripts/social-autopost/run.js --dry-run --preview-roundup[=YYYY-MM-DD] [--host]   # BRO-6413: sample weekly roundup card + captions (flag-independent)
 *   node scripts/social-autopost/run.js --dry-run --preview-closing[=SHOW_ID] [--host]        # sample closing-soon card; best candidate, or the nearest and says so
 *   node scripts/social-autopost/run.js --dry-run --roundup-lookback=90 --closing-lookback=90 # what each new type would have fired in the last N days
 *   node scripts/social-autopost/run.js --self-test      # draft post on every channel, then delete it
 *   node scripts/social-autopost/run.js --cancel-queued  # delete every not-yet-sent post it created
 *   node scripts/social-autopost/run.js --brief=HASH     # post an approved brief (BRO-6368, from brief.js --post)
 *   node scripts/social-autopost/run.js --dry-run --london-lookback=90   # which shows of the last 90 days have a London run (BRO-6373)
 *
 * Options: --now=ISO (pretend time), --out=DIR (where cards are written).
 * Env: BUFFER_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY
 *      (art check), SOCIAL_AUTOPOST_DISABLED=true (kill switch), SOCIAL_CHROMIUM_PATH.
 * State: data/social-autopost-ledger.json, written by this script only (one workflow,
 * one concurrency group), one entry per show score post, one per brief post and one per
 * London comparison post (type 'london-compare', key london-compare:<showId>).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getScoreTierId, getScoreTierLabel, getGoldThreshold } = require('../lib/score-tiers');
const { findScoreEvents, findLondonCompareEvents, findRoundupEvents, findClosingSoonEvents, roundupLookback, closingSoonLookback, briefCoversPair, londonCompareLookback, scheduleEvents, splitBacklog, isEligibleShow, morningAfter, inWindow, nextWindowSlot, zonedTime } = require('./select');
const { buildCaptions, postMarkers, compareMarkers, pathMarker, validateHook, strayNumbers, productionLabel, monthDay, roundupMarkers, buildRoundupCaptions, roundupAllowedNumbers, closingMarkers, buildClosingCaptions, closingAllowedNumbers } = require('./captions');
const { resolvePoster, minPosterWidth } = require('./art');
const { renderCard, renderCompareCard, renderRoundupCard, closeBrowser, COMPARE_POSTER_PX, ROW_POSTER_PX, MAX_ROWS } = require('./render');
const { CHANNEL_SETS, MARKETS, SCORE_LOOKBACK_DAYS, WEEKLY_ROUNDUP, CLOSING_SOON } = require('./config');
const { targetSets, tagChannels, channelKey, homeSet } = require('./routing');
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
async function buildCard(desc, outDir, { requirePoster = true, label = null, name = desc.show.id } = {}) {
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
    poster: poster.poster ? poster : null, label,
  };
  const out = path.join(outDir, `${name}.png`);
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
  if (p.type === 'weekly-roundup') return roundupMarkers(p.first, p.last, p.set);
  if (p.type === 'closing-soon') return closingMarkers({ id: p.showId, slug: p.slug });
  return p.type === 'brief' || p.type === 'london-compare' ? compareMarkers({ slug: p.slug }, p.olderLabel) : postMarkers({ id: p.showId, slug: p.slug });
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
 * Schedule one compare post on the newer production's home channels and record it in the
 * ledger: the shared tail of a brief (owner-approved) and a london-compare (automatic).
 * Throws "<label>: <reason>" when it cannot post: no usable channel, channels never
 * self-tested, Buffer quota too low, no free day for either show, or every network failed.
 * `entry` holds the type-specific ledger fields (type, id, pair, approval...).
 */
async function postCompare({ label, shows, newer, olderLabel, captions, imageUrl, ctx, buffer, channels, now, earliest, summary, problems, note = '', maxDelayDays = null, entry: extra, markers = compareMarkers(newer, olderLabel), fields = {} }) {
  const targets = briefChannels(channels, newer);
  if (!targets.length) throw new Error(`${label}: no usable channel for ${newer.category}`);
  const notValidated = unvalidated(ctx.ledger, targets);
  if (notValidated.length) throw new Error(`${label}: ${notValidated.map(c => c.key).join(', ')} never passed the Buffer self-test; run the workflow with self_test first`);

  const quota = buffer.quotaProblem(buffer.rateLimit(), briefQuotaNeed(channels.length, targets.length));
  if (quota) throw Object.assign(new Error(`${label}: ${quota}`), { code: 'QUOTA' });
  const busy = await briefBusyDays({ shows, channels, buffer, ledger: ctx.ledger, now });
  const taken = (ctx.ledger.posts || []).map(p => Date.parse(p.dueAt || '')).filter(Number.isFinite);
  const t = briefs.pickBriefSlot({ now, earliest, tz: MARKETS[newer.category].tz, shows: busy, taken, inWindow, nextWindowSlot, zonedTime, localDay: buffer.localDay });
  if (t == null) throw Object.assign(new Error(`${label}: no free day in the next ${briefs.MAX_SLOT_DAYS} days for ${shows.map(s => s.id).join(' and ')}`), { code: 'NO_SLOT' });
  // A roundup must not drift into the next week's news: past maxDelayDays the numbers stop being timely.
  if (maxDelayDays != null && t - earliest > maxDelayDays * 864e5) throw Object.assign(new Error(`${label}: no free day within ${maxDelayDays} days of ${new Date(earliest).toISOString().slice(0, 10)}`), { code: 'NO_SLOT' });
  const dueAt = new Date(t);
  console.log(`[autopost] ${label} goes out ${dueAt.toISOString()}${note ? ` ${note}` : ''}`);

  const { posted, errors } = await publishEvent({ channels: targets, buffer, captions, imageUrl, markers, dueAt, label, now });
  if (!Object.keys(posted).length) throw new Error(`${label}: failed on every network (${Object.values(errors)[0]})`);
  const entry = {
    ...extra, showIds: shows.map(s => s.id),
    date: new Date(now).toISOString().slice(0, 10), slug: newer.slug || newer.id, olderLabel, title: newer.title, dueAt: dueAt.toISOString(),
    imageUrl, text: captions.twitter, channels: posted, ...fields,
  };
  if (Object.keys(errors).length) {
    entry.errors = errors;
    entry.pending = Object.fromEntries(targets.filter(c => errors[c.key]).map(c => [c.key, captions[c.network]]));
    entry.altText = captions.altText;
    entry.attempts = 1;
    problems.push(`${label}: failed on ${Object.keys(errors).join(', ')} (will retry)`);
  }
  ctx.ledger.posts.push(entry);
  writeLedger(ctx.ledger, ctx.ledgerFile); // ctx.ledgerFile: tests only; undefined means the real ledger
  summary.push(`| ${newer.title} (${label}) | ${entry.dueAt} | ${Object.keys(posted).join(', ')} | ${Object.keys(errors).join(', ') || '-'} |`);
}

/**
 * Render a compare card (two posters, two badges) for buildCompare() output. Shared by
 * brief.js --preview and the automatic London comparison. With requirePoster, a side
 * without a usable poster throws NO_POSTER (owner rule: never post without the poster).
 */
async function renderCompareFor(built, ctx, png, { requirePoster = false } = {}) {
  for (const [i, d] of [built.older, built.newer].entries()) {
    const poster = await resolvePoster(d.show, { minWidth: minPosterWidth(COMPARE_POSTER_PX), shows: ctx.shows, mezzanine: true });
    if (!poster.poster) {
      if (requirePoster) throw Object.assign(new Error(`${d.show.id}: no usable poster (${poster.reason})`), { code: 'NO_POSTER' });
      console.log(`  [art] ${d.show.id}: typographic poster (${poster.reason})`);
    }
    built.card.sides[i].poster = poster.poster ? poster : null;
  }
  await renderCompareCard(built.card, png);
}

/**
 * Post one London comparison (BRO-6373): the Phase A compare card and captions for a
 * New York show and its London run, no hook sentence and no owner approval. Posts only
 * when Buffer's quota allows (a skipped post is retried by the next hourly run until
 * LONDON_COMPARE_LOOKBACK_DAYS pass). Returns 'posted', 'skipped' (quota or no free day),
 * or throws for anything else.
 */
async function runLondonCompare(ev, { ctx, buffer, channels, now, outDir, summary, problems }) {
  const label = `london-compare:${ev.show.id}`;
  const built = briefs.buildCompare({ descA: describe(ev.london, ctx), descB: describe(ev.show, ctx), hook: '', now });
  const png = path.join(outDir, `london-compare-${ev.show.id}.png`);
  fs.mkdirSync(outDir, { recursive: true });
  await renderCompareFor(built, ctx, png, { requirePoster: true });
  const { encodeForSocial, hostImage } = require('./host');
  const jpeg = await encodeForSocial(png);
  const sha = crypto.createHash('sha1').update(jpeg.buffer).digest('hex').slice(0, 10);
  const imageUrl = await hostImage(jpeg.buffer, `brief/${new Date(now).toISOString().slice(0, 7)}/london-compare-${ev.show.id}-${sha}.jpg`)
    .catch(e => { throw new Error(`image hosting failed: ${e.message}`); });
  try {
    await postCompare({
      label, shows: [built.older.show, built.newer.show], newer: built.newer.show, olderLabel: productionLabel(built.older.show),
      captions: built.captions, imageUrl, ctx, buffer, channels, now, earliest: ev.dueAt.getTime(), summary, problems,
      entry: { type: 'london-compare', id: label, showId: ev.show.id, template: 'compare', pair: briefs.pairKey([ev.show.id, ev.london.id]), auto: true },
    });
  } catch (e) {
    if (e.code === 'QUOTA' || e.code === 'NO_SLOT') { console.log(`[autopost] ${e.message}; trying again next run`); return 'skipped'; }
    throw e;
  }
  return 'posted';
}


/** Refuse a caption set that carries a number that is not a fact, an em dash or too many characters. */
function checkCaptions(captions, allowed, label) {
  const { LIMITS } = require('./captions');
  for (const [net, text] of Object.entries(captions)) {
    const stray = strayNumbers(text, allowed);
    if (stray.length) throw new Error(`${label}: ${net} caption carries number(s) that are not facts: ${stray.join(', ')}`);
    if (text.includes('—')) throw new Error(`${label}: ${net} caption has an em dash`);
    const len = [...(net === 'twitter' ? text.replace(/https?:\/\/\S+/g, 'x'.repeat(23)) : text)].length; // X counts every link as 23
    if (LIMITS[net] && len > LIMITS[net]) throw new Error(`${label}: ${net} caption is ${len} characters, over its ${LIMITS[net]} limit`);
  }
}

/** Encode a rendered PNG and host it under a content-addressed key (a re-render never replaces a scheduled post's image). */
async function hostPng(png, keyPrefix, now) {
  const { encodeForSocial, hostImage } = require('./host');
  const jpeg = await encodeForSocial(png);
  const sha = crypto.createHash('sha1').update(jpeg.buffer).digest('hex').slice(0, 10);
  return hostImage(jpeg.buffer, `${keyPrefix.replace('<month>', new Date(now).toISOString().slice(0, 7))}-${sha}.jpg`)
    .catch(e => { throw new Error(`image hosting failed: ${e.message}`); });
}

/**
 * Build one weekly roundup (BRO-6413): up to MAX_ROWS of the event's candidates that have a
 * real poster (owner rule: never post without it; a show without one is left off), the card
 * and the captions. Throws NO_POSTER when fewer than cfg.minShows have a poster.
 */
async function buildRoundup(ev, ctx, outDir, { cfg = WEEKLY_ROUNDUP } = {}) {
  const rows = [], held = [];
  for (const show of ev.candidates) {
    if (rows.length >= MAX_ROWS) break;
    let d;
    try { d = describe(show, ctx); } catch (e) { held.push(`${show.id}: ${e.message}`); continue; }
    const poster = await resolvePoster(show, { minWidth: minPosterWidth(ROW_POSTER_PX), shows: ctx.shows, mezzanine: true });
    if (!poster.poster) { held.push(`${show.id}: ${poster.reason}`); continue; }
    rows.push({ show, title: show.title, venue: show.venue, category: show.category, score: d.score, tierId: d.tierId, tierLabel: d.tierLabel, poster });
  }
  if (rows.length < cfg.minShows) {
    throw Object.assign(new Error(`${ev.id}: only ${rows.length} of ${ev.candidates.length} opening(s) have a usable poster (${held.join(' | ').slice(0, 200)})`), { code: 'NO_POSTER' });
  }
  const more = ev.candidates.length - rows.length;
  const p = { set: ev.set, first: ev.first, last: ev.last, rows, more };
  const captions = buildRoundupCaptions(p);
  checkCaptions(captions, roundupAllowedNumbers(p), ev.id);
  const png = path.join(outDir, `${ev.id.replace(/:/g, '-')}.png`);
  await renderRoundupCard({
    market: ev.set === 'west-end' ? 'west-end' : 'broadway', range: `${monthDay(ev.first)} to ${monthDay(ev.last)}`,
    rows: rows.map(r => ({ title: r.title, venue: r.venue, score: r.score, tierId: r.tierId, poster: r.poster })),
  }, png);
  return { png, captions, rows, more, held };
}

/** Build one closing-soon post: the D4 score card labelled "Closing <date>" and its captions. */
async function buildClosing(ev, ctx, outDir, { requirePoster = true } = {}) {
  const desc = describe(ev.show, ctx);
  if (desc.score !== ev.score) throw new Error(`${ev.show.id}: score is ${desc.score}, was ${ev.score} when selected`);
  const p = { show: ev.show, score: desc.score, tierId: desc.tierId, tierLabel: desc.tierLabel, reviewCount: desc.reviewCount, breakdown: desc.breakdown, closing: ev.closing };
  const captions = buildClosingCaptions(p);
  checkCaptions(captions, closingAllowedNumbers(p), `closing-soon:${ev.show.id}`);
  const card = await buildCard(desc, outDir, { requirePoster, label: `Closing ${monthDay(ev.closing)}`, name: `closing-${ev.show.id}` });
  return { desc, captions, card };
}

/**
 * Roundups and closing-soon posts go only to their own market's accounts: until that set is
 * fully configured (West End, BRO-6378) they are not posted at all, rather than falling back to
 * the Broadway accounts as the score lane does.
 */
function ownSetConfigured(set) {
  return set === 'broadway' || Object.keys(CHANNEL_SETS.broadway).every(svc => (CHANNEL_SETS[set] || {})[svc]);
}
function idleUnconfigured(label, set) {
  console.log(`[autopost] ${label}: the ${set} accounts are not configured yet (BRO-6378), nothing posted`);
  return 'idle';
}

/** Post one weekly roundup. Returns 'posted' or 'skipped' (quota or no free day, retried next run). */
async function runRoundup(ev, { ctx, buffer, channels, now, outDir, summary, problems }) {
  if (!ownSetConfigured(ev.set)) return idleUnconfigured(ev.id, ev.set);
  const built = await buildRoundup(ev, ctx, outDir);
  const imageUrl = await hostPng(built.png, `roundup/<month>/${ev.id.replace(/:/g, '-')}`, now);
  const title = `New openings, ${monthDay(ev.first)} to ${monthDay(ev.last)}`;
  try {
    await postCompare({
      label: ev.id, shows: built.rows.map(r => r.show), newer: built.rows[0].show, captions: built.captions, imageUrl, ctx, buffer, channels, now,
      earliest: ev.dueAt.getTime(), summary, problems, markers: roundupMarkers(ev.first, ev.last, ev.set), maxDelayDays: 2,
      entry: { type: 'weekly-roundup', id: ev.id, template: 'roundup', set: ev.set, first: ev.first, last: ev.last, auto: true },
      fields: { title, scores: Object.fromEntries(built.rows.map(r => [r.show.id, r.score])) },
    });
  } catch (e) {
    if (e.code === 'QUOTA' || e.code === 'NO_SLOT') { console.log(`[autopost] ${e.message}; trying again next run`); return 'skipped'; }
    throw e;
  }
  return 'posted';
}

/** Post one closing-soon card (ledger key closing-soon:<showId>). Returns 'posted' or 'skipped'. */
async function runClosingSoon(ev, { ctx, buffer, channels, now, outDir, summary, problems }) {
  const label = `closing-soon:${ev.show.id}`;
  if (!ownSetConfigured(homeSet(ev.show))) return idleUnconfigured(label, homeSet(ev.show));
  const built = await buildClosing(ev, ctx, outDir, { requirePoster: true });
  const imageUrl = await hostCard(built.card.path, { id: `closing-${ev.show.id}` }, now)
    .catch(e => { throw new Error(`image hosting failed: ${e.message}`); });
  try {
    await postCompare({
      label, shows: [ev.show], newer: ev.show, captions: built.captions, imageUrl, ctx, buffer, channels, now,
      earliest: ev.dueAt.getTime(), summary, problems, markers: closingMarkers(ev.show),
      entry: { type: 'closing-soon', id: label, showId: ev.show.id, template: 'closing', closing: ev.closing, score: built.desc.score, auto: true },
    });
  } catch (e) {
    if (e.code === 'QUOTA' || e.code === 'NO_SLOT') { console.log(`[autopost] ${e.message}; trying again next run`); return 'skipped'; }
    throw e;
  }
  return 'posted';
}

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

  await postCompare({
    label: `brief ${hash}`, shows, newer, olderLabel, captions: manifest.captions, imageUrl: manifest.imageUrl,
    ctx, buffer, channels, now, summary, problems,
    note: `(${manifest.template}: ${pair}); approved: "${approval.words}"`,
    entry: { type: 'brief', id: `brief:${hash}`, hash, template: manifest.template, pair, approved: String(approval.words).slice(0, 300), approvedAt: approval.at || null },
  });
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


/**
 * Dry-run previews of the two new post types, whatever their config.js flags say (the owner
 * sees a sample before a flag is turned on). Renders the card(s) into outDir, prints the
 * captions for every network, and with --host uploads the card to the public bucket and
 * prints its URL. --preview-roundup[=POST_DAY] uses the latest roundup day (or the given
 * YYYY-MM-DD); --preview-closing[=SHOW_ID] uses that show, or the best current candidate:
 * a show in the closing range with the highest score, else the nearest open show with a
 * closing date and a settled score of at least CLOSING_SOON.minScore (and says so).
 */
async function previewNewTypes({ ctx, now, outDir }) {
  const { roundupDay, roundupCandidates, ymdDays, scoreSettled, closingDecision, doneKeys } = require('./select');
  const base = { shows: ctx.shows, reviewsByShow: ctx.reviewsByShow, slim: ctx.slim, getOutletTier: ctx.getOutletTier };
  const host = async (png, name) => (flag('host') ? `\n  hosted: ${await hostPng(png, `preview/<month>/${name}`, now)}` : '');
  try {
    if (flag('preview-roundup') || arg('preview-roundup')) {
      for (const set of ['broadway', 'west-end']) {
        const day = arg('preview-roundup') ? { ymd: arg('preview-roundup') } : roundupDay(now, set);
        const candidates = roundupCandidates(day.ymd, set, base);
        const ev = { type: 'weekly-roundup', set, ymd: day.ymd, id: `weekly-roundup:${set}:${day.ymd}`, ...require('./select').roundupWindow(day.ymd), candidates };
        console.log(`\n[preview] ${ev.id}: openings ${ev.first} to ${ev.last}, ${candidates.length} with a settled score${candidates.length < WEEKLY_ROUNDUP.minShows ? ` (fewer than ${WEEKLY_ROUNDUP.minShows}: the week would be skipped)` : ''}`);
        if (candidates.length < WEEKLY_ROUNDUP.minShows) continue;
        try {
          const built = await buildRoundup(ev, ctx, outDir);
          console.log(`  card: ${built.png} (${built.rows.length} rows${built.more ? `, ${built.more} more not shown` : ''}${built.held.length ? `; left off, no usable poster: ${built.held.map(h => h.split(':')[0]).join(', ')}` : ''})`);
          for (const r of built.rows) console.log(`    ${r.score} ${r.title} (${r.category})`);
          for (const [net, text] of Object.entries(built.captions)) console.log(`  --- ${net}\n${text.replace(/^/gm, '  ')}`);
          console.log(await host(built.png, ev.id.replace(/:/g, '-')));
        } catch (e) { console.log(`  not buildable: ${e.message}`); }
      }
    }
    if (flag('preview-closing') || arg('preview-closing')) {
      const done = doneKeys(ctx.ledger);
      const dctx = { ...base, done, now };
      const open = ctx.shows.filter(sh => require('./select').isEligibleShow(sh) && sh.status === 'open' && /^\d{4}-\d{2}-\d{2}/.test(String(sh.closingDate || '')));
      let show = arg('preview-closing') ? ctx.shows.find(sh => sh.id === arg('preview-closing')) : null;
      if (arg('preview-closing') && !show) throw new Error(`--preview-closing=${arg('preview-closing')}: not in shows.json`);
      let note = 'chosen by id';
      if (!show) {
        const tz = sh => require('./config').MARKETS[sh.category].tz;
        const rows = open.map(sh => {
          const d = closingDecision(sh, dctx);
          const days = ymdDays(String(sh.closingDate).slice(0, 10), require('./select').localParts(new Date(now), tz(sh)).ymd);
          const s = scoreSettled(sh, dctx);
          const score = s.ok ? Math.round(ctx.slim[sh.id].cs) : null;
          const gap = days < CLOSING_SOON.minDays ? CLOSING_SOON.minDays - days : days > CLOSING_SOON.maxDays ? days - CLOSING_SOON.maxDays : 0;
          return { sh, d, days, score, gap };
        }).filter(r => r.days >= 0 && r.score !== null && r.score >= CLOSING_SOON.minScore && require('./select').isEligibleShow(r.sh));
        rows.sort((a, b) => a.gap - b.gap || b.score - a.score || a.sh.id.localeCompare(b.sh.id));
        if (!rows.length) { console.log(`\n[preview] closing-soon: no open show with a closing date and a score of ${CLOSING_SOON.minScore}+`); return; }
        show = rows[0].sh;
        note = rows[0].gap === 0 ? `qualifies: closes in ${rows[0].days} days (range ${CLOSING_SOON.minDays} to ${CLOSING_SOON.maxDays}), score ${rows[0].score}` : `DOES NOT QUALIFY YET, nearest candidate: closes in ${rows[0].days} days (range ${CLOSING_SOON.minDays} to ${CLOSING_SOON.maxDays}), score ${rows[0].score}`;
      }
      const closing = String(show.closingDate).slice(0, 10);
      const ev = { type: 'closing-soon', show, closing, score: Math.round((ctx.slim[show.id] || {}).cs) };
      console.log(`\n[preview] closing-soon:${show.id}: ${note}`);
      const built = await buildClosing(ev, ctx, outDir, { requirePoster: true });
      console.log(`  card: ${built.card.path} poster=${built.card.poster}`);
      for (const [net, text] of Object.entries(built.captions)) console.log(`  --- ${net}\n${text.replace(/^/gm, '  ')}`);
      console.log(await host(built.card.path, `closing-${show.id}`));
    }
  } finally {
    await closeBrowser();
  }
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
  let compareEvents = [];
  let roundupEvents = [];
  let closingEvents = [];
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
    compareEvents = findLondonCompareEvents({ shows: ctx.shows, ledger: ctx.ledger, now, slim: ctx.slim })
      .filter(ev => !(failures[`london-compare:${ev.show.id}`] && failures[`london-compare:${ev.show.id}`].count >= MAX_SHOW_ATTEMPTS));
    // BRO-6413: each type runs only when its config.js flag is on (default off).
    const tooManyFailures = key => failures[key] && failures[key].count >= MAX_SHOW_ATTEMPTS;
    const found2 = { shows: ctx.shows, ledger: ctx.ledger, now, reviewsByShow: ctx.reviewsByShow, slim: ctx.slim, getOutletTier: ctx.getOutletTier };
    if (WEEKLY_ROUNDUP.enabled) roundupEvents = findRoundupEvents({ ...found2, cfg: WEEKLY_ROUNDUP }).filter(ev => !tooManyFailures(ev.id));
    if (CLOSING_SOON.enabled) closingEvents = findClosingSoonEvents({ ...found2, cfg: CLOSING_SOON }).filter(ev => !tooManyFailures(`closing-soon:${ev.show.id}`));
  }
  const owed = pendingRetries(ctx.ledger, now).length;
  const toVerify = postsToVerify(ctx.ledger, now).length;
  console.log(`[autopost] ${events.length} post(s) due${compareEvents.length ? `, ${compareEvents.length} London comparison(s) due` : ''}${roundupEvents.length ? `, ${roundupEvents.length} weekly roundup(s) due` : ''}${closingEvents.length ? `, ${closingEvents.length} closing-soon post(s) due` : ''}, ${owed} retry(ies) owed, ${toVerify} to read back${backlogSkipped.length ? `, ${backlogSkipped.length} older show(s) skipped at go-live` : ''}${dryRun ? ' (dry run)' : ''}`);

  if (arg('london-lookback')) {
    if (!dryRun) throw new Error('--london-lookback is a listing; add --dry-run');
    const days = Number(arg('london-lookback'));
    if (!(days > 0)) throw new Error('--london-lookback=DAYS needs a number of days');
    const rows = londonCompareLookback({ shows: ctx.shows, ledger: ctx.ledger, now, slim: ctx.slim, days });
    console.log(`[autopost] ${rows.length} show(s) opened in the last ${days} days with a London run; ${rows.filter(r => r.wouldFire).length} would fire`);
    for (const r of rows) console.log(`  ${r.wouldFire ? 'WOULD FIRE' : r.done ? 'done' : r.brief ? 'brief exists' : 'no sent score post'} ${r.show.id} (opened ${String(r.show.openingDate).slice(0, 10)}) with ${r.london.id}; score post: ${r.scorePost}`);
    return;
  }


  if (arg('roundup-lookback') || arg('closing-lookback')) {
    if (!dryRun) throw new Error('--roundup-lookback / --closing-lookback are listings; add --dry-run');
    const base = { shows: ctx.shows, ledger: ctx.ledger, now, reviewsByShow: ctx.reviewsByShow, slim: ctx.slim, getOutletTier: ctx.getOutletTier };
    if (arg('roundup-lookback')) {
      const days = Number(arg('roundup-lookback'));
      if (!(days > 0)) throw new Error('--roundup-lookback=DAYS needs a number of days');
      const rows = roundupLookback({ ...base, days });
      console.log(`[autopost] weekly roundup, last ${days} days (weekday ${WEEKLY_ROUNDUP.weekday}, flag ${WEEKLY_ROUNDUP.enabled ? 'ON' : 'off'}): ${rows.filter(r => r.wouldFire).length} of ${rows.length} would fire`);
      for (const r of rows) console.log(`  ${r.wouldFire ? 'WOULD FIRE' : 'skip (fewer than ' + WEEKLY_ROUNDUP.minShows + ' scored)'} ${r.ymd} ${r.set}, openings ${r.first} to ${r.last}: ${r.candidates.map(sh => `${sh.id} ${Math.round(ctx.slim[sh.id].cs)}`).join(', ') || 'none'}`);
    }
    if (arg('closing-lookback')) {
      const days = Number(arg('closing-lookback'));
      if (!(days > 0)) throw new Error('--closing-lookback=DAYS needs a number of days');
      const rows = closingSoonLookback({ ...base, days });
      console.log(`[autopost] closing soon, last ${days} days (flag ${CLOSING_SOON.enabled ? 'ON' : 'off'}; today's scores and closing dates, so approximate): ${rows.filter(r => r.wouldFire).length} of ${rows.length} shows in range would fire`);
      for (const r of rows) console.log(`  ${r.wouldFire ? 'WOULD FIRE' : r.settled ? `below ${CLOSING_SOON.minScore}` : 'score not settled'} ${r.show.id} (${r.show.category}, ${r.show.status}) score ${r.score}, closes ${r.closing}, in range from ${r.firstDay}`);
    }
    return;
  }

  if (flag('preview-roundup') || arg('preview-roundup') || flag('preview-closing') || arg('preview-closing')) {
    if (!dryRun) throw new Error('--preview-roundup / --preview-closing are previews; add --dry-run');
    await previewNewTypes({ ctx, now, outDir });
    return;
  }

  if (flag('check')) {
    // Workflow gate: install the browser only when there is work. Without a key,
    // scheduled runs do nothing (a manual dispatch still renders as a check).
    // A cron-redispatch run stands in for a dropped scheduled run, so it is not manual.
    const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.INPUT_REDISPATCHED !== 'true';
    if (!configured) console.log('::notice::BUFFER_API_KEY not set: nothing will be posted');
    const due = configured ? events.length + compareEvents.length + roundupEvents.length + closingEvents.length + owed + toVerify + backlogSkipped.length + (brief ? 1 : 0) : manual ? events.length : 0;
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\nrender=${due ? events.length + compareEvents.length + roundupEvents.length + closingEvents.length : 0}\n`);
    for (const ev of events) console.log(`  ${ev.show.id} due ${ev.dueAt.toISOString()}`);
    for (const ev of compareEvents) console.log(`  london-compare:${ev.show.id} (with ${ev.london.id}) due ${ev.dueAt.toISOString()}`);
    for (const ev of roundupEvents) console.log(`  ${ev.id} (${ev.candidates.length} openings) due ${ev.dueAt.toISOString()}`);
    for (const ev of closingEvents) console.log(`  closing-soon:${ev.show.id} (closes ${ev.closing}) due ${ev.dueAt.toISOString()}`);
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
    if (live && (events.length || compareEvents.length || roundupEvents.length || closingEvents.length) && unvalidated(ctx.ledger, channels).length) await selfTest(buffer, channels, outDir, ctx, now);
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

    // London comparisons come after the score posts: a score post always gets its slot first.
    for (const ev of compareEvents) {
      const key = `london-compare:${ev.show.id}`;
      // A brief for this pair may have gone out earlier in this very run.
      if (briefCoversPair(ctx.ledger, [ev.show.id, ev.london.id])) { console.log(`  ${key}: skipped, a brief for the pair exists`); continue; }
      try {
        if (!live) {
          const built = briefs.buildCompare({ descA: describe(ev.london, ctx), descB: describe(ev.show, ctx), hook: '', now });
          console.log(`\n[autopost] ${key} (with ${ev.london.id}) due ${ev.dueAt.toISOString()}`);
          console.log(`  X/Bluesky: ${built.captions.twitter.replace(/\n/g, ' | ')}`);
          continue;
        }
        if (await runLondonCompare(ev, { ctx, buffer, channels, now, outDir, summary, problems }) === 'skipped') break; // quota or no free day: the next run tries again
        delete failures[key];
        if (ctx.ledger._meta.waitingForPoster) delete ctx.ledger._meta.waitingForPoster[key];
      } catch (e) {
        if (e.code === 'NO_POSTER') {
          const waiting = ctx.ledger._meta.waitingForPoster = ctx.ledger._meta.waitingForPoster || {};
          if (!waiting[key]) problems.push(`${key}: held, ${e.message}. Add a full-size poster (at least 440px wide) and it posts on the next run.`);
          waiting[key] = { since: (waiting[key] || {}).since || new Date(now).toISOString(), reason: e.message.slice(0, 300) };
          console.log(`  [art] ${key}: HELD, ${e.message}`);
          writeLedger(ctx.ledger);
          continue;
        }
        failed++;
        console.log(`::error::${key}: ${e.message}`);
        if (/self-test failed|BUFFER_API_KEY|HTTP 401|rate limit|image hosting failed/i.test(e.message)) break;
        recordFailure(key, e.message);
      }
    }

    // Weekly roundups, then closing-soon posts (BRO-6413): after the score posts, which always get their slot first.
    for (const [list, keyOf, build, runner] of [
      [roundupEvents, ev => ev.id, ev => buildRoundup(ev, ctx, outDir), runRoundup],
      [closingEvents, ev => `closing-soon:${ev.show.id}`, ev => buildClosing(ev, ctx, outDir, { requirePoster: false }), runClosingSoon],
    ]) {
      for (const ev of list) {
        const key = keyOf(ev);
        try {
          if (!live) {
            const built = await build(ev);
            console.log(`\n[autopost] ${key} due ${ev.dueAt.toISOString()}`);
            console.log(`  X/Bluesky: ${built.captions.twitter.replace(/\n/g, ' | ')}`);
            continue;
          }
          const result = await runner(ev, { ctx, buffer, channels, now, outDir, summary, problems });
          if (result === 'skipped') break; // quota or no free day: the next run tries again
          if (result === 'idle') continue; // that market's accounts are not set up; nothing was posted or recorded
          delete failures[key];
          if (ctx.ledger._meta.waitingForPoster) delete ctx.ledger._meta.waitingForPoster[key];
        } catch (e) {
          if (e.code === 'NO_POSTER') {
            const waiting = ctx.ledger._meta.waitingForPoster = ctx.ledger._meta.waitingForPoster || {};
            if (!waiting[key]) problems.push(`${key}: held, ${e.message}. Add a full-size poster (at least ${key.startsWith('weekly-roundup') ? minPosterWidth(ROW_POSTER_PX) : 440}px wide) and it posts on the next run.`);
            waiting[key] = { since: (waiting[key] || {}).since || new Date(now).toISOString(), reason: e.message.slice(0, 300) };
            console.log(`  [art] ${key}: HELD, ${e.message}`);
            writeLedger(ctx.ledger);
            continue;
          }
          failed++;
          console.log(`::error::${key}: ${e.message}`);
          if (/self-test failed|BUFFER_API_KEY|HTTP 401|rate limit|image hosting failed/i.test(e.message)) break;
          recordFailure(key, e.message);
        }
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

module.exports = { buildRoundup, buildClosing, runRoundup, runClosingSoon, checkCaptions, MAX_SHOW_ATTEMPTS, unvalidated, describe, renderCompareFor, runLondonCompare, postCompare, breakdownFor, pendingRetries, abandonRetries, postsToVerify, writeLedger, loadContext, hostCard, buildCard, publishEvent, entryMarkers, briefChannels, briefBusyDays, briefQuotaNeed, runBrief, LEDGER_FILE };
