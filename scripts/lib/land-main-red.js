'use strict';

/**
 * land-main-red.js — which land.yml lanes are main-red fix lanes.
 *
 * A main-red lane (branch `land/**main-red**`, e.g. land/main-red-bro-5079) is
 * queued first in the landing mutex (scripts/lib/land-mutex.js ticketName) and
 * is re-run first by the stranded-run sweep (land-queue-backoff.decideSweep).
 *
 * History: BRO-5096 added an `admit` job that held ordinary lanes in a
 * sleep-poll while a main-red lane was ahead, to protect the single pending
 * seat of the old global `landing` group. BRO-5112 made that group per-branch
 * and put the priority in the mutex, so the seat is gone; BRO-5194 removed
 * the job because its ~6 sleeping runners starved test.yml on main.
 * Priority is by ticket order only: a lane still in Checks holds no ticket, so
 * a main-red fix waits at most for the one landing already holding the lock.
 */

const isMainRedBranch = (branch) => /^land\/.*main-red/i.test(branch || '');

module.exports = { isMainRedBranch };
