#!/usr/bin/env node
/**
 * Social autopost (BRO-6242): opening-day and Critic Score posts with a
 * high-resolution card, scheduled to every connected Buffer channel
 * (Instagram, Facebook, X, Threads, Bluesky).
 *
 *   node scripts/social-autopost/run.js                 # post whatever is due
 *   node scripts/social-autopost/run.js --dry-run       # render + captions only
 *   node scripts/social-autopost/run.js --dry-run --show=ID --event=score|opening
 *   node scripts/social-autopost/run.js --list-channels # check the Buffer connection
 *   node scripts/social-autopost/run.js --check         # count due posts (writes due= to GITHUB_OUTPUT)
 *
 * Options: --now=ISO (pretend time), --out=DIR (where cards are written).
 * Env: BUFFER_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      SOCIAL_AUTOPOST_DISABLED=true (kill switch), SOCIAL_CHROMIUM_PATH.
 * State: data/social-post-history.json, one entry per (type, showId).
 */

const fs = require('fs');
const path = require('path');
const { getScoreTierId, getScoreTierLabel } = require('../lib/score-tiers');
const { evaluateScoreConfidence } = require('../lib/score-confidence-gate');
const { findOpeningEvents, findScoreEvents, staggerEvents, splitBacklog, localParts } = require('./select');
const { buildCaptions, postMarkers } = require('./captions');
const { resolveArt } = require('./art');
const { renderCard, closeBrowser } = require('./render');
const { MARKETS } = require('./config');

const ROOT = path.resolve(__dirname, '..', '..');
const HISTORY_FILE = path.join(ROOT, 'data', 'social-post-history.json');
const MAX_HISTORY = 365; // matches scripts/lib/merge-social-post-history.js

const args = process.argv.slice(2);
const arg = name => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };
const flag = name => args.includes(`--${name}`);

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
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
  const history = readJson(HISTORY_FILE, { _meta: { description: 'Tracks social media posts to prevent duplicate content', lastUpdated: null }, posts: [] });
  if (!Array.isArray(history.posts)) history.posts = [];
  return { shows, reviewsByShow, getOutletTier, slim, history };
}

const MAX_CHANNEL_ATTEMPTS = 3;
const RETRY_WINDOW_MS = 12 * 36e5; // a failed network is retried until 12h after the post's slot

/** History entries with networks still owed a post (an earlier run's channel error). */
function pendingRetries(history, now) {
  return (history.posts || []).filter(p => p.pending && Object.keys(p.pending).length
    && (p.attempts || 1) < MAX_CHANNEL_ATTEMPTS && Date.parse(p.dueAt) > now - RETRY_WINDOW_MS);
}

/**
 * Re-try the networks an earlier run failed on, reusing that run's image and texts.
 * findExistingPost still guards each one. Returns the number of channel errors.
 */
async function retryFailedChannels(history, channels, buffer, now, summary) {
  let errors = 0;
  for (const entry of pendingRetries(history, now)) {
    entry.attempts = (entry.attempts || 1) + 1;
    const show = { id: entry.showId, slug: entry.slug };
    const markers = postMarkers(entry.type, show);
    for (const [service, text] of Object.entries(entry.pending)) {
      const ch = channels.find(c => c.service === service);
      if (!ch) continue;
      try {
        const existing = await buffer.findExistingPost({ channel: ch, markers, sinceIso: new Date(now - 4 * 864e5).toISOString() });
        const post = existing || await buffer.createImagePost({ channel: ch, text, imageUrl: entry.imageUrl, altText: entry.altText || '', dueAt: new Date(Math.max(Date.parse(entry.dueAt), now + 10 * 60e3)) });
        entry.buffer[service] = post.id;
        delete entry.pending[service];
        delete entry.errors[service];
        console.log(`  ✓ retry ${entry.type} ${entry.showId} on ${service} (${post.id})`);
        summary.push(`| ${entry.type} (retry) | ${entry.showId} | ${entry.dueAt} | ${service} | - |`);
      } catch (e) {
        errors++;
        entry.errors[service] = e.message.slice(0, 300);
        console.log(`::error::retry ${entry.showId} ${entry.type} on ${service} (attempt ${entry.attempts}/${MAX_CHANNEL_ATTEMPTS}): ${e.message}`);
      }
    }
    if (!Object.keys(entry.pending).length) { delete entry.pending; delete entry.altText; }
    if (entry.errors && !Object.keys(entry.errors).length) delete entry.errors;
    writeHistory(history);
  }
  return errors;
}

