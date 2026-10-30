'use strict';

/**
 * outlet-registry-alias: clear an "outlet domain move" digest row in
 * data/outlet-registry.json for execute-approved-fix.js (BRO-6632).
 *
 *   { type: 'outlet-registry-alias', outletId, host, kind: 'domainAlias'|'notDomainMove', reason }
 *
 * The probable-domain-move detector (silent-exclusion-detectors.js) flags an
 * unregistered census host whose slug equals a registered outlet's own domain
 * slug. Two honest answers exist and no pending-fix action could write either,
 * so every cloud worker on those rows paused:
 *   - domainAlias: the host IS that outlet (it moved) -> append to domainAliases
 *   - notDomainMove: checked, it is a different paper -> append to notDomainMoves
 * Guards: the host must slug-match the outlet's `domain` (the pairing the
 * detector reports; anything else is not this row), must not already be
 * registered under ANOTHER outlet (a silent steal), and a domainAlias must not
 * already be recorded as a notDomainMove (or vice versa) without the owner
 * resolving the contradiction. Already-present is an ok no-op.
 *
 * Pure: mutates the parsed registry, returns {ok, msg} or {ok:false, reason}.
 */

const { normalizeHostSlug, MIN_SLUG_LENGTH } = require('./silent-exclusion-detectors');
const { registrableHost } = require('./non-review-url-patterns');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;
const KINDS = { domainAlias: 'domainAliases', notDomainMove: 'notDomainMoves' };

const norm = (h) => registrableHost(String(h).toLowerCase());
const hostsOf = (o) => [o.domain, ...(o.domainAliases || []), ...(o.domains || []), ...(o.alternateDomains || [])].filter(Boolean);

function applyOutletRegistryAlias(registry, action, { nowMs = Date.now() } = {}) {
  const { outletId, kind, reason } = action || {};
  const host = action && typeof action.host === 'string' ? action.host.trim().toLowerCase() : '';
  const tag = `outlet-registry-alias ${outletId}`;
  if (!outletId || !ID_RE.test(outletId)) return { ok: false, reason: 'outlet-registry-alias: outletId missing or malformed' };
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind)) return { ok: false, reason: `${tag}: kind must be domainAlias or notDomainMove` };
  if (!HOST_RE.test(host)) return { ok: false, reason: `${tag}: host must be a bare hostname (no scheme or path)` };
  if (!reason || String(reason).trim().length < 10) return { ok: false, reason: `${tag}: reason (>=10 chars) required` };
  const outlets = registry && registry.outlets;
  if (!outlets || !Object.prototype.hasOwnProperty.call(outlets, outletId)) return { ok: false, reason: `${tag}: not in outlet-registry.json` };
  const entry = outlets[outletId];
  if (!entry.domain) return { ok: false, reason: `${tag}: outlet has no domain, so there is no move to judge` };

  const slug = normalizeHostSlug(host);
  const domainSlug = normalizeHostSlug(entry.domain);
  if (slug.length < MIN_SLUG_LENGTH || slug !== domainSlug) {
    return { ok: false, reason: `${tag}: host ${host} does not slug-match domain ${entry.domain}, so the move detector never pairs them` };
  }

  const field = KINDS[kind];
  const other = KINDS[kind === 'domainAlias' ? 'notDomainMove' : 'domainAlias'];
  const key = norm(host);
  if ((entry[field] || []).some((h) => norm(h) === key)) return { ok: true, changed: false, msg: `${outletId}: ${host} already in ${field}` };
  if ((entry[other] || []).some((h) => norm(h) === key)) return { ok: false, reason: `${tag}: ${host} is already recorded in ${other}; a human resolves the contradiction` };
  if (kind === 'domainAlias') {
    for (const [id, o] of Object.entries(outlets)) {
      if (id !== outletId && o && hostsOf(o).some((h) => norm(h) === key)) return { ok: false, reason: `${tag}: ${host} is already registered under ${id}` };
    }
  }

  entry[field] = [...(entry[field] || []), host];
  const at = new Date(nowMs).toISOString();
  registry._meta = { ...(registry._meta || {}), lastUpdated: at, lastChange: `BRO-6632: ${field} ${outletId} += ${host} (${String(reason).trim().slice(0, 120)})` };
  return { ok: true, changed: true, msg: `${outletId}: ${host} added to ${field}` };
}

module.exports = { applyOutletRegistryAlias };
