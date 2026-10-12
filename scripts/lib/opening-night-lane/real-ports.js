'use strict';
/**
 * Real publish ports for the opening-night lane (BRO-4823): the production side of publish.publishLaneReviews, which
 * otherwise only has the rehearsal's injected ports. One set of ports is bound to one show.
 *
 * Two checkouts are involved and they are not always the same file:
 *   - repoDir: the Broadwayscore checkout. The show-JSON generator reads repoDir/data/reviews.json. In CI that is a
 *     plain copy made by checkout-core-data; locally it is a symlink into the private data checkout.
 *   - coreDir: a git checkout of the private core-data repo, which is where reviews.json is committed and pushed.
 *
 * How a batch ships:
 *   updateReviews  merges the lane rows into repoDir/data/reviews.json (compare-and-swap file port) and remembers the
 *                  merge so it can be replayed.
 *   pushData       compare-and-swap against the remote, never a rebase: fetch, reset coreDir to the remote tip, replay
 *                  the remembered merges, commit, plain push; a rejected push starts over from the new tip. reviews.json
 *                  has 20+ writers and push-with-retry's `rebase -X theirs` can drop a concurrent writer's rows on a
 *                  line conflict in a 19 MB file, which is why that helper is not used here. It refuses to run if
 *                  coreDir has foreign uncommitted changes or unpushed commits, since the reset would discard them.
 *   regenShow      regenerates public/data/shows/{id}.json and reports any landed URL that is not in it.
 *   deploy         nothing to do: prebuild regenerates every show JSON from core data at build time, and the deploy
 *                  gate's data-changed path (should-deploy-gate.js) ships a core-data push on the next 5-minute cron.
 *                  Committing the show JSON to main would never reach the site and would race rebuild-fast's commits.
 *   fetchLiveShow  the live site, cache-busted; publishLaneReviews' poll is the deploy verification.
 *   isLeased       read from the shared lease store, not the local leases.json (only `sync` writes that, so it is a
 *                  stale snapshot inside the lane), and only true when the live lease is held by this lane's holder.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const publish = require('./publish');
const lease = require('./lease');
const leaseStore = require('./lease-store');
const { canonicalUrl } = require('./discovery');

const DEFAULT_BASE_URL = 'https://broadwayscorecard.com';
const BOT_IDENTITY = ['-c', 'user.name=opening-night-lane', '-c', 'user.email=opening-night-lane@users.noreply.github.com'];

function createRealPublishPorts({
  show, repoDir, coreDir, holder, baseUrl = DEFAULT_BASE_URL, remote = 'origin', branch = 'main', attempts = 5,
  now, exec = execFileSync, regen, readLeases = leaseStore.readRemote, fetchImpl,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  for (const [k, v] of Object.entries({ show, repoDir, coreDir, holder })) if (!v) throw new Error(`real-ports: ${k} is required`);
  const siteFile = path.join(repoDir, 'data', 'reviews.json');
  const coreFile = path.join(coreDir, 'reviews.json');
  const sitePort = publish.createReviewsFilePort(siteFile);
  const regenerate = regen || publish.regenShowViaScript({ cwd: repoDir });
  const merges = []; // merges applied to the site file and not yet pushed

  const git = (args) => String(exec('git', [...BOT_IDENTITY, ...args], {
    cwd: coreDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }) || '').trimEnd(); // not trim(): porcelain status lines start with a space
  const gitOk = (args) => { try { git(args); return true; } catch { return false; } };
  const syncSiteFile = () => { if (fs.realpathSync(siteFile) !== fs.realpathSync(coreFile)) fs.copyFileSync(coreFile, siteFile); };

  async function pushData() {
    if (!merges.length) return { ok: true, stderr: '' };
    const foreign = git(['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean).filter((l) => l.slice(3) !== 'reviews.json');
    if (foreign.length) return { ok: false, stderr: `refusing to reset ${coreDir}: uncommitted changes (${foreign.slice(0, 3).join('; ')})` };
    let lastErr = '';
    for (let i = 0; i < attempts; i++) {
      try {
        git(['fetch', '--no-tags', '--quiet', remote, branch]);
        if (i === 0) {
          const ahead = Number(git(['rev-list', '--count', 'FETCH_HEAD..HEAD']));
          if (ahead > 0) return { ok: false, stderr: `refusing to reset ${coreDir}: ${ahead} unpushed commit(s)` };
        }
        git(['reset', '--hard', '--quiet', 'FETCH_HEAD']);
        const corePort = publish.createReviewsFilePort(coreFile);
        for (const fn of merges) await corePort.updateReviews(fn);
        git(['add', 'reviews.json']);
        if (gitOk(['diff', '--cached', '--quiet'])) { merges.length = 0; syncSiteFile(); return { ok: true, stderr: '', unchanged: true }; }
        git(['commit', '--quiet', '-m', `lane: ${show} reviews [skip ci]`]);
        git(['push', '--quiet', remote, `HEAD:${branch}`]);
        merges.length = 0;
        syncSiteFile();
        return { ok: true, stderr: '' };
      } catch (e) {
        lastErr = String((e && (e.stderr || e.message)) || e);
        if (i < attempts - 1) await sleep(2000 * (i + 1));
      }
    }
    return { ok: false, stderr: lastErr };
  }

  return {
    async updateReviews(fn) {
      const out = await sitePort.updateReviews(fn);
      merges.push(fn);
      return out;
    },
    pushData,
    async isLeased(s) {
      if (s !== show) return false;
      try {
        const { state } = readLeases({ repoDir });
        const live = lease.activeLeaseFor(state, s, { now: now ? now() : undefined });
        return !!live && live.holder === holder;
      } catch { return false; } // an unreadable lease store is not permission to publish
    },
    async regenShow(s, landedUrls = []) {
      await regenerate(s);
      const doc = JSON.parse(fs.readFileSync(path.join(repoDir, 'public', 'data', 'shows', `${s}.json`), 'utf8'));
      const present = new Set((doc.rv || []).map((x) => canonicalUrl(x && x.u)).filter(Boolean));
      return { missing: landedUrls.filter((u) => !present.has(canonicalUrl(u))) };
    },
    async deploy() { return { shippedBy: 'core-data push (deploy gate data-changed path)' }; },
    fetchLiveShow: publish.fetchLiveShowFrom(baseUrl, fetchImpl ? { fetchImpl } : {}),
  };
}

module.exports = { DEFAULT_BASE_URL, createRealPublishPorts };