function writeHistory(history) {
  history.posts = history.posts.slice(-MAX_HISTORY);
  history._meta = { ...(history._meta || {}), lastUpdated: new Date().toISOString() };
  fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`);
}

function fmtDate(ymd, tz) {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
}

/** Everything the card and captions need for one event. */
function describe(ev, ctx) {
  const show = ev.show;
  const pub = ctx.slim[show.id] || {};
  const tz = MARKETS[show.category].tz;
  if (ev.type === 'score') {
    if (!Number.isFinite(pub.cs)) throw new Error(`${show.id}: no Critic Score in public/data/shows`);
    // Rounded the way the site badge shows it (scripts/lib/canonical-critic-scores.ts).
    const score = Math.round(pub.cs);
    return { type: 'score', show, score, tierId: getScoreTierId(score, show.category), tierLabel: getScoreTierLabel(score, show.category), reviewCount: pub.rc, breakdown: pub.bd || null };
  }
  const ymd = String(show.openingDate).slice(0, 10);
  const today = localParts(new Date(ev.dueAt), tz).ymd;
  return { type: 'opening', show, dayLabel: today === ymd ? 'Tonight' : 'Opening', dateLabel: fmtDate(ymd, tz) };
}

async function buildCard(desc, outDir) {
  const art = await resolveArt(desc.show);
  const card = {
    event: desc.type, market: desc.show.category, title: desc.show.title, venue: desc.show.venue,
    score: desc.score, tierId: desc.tierId, tierLabel: desc.tierLabel, reviewCount: desc.reviewCount,
    dayLabel: desc.dayLabel, dateLabel: desc.dateLabel, art,
  };
  const out = path.join(outDir, `${desc.show.id}-${desc.type}.png`);
  await renderCard(card, out);
  return { path: out, layout: art.layout, artSource: art.source || null, artSize: art.width ? `${art.width}x${art.height}` : null };
}

function forcedEvent(ctx) {
  const id = arg('show');
  const type = arg('event') || 'score';
  const show = ctx.shows.find(s => s.id === id);
  if (!show) throw new Error(`--show=${id}: not in shows.json`);
  const gate = evaluateScoreConfidence({ showReviews: ctx.reviewsByShow[show.id] || [], category: show.category, getOutletTier: ctx.getOutletTier });
  return [{ type, show, gate, dueAt: new Date(Date.now() + 10 * 60e3) }];
}

async function main() {
  if (flag('list-channels')) {
    const { listChannels } = require('./buffer');
    for (const ch of await listChannels()) console.log(`${ch.service.padEnd(10)} ${ch.network ? 'will post' : 'ignored  '} ${ch.isQueuePaused ? '(queue paused) ' : ''}${ch.displayName || ch.name}  [${ch.id}]`);
    return;
  }
  if (process.env.SOCIAL_AUTOPOST_DISABLED === 'true') { console.log('[autopost] disabled by SOCIAL_AUTOPOST_DISABLED'); return; }

  const dryRun = flag('dry-run');
  const now = arg('now') ? Date.parse(arg('now')) : Date.now();
  const outDir = arg('out') || path.join(require('os').tmpdir(), 'social-autopost');
  const ctx = loadContext();

  let events;
  let backlogRecorded = 0;
  if (arg('show')) {
    if (!dryRun) throw new Error('--show is for previews; add --dry-run');
    events = forcedEvent(ctx);
  } else {
    events = [
      ...findOpeningEvents({ shows: ctx.shows, history: ctx.history, now }),
      ...findScoreEvents({ shows: ctx.shows, history: ctx.history, now, reviewsByShow: ctx.reviewsByShow, slim: ctx.slim, getOutletTier: ctx.getOutletTier }),
    ];
    const { post, skip } = splitBacklog(events, ctx.history, now);
    if (skip.length) {
      console.log(`[autopost] first run: skipping ${skip.length} older score post(s): ${skip.map(e => e.show.id).join(', ')}`);
      if (!dryRun && process.env.BUFFER_API_KEY) {
        const ymd = new Date(now).toISOString().slice(0, 10);
        for (const ev of skip) ctx.history.posts.push({ date: ymd, type: ev.type, showId: ev.show.id, skipped: 'backlog at go-live' });
        backlogRecorded = skip.length;
      }
    }
    events = staggerEvents(post, ctx.history, now);
  }
  console.log(`[autopost] ${events.length} post(s) due${dryRun ? ' (dry run)' : ''}`);
  const configured = !!process.env.BUFFER_API_KEY;
  if (flag('check')) {
    // Workflow gate: install the browser only when a card will be rendered. Without
    // a key, scheduled runs render nothing (a manual dispatch still renders as a check).
    const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
    const owed = pendingRetries(ctx.history, now).length;
    const due = configured ? events.length + owed : manual ? events.length : 0;
    if (owed) console.log(`  ${owed} earlier post(s) still owed on a network that failed`);
    if (!configured) console.log('::notice::BUFFER_API_KEY not set: nothing will be posted');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${due}\n`);
    for (const ev of events) console.log(`  ${ev.type} ${ev.show.id} due ${ev.dueAt.toISOString()}`);
    return;
  }
  if (!events.length && !(configured && !dryRun && pendingRetries(ctx.history, now).length)) {
    if (backlogRecorded) writeHistory(ctx.history);
    return;
  }

  if (!dryRun && !configured) console.log('::notice::BUFFER_API_KEY not set: cards are rendered as a check, nothing is posted');
  const live = !dryRun && configured;
  const buffer = live ? require('./buffer') : null;

  let channels = [];
  if (live) {
    channels = (await buffer.listChannels()).filter(c => c.network && !c.isQueuePaused);
    if (!channels.length) throw new Error('Buffer has no active Instagram/Facebook/X/Threads/Bluesky channel');
    console.log(`[autopost] channels: ${channels.map(c => c.service).join(', ')}`);
    if (backlogRecorded) writeHistory(ctx.history);
  }

  let failedEvents = 0, channelErrors = 0;
  const summary = [];
  if (live) channelErrors += await retryFailedChannels(ctx.history, channels, buffer, now, summary);
  try {
    for (const ev of events) {
      // One event's failure must not lose the record of events already scheduled:
      // each is written to history as soon as Buffer accepts it.
      try {
        const desc = describe(ev, ctx);
        const captions = buildCaptions(desc);
        const card = await buildCard(desc, outDir);
        console.log(`\n[autopost] ${ev.type} ${ev.show.id} due ${ev.dueAt.toISOString()} card=${card.path} layout=${card.layout} art=${card.artSize || '-'}`);
        console.log(`  X/Bluesky: ${captions.twitter.replace(/\n/g, ' | ')}`);
        if (!live) continue;

        const { encodeForSocial, hostImage } = require('./host');
        const jpeg = await encodeForSocial(card.path);
        const ymd = new Date(now).toISOString().slice(0, 10);
        const imageUrl = await hostImage(jpeg.buffer, `${ymd.slice(0, 7)}/${ev.show.id}-${ev.type}.jpg`);

        if (!ctx.history._meta || !ctx.history._meta.bufferValidatedAt) {
          // First live post ever: prove every channel accepts this exact post shape
          // with throwaway drafts before anything is published.
          const problems = await buffer.validateChannels(channels, { imageUrl, altText: captions.altText });
          if (problems.length) throw new Error(`Buffer self-test failed, nothing posted: ${problems.join(' | ')}`);
          ctx.history._meta = { ...(ctx.history._meta || {}), bufferValidatedAt: new Date().toISOString() };
          writeHistory(ctx.history);
          console.log('[autopost] Buffer self-test passed on every channel');
        }

        const markers = postMarkers(ev.type, ev.show);
        const sinceIso = new Date(now - 4 * 864e5).toISOString();
        const posted = {}, errors = {};
        for (const ch of channels) {
          try {
            const existing = await buffer.findExistingPost({ channel: ch, markers, sinceIso });
            if (existing) {
              posted[ch.service] = existing.id;
              console.log(`  = ${ch.service} already in Buffer (${existing.id}, ${existing.status})`);
              continue;
            }
            const post = await buffer.createImagePost({ channel: ch, text: captions[ch.network], imageUrl, altText: captions.altText, dueAt: ev.dueAt });
            posted[ch.service] = post.id;
            console.log(`  ✓ ${ch.service} scheduled (${post.id})`);
          } catch (e) {
            errors[ch.service] = e.message.slice(0, 300);
            channelErrors++;
            console.log(`::error::${ev.show.id} ${ev.type} on ${ch.service}: ${e.message}`);
          }
        }
        if (!Object.keys(posted).length) { failedEvents++; continue; } // nothing went out: retry next run
        const entry = { date: ymd, type: ev.type, showId: ev.show.id, slug: ev.show.slug || ev.show.id, dueAt: ev.dueAt.toISOString(), imageUrl, text: captions.twitter, buffer: posted };
        if (Object.keys(errors).length) {
          // Retried by retryFailedChannels() on later runs with these exact texts, so
          // every network carries the same numbers.
          entry.errors = errors;
          entry.pending = Object.fromEntries(channels.filter(c => errors[c.service]).map(c => [c.service, captions[c.network]]));
          entry.altText = captions.altText;
          entry.attempts = 1;
        }
        ctx.history.posts.push(entry);
        writeHistory(ctx.history);
        summary.push(`| ${ev.type} | ${ev.show.title} | ${ev.dueAt.toISOString()} | ${Object.keys(posted).join(', ')} | ${Object.keys(errors).join(', ') || '-'} |`);
      } catch (e) {
        failedEvents++;
        console.log(`::error::${ev.type} ${ev.show.id}: ${e.message}`);
        if (/self-test failed|BUFFER_API_KEY|HTTP 401|rate limit/i.test(e.message)) break; // account-level: stop
      }
    }
  } finally {
    await closeBrowser();
  }

  if (summary.length && process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## Scheduled in Buffer', '', '| Post | Show | Goes out (UTC) | Networks | Failed |', '|---|---|---|---|---|', ...summary,
      '', 'Undo a post: delete it in Buffer (publish.buffer.com). Stop all posting: set the repository variable SOCIAL_AUTOPOST_DISABLED=true.', ''].join('\n'));
  }

  // Partial failures are recorded (so the working channels are not re-posted) and
  // still fail the job, so notify-failure tells the owner a network stopped posting.
  if (failedEvents || channelErrors) {
    console.error(`[autopost] ${failedEvents} post(s) failed, ${channelErrors} channel error(s)`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch(err => { console.error(`[autopost] ${err.stack || err.message}`); process.exit(1); });
}

module.exports = { describe, pendingRetries };
