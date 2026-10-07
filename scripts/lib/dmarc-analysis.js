#!/usr/bin/env node
// scripts/lib/dmarc-analysis.js — turn a pile of parsed DMARC aggregate
// reports into a deliverability verdict.
//
// WHAT THIS IS FOR: a DMARC aggregate report is only useful as a time series.
// One report says "14 messages passed"; 233 of them say "no unauthenticated
// sender has ever used this domain, so the policy can be tightened", or
// "something started spoofing us on the 4th". This module does the second
// thing. It is the reason the reports are ingested at all.
//
// Pure functions only — no fs, no network, no clock except an injected `now`,
// so the findings are deterministic and testable.
//
// Tested by scripts/lib/dmarc-analysis.test.mjs (CLAUDE.md rule 15 — the
// test require()s these functions, it does not restate them).

'use strict';

const { recordPasses } = require('./dmarc-report-parser');

const DEFAULTS = {
  // Below this pass rate the domain has a live authentication problem.
  minPassRateForHealthy: 0.99,
  // A single failing source is worth naming; five is worth paging about.
  failCountForHigh: 5,
  // Evidence needed before recommending a policy upgrade. 30 days is one full
  // reporting cycle for slow reporters; 1000 messages means the sample covers
  // real sending, not one test blast.
  upgradeMinDays: 30,
  upgradeMinMessages: 1000,
  // Reporters send daily. Nothing for 3 days means the rua address broke or
  // the DNS record was edited — silence is the failure mode that looks like
  // success, so it has to be a finding of its own.
  staleAfterDays: 3,
};

/** True when `domain` is the policy domain itself or a subdomain of it. */
function isUnderDomain(domain, policyDomain) {
  if (!domain || !policyDomain) return false;
  return domain === policyDomain || domain.endsWith(`.${policyDomain}`);
}

/**
 * Known-good sending infrastructure, identified by the authenticated domain
 * rather than by IP. IP allowlists rot the moment SES or ImprovMX renumbers;
 * the DKIM d= / SPF domain is the thing that is actually asserted and checked.
 *
 * The send.* and improvmx checks are anchored to OUR domain on purpose: an
 * unanchored /send\./ would label a spoofer authenticating as
 * send.attacker.example as our own Resend infrastructure, which is precisely
 * the source this file exists to make visible.
 */
function classifySource(source, policyDomain) {
  const domains = [...source.dkimDomains, ...source.spfDomains];
  const spfOurs = [...(source.spfPassDomains || source.spfDomains)].filter((d) => isUnderDomain(d, policyDomain));
  const dkimOurs = [...source.dkimDomains].filter((d) => isUnderDomain(d, policyDomain));

  if (spfOurs.some((d) => /^send\./.test(d))) return 'resend';
  if (spfOurs.length && (domains.includes('amazonses.com') || source.dkimSelectors.has('resend'))) return 'resend';
  // ImprovMX relays pass SPF for our ROOT domain (whose record carries
  // include:spf.improvmx.com) and sign as improvmx.net — so the vendor is
  // named by the DKIM side, and only trusted because SPF already proved the
  // connection was authorised by our own DNS.
  if (spfOurs.length && (domains.some((d) => /improvmx/.test(d)) || [...source.dkimSelectors].some((s) => /improvmx/.test(s)))) {
    return 'improvmx-forward';
  }
  if (spfOurs.length) return 'domain-authenticated';
  // Carries our DKIM but connected from someone else's host: a forwarder,
  // i.e. a recipient relaying our mail onward.
  if (dkimOurs.length && source.pass > 0) return 'forwarder';
  if (source.pass > 0 && source.fail === 0) return 'authenticated-third-party';
  return 'unknown';
}

/**
 * Whether a source may be named in the published summary.
 *
 * PRIVACY (this repo is public): when a subscriber forwards our mail, THEIR
 * mail host becomes the "source" of the next hop — a university mail server, a
 * residential ISP address, a small company's Exchange tenant. Publishing those
 * IPs and domains discloses who reads the newsletter just as surely as
 * <envelope_to> would. So only two kinds of source are named:
 *   - our own sending infrastructure (authenticates under the policy domain)
 *   - sources that FAILED authentication, which is the security signal the
 *     owner needs to act on and is not a recipient disclosure
 * Everything else is counted, never named.
 */
function isPublishableSource(source, policyDomain) {
  if (source.fail > 0) return true;
  // Ownership is decided on a PASSING SPF check, not DKIM and not the mere
  // presence of our domain in the SPF result.
  //
  // DKIM travels with the message — that is exactly why forwarded mail still
  // passes DMARC — so every forwarding recipient also presents d=ourdomain.
  // And a forwarder often preserves our envelope sender, so the reporter
  // records an SPF check against send.<ourdomain> that SOFTFAILED (24 such
  // messages in this domain's corpus). Only a host actually authorised to
  // send for us gets result=pass, so that is the test.
  return [...source.spfPassDomains].some((d) => isUnderDomain(d, policyDomain));
}

/**
 * Stable identity for a report.
 *
 * report_id is the natural key, but it is optional in the schema and some
 * reporters omit it. Falling back to the covered time range keeps those
 * reports deduplicated too — without the fallback, an id-less report is
 * counted once per ingest run (about 30 times over a 30-day lookback), which
 * inflates message totals and dilutes the failure rate toward zero. That is
 * the failure mode that makes a monitor lie in the safe-looking direction.
 */
function reportKey(r) {
  return r.reportId
    ? `${r.orgName}|id:${r.reportId}`
    : `${r.orgName}|range:${r.dateBegin}|${r.dateEnd}`;
}

/**
 * Aggregate parsed reports into a summary.
 *
 * Reports are deduplicated by reporter + identity. No duplicate has appeared
 * in this domain's corpus yet (233 reports, duplicatesDropped = 0 — and note
 * that "Outlook.com" and "Enterprise Outlook" are two DIFFERENT reporters
 * covering the same day, not a duplicate). The guard is here because the
 * ingest re-fetches an overlapping Gmail window on every run, so the same
 * report is presented repeatedly by construction; without it, every total
 * inflates and every failure rate is diluted toward zero.
 */
function summarizeReports(reports, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const seen = new Set();
  const deduped = [];
  let duplicatesDropped = 0;
  for (const r of reports) {
    const key = reportKey(r);
    if (seen.has(key)) { duplicatesDropped++; continue; }
    seen.add(key);
    deduped.push(r);
  }
  // Null-safe ordering. A report with an unparseable <date_range> yields null
  // dates, and String(null) === "null" sorts AFTER every real ISO timestamp —
  // so a single malformed report would become "the latest report", supplying
  // the published policy and a null windowEnd that silently disables the
  // staleness check forever.
  const iso = (v) => (typeof v === 'string' && v ? v : '');
  deduped.sort((a, b) => iso(a.dateBegin).localeCompare(iso(b.dateBegin)));
  const dated = deduped.filter((r) => iso(r.dateBegin) && iso(r.dateEnd));
  const undatedCount = deduped.length - dated.length;

  const reporters = {};
  const sources = new Map();
  const headerFroms = {};
  let total = 0, pass = 0, fail = 0;
  let both = 0, dkimOnly = 0, spfOnly = 0, neither = 0;
  const dispositions = {};

  for (const r of deduped) {
    reporters[r.orgName] = (reporters[r.orgName] || 0) + 1;
    for (const rec of r.records) {
      const n = rec.count;
      total += n;
      const d = rec.evaluatedDkim === 'pass';
      const s = rec.evaluatedSpf === 'pass';
      if (d && s) both += n; else if (d) dkimOnly += n; else if (s) spfOnly += n; else neither += n;
      dispositions[rec.disposition] = (dispositions[rec.disposition] || 0) + n;
      if (rec.headerFrom) headerFroms[rec.headerFrom] = (headerFroms[rec.headerFrom] || 0) + n;

      const passed = recordPasses(rec);
      if (passed) pass += n; else fail += n;

      let src = sources.get(rec.sourceIp);
      if (!src) {
        src = {
          ip: rec.sourceIp,
          count: 0, pass: 0, fail: 0,
          dkimDomains: new Set(), spfDomains: new Set(), spfPassDomains: new Set(), dkimSelectors: new Set(),
          headerFroms: new Set(),
          firstSeen: r.dateBegin, lastSeen: r.dateEnd,
          dispositions: new Set(),
        };
        sources.set(rec.sourceIp, src);
      }
      src.count += n;
      if (passed) src.pass += n; else src.fail += n;
      rec.dkim.forEach((k) => { if (k.domain) src.dkimDomains.add(k.domain); if (k.selector) src.dkimSelectors.add(k.selector); });
      rec.spf.forEach((k) => {
        if (!k.domain) return;
        src.spfDomains.add(k.domain);
        // Tracked separately from spfDomains: a forwarder that preserves our
        // envelope sender produces an SPF result for OUR domain that softfails,
        // and only the passing case means the host is authorised to send for us.
        if (k.result === 'pass') src.spfPassDomains.add(k.domain);
      });
      if (rec.headerFrom) src.headerFroms.add(rec.headerFrom);
      src.dispositions.add(rec.disposition);
      if (iso(r.dateBegin) && (!iso(src.firstSeen) || r.dateBegin < src.firstSeen)) src.firstSeen = r.dateBegin;
      if (iso(r.dateEnd) && (!iso(src.lastSeen) || r.dateEnd > src.lastSeen)) src.lastSeen = r.dateEnd;
    }
  }

  // The newest DATED report defines the published policy and the window end.
  const latest = dated.length ? dated[dated.length - 1] : deduped[deduped.length - 1];
  const policyDomain = latest ? latest.policy.domain : '';

  const allSources = [...sources.values()];
  // Forwarding recipients are counted, never named — see isPublishableSource.
  const redacted = allSources.filter((s) => !isPublishableSource(s, policyDomain));
  const forwarders = {
    sourceCount: redacted.length,
    messages: redacted.reduce((n, s) => n + s.count, 0),
    pass: redacted.reduce((n, s) => n + s.pass, 0),
    fail: redacted.reduce((n, s) => n + s.fail, 0),
  };

  const sourceList = allSources
    .filter((s) => isPublishableSource(s, policyDomain))
    .map((s) => ({
      ip: s.ip,
      count: s.count,
      pass: s.pass,
      fail: s.fail,
      dkimDomains: [...s.dkimDomains].sort(),
      spfDomains: [...s.spfDomains].sort(),
      dkimSelectors: [...s.dkimSelectors].sort(),
      headerFroms: [...s.headerFroms].sort(),
      dispositions: [...s.dispositions].sort(),
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      classification: classifySource(s, policyDomain),
    }))
    .sort((a, b) => b.count - a.count);

  const summary = {
    windowStart: dated.length ? dated[0].dateBegin : null,
    windowEnd: dated.length ? dated.reduce((acc, r) => (r.dateEnd > acc ? r.dateEnd : acc), dated[0].dateEnd) : null,
    undatedReports: undatedCount,
    forwarders,
    sourceCountTotal: allSources.length,
    reportCount: deduped.length,
    duplicatesDropped,
    reporters,
    policy: latest ? latest.policy : null,
    policyTimeline: buildPolicyTimeline(deduped),
    messages: {
      total,
      pass,
      fail,
      passRate: total > 0 ? pass / total : null,
    },
    // How each passing message earned its pass. dkimOnly is forwarded mail
    // (SPF breaks across a forwarder, DKIM survives); spfOnly is the fragile
    // case — those messages fail the moment anyone forwards them.
    authSplit: { both, dkimOnly, spfOnly, neither },
    dispositions,
    headerFroms,
    sources: sourceList,
  };
  summary.findings = evaluateFindings(summary, opts);
  return summary;
}

function buildPolicyTimeline(reports) {
  const timeline = [];
  let last = '';
  for (const r of reports) {
    if (!r.policy || !r.policy.p) continue;
    const sig = `${r.policy.p}|${r.policy.sp}|${r.policy.pct}|${r.policy.adkim}|${r.policy.aspf}`;
    if (sig === last) continue;
    // Reporters disagree transiently while a DNS change propagates; only
    // record a change once it is the newest observation, not every flip-flop.
    timeline.push({ observedAt: r.dateBegin, reporter: r.orgName, p: r.policy.p, sp: r.policy.sp, pct: r.policy.pct, adkim: r.policy.adkim, aspf: r.policy.aspf });
    last = sig;
  }
  return timeline;
}

function daysBetween(aIso, bIso) {
  const a = Date.parse(aIso), b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.abs(b - a) / 86400000;
}

/**
 * Derive actionable findings. Severity vocabulary matches the repo's alert
 * router: 'action' is owner-facing, 'warn' is log-only, 'info' is context.
 */
function evaluateFindings(summary, opts = DEFAULTS) {
  const o = { ...DEFAULTS, ...opts };
  const findings = [];
  const { messages, policy } = summary;

  if (!summary.reportCount) {
    findings.push({
      severity: 'action',
      code: 'no-reports',
      message: 'No DMARC aggregate reports available in the window — the rua address may be wrong or the DMARC record may have been removed.',
    });
    return findings;
  }

  // Silence looks like success: reporters send daily, so a gap means the
  // reporting path broke, not that nothing was sent.
  if (o.now && summary.windowEnd) {
    const staleDays = daysBetween(summary.windowEnd, o.now);
    if (staleDays > o.staleAfterDays) {
      findings.push({
        severity: 'action',
        code: 'reports-stale',
        message: `Newest DMARC report covers ${summary.windowEnd} — ${staleDays.toFixed(1)} days ago. Reporters send daily; check the rua= address in the DMARC record.`,
        evidence: { windowEnd: summary.windowEnd, staleDays: Number(staleDays.toFixed(1)) },
      });
    }
  }

  // An attachment that could not be parsed is a hole in the evidence, and a
  // hole reads as "no failures seen" — the reassuring direction. If Google's
  // reports stop parsing while Microsoft's still arrive, the pass rate stays
  // 100% and nothing else here would ever say otherwise.
  if (o.parseFailures > 0) {
    findings.push({
      severity: 'action',
      code: 'report-parse-failures',
      message: `${o.parseFailures} report attachment(s) could not be parsed — this window's verdict is computed from incomplete evidence.`,
      evidence: { parseFailures: o.parseFailures, examples: (o.parseFailureExamples || []).slice(0, 3) },
    });
  }

  // Sources sending as us that no aligned identifier vouches for. This is the
  // finding the whole pipeline exists to surface: spoofing, or a legitimate
  // sender someone added without configuring DKIM.
  const failing = summary.sources.filter((s) => s.fail > 0).sort((a, b) => b.fail - a.fail);
  for (const s of failing) {
    findings.push({
      severity: s.fail >= o.failCountForHigh ? 'action' : 'warn',
      code: 'unauthenticated-source',
      message: `${s.fail} message(s) from ${s.ip} used header From: ${s.headerFroms.join(', ') || '(unknown)'} without passing aligned DKIM or SPF.`,
      evidence: {
        ip: s.ip,
        fail: s.fail,
        pass: s.pass,
        dkimDomains: s.dkimDomains,
        spfDomains: s.spfDomains,
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
        classification: s.classification,
      },
    });
  }

  // Reports arrived but describe no mail at all. Every rate-based check
  // divides by zero and abstains, so without this the verdict reads healthy
  // on a corpus that says nothing.
  if (summary.reportCount > 0 && messages.total === 0) {
    findings.push({
      severity: 'action',
      code: 'no-messages-reported',
      message: `${summary.reportCount} report(s) parsed but they describe zero messages — the reports may be malformed or the schema may have shifted.`,
      evidence: { reportCount: summary.reportCount },
    });
  }

  if (summary.undatedReports > 0) {
    findings.push({
      severity: 'warn',
      code: 'undated-reports',
      message: `${summary.undatedReports} report(s) had an unreadable <date_range> and are excluded from the window.`,
      evidence: { undatedReports: summary.undatedReports },
    });
  }

  if (messages.passRate !== null && messages.passRate < o.minPassRateForHealthy) {
    findings.push({
      severity: 'action',
      code: 'pass-rate-degraded',
      message: `DMARC pass rate is ${(messages.passRate * 100).toFixed(2)}% (${messages.fail} of ${messages.total} messages failed).`,
      evidence: { passRate: messages.passRate, fail: messages.fail, total: messages.total },
    });
  }

  if (policy && policy.p === 'none') {
    findings.push({
      severity: 'action',
      code: 'policy-unenforced',
      message: 'DMARC policy is p=none: receivers are told to take no action on mail that fails authentication, so the domain is spoofable.',
      evidence: { p: policy.p },
    });
  }

  // The payoff of a clean history: enough evidence to tighten enforcement.
  //
  // Evaluated against lifetime totals when the caller supplies them (the cron
  // fetches a bounded recent window, so the window alone would never
  // accumulate the required history and this finding could never fire).
  const evidenceTotal = o.lifetime ? o.lifetime.messages : messages.total;
  const evidenceFail = o.lifetime ? o.lifetime.failures : messages.fail;
  const evidenceDays = o.lifetime ? o.lifetime.spanDays : daysBetween(summary.windowStart, summary.windowEnd);
  if (
    policy && policy.p && policy.p !== 'reject' &&
    evidenceFail === 0 &&
    evidenceTotal >= o.upgradeMinMessages &&
    evidenceDays >= o.upgradeMinDays
  ) {
    findings.push({
      severity: 'info',
      code: 'policy-upgrade-available',
      message: `Zero authentication failures across ${evidenceTotal} messages over ${Math.round(evidenceDays)} days. The domain qualifies for p=reject (currently p=${policy.p}).`,
      evidence: {
        p: policy.p,
        total: evidenceTotal,
        windowDays: Math.round(evidenceDays),
        distinctSources: summary.sources.length,
        basis: o.lifetime ? 'lifetime-ledger' : 'fetched-window',
      },
    });
  }

  // Mail that passes on SPF alone dies the moment a recipient forwards it.
  if (summary.authSplit.spfOnly > 0) {
    findings.push({
      severity: 'info',
      code: 'spf-only-passes',
      message: `${summary.authSplit.spfOnly} message(s) passed on SPF alone (no aligned DKIM signature) — these would fail DMARC if forwarded.`,
      evidence: { spfOnly: summary.authSplit.spfOnly },
    });
  }

  return findings;
}

/** Highest severity present, for exit codes and alert routing. */
function worstSeverity(findings) {
  if (findings.some((f) => f.severity === 'action')) return 'action';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  if (findings.length) return 'info';
  return 'ok';
}

/**
 * Health-check verdict over a written dmarc-summary.json.
 *
 * WHY THIS EXISTS: routeAlert only fires on 'action' findings. Everything
 * milder — including 'policy-upgrade-available', which is the entire payoff of
 * a clean history — would otherwise be written to a file nobody opens, which
 * is the exact failure this card was filed about. This is the wiring that puts
 * the softer findings in the daily digest instead.
 *
 * @param {object|null} summary  Parsed data/audit/dmarc-summary.json, or null.
 * @param {object} opts          { now, staleHours } — injected for testability.
 * @returns {{status: 'pass'|'warn'|'error', message: string, hint?: string}}
 */
function dmarcHealthResult(summary, opts = {}) {
  // 96h, measured against the newest REPORT rather than the file's write time.
  // The ingest deliberately does not rewrite an unchanged summary, so on a
  // healthy, stable domain generatedAt goes stale by design — keying staleness
  // to it would manufacture a daily false alarm. Report freshness catches both
  // real failures anyway: if the job stops running, the newest report stops
  // advancing too.
  const staleHours = opts.staleHours || 96;
  if (!summary) {
    return { status: 'warn', message: 'No DMARC summary (the dmarc job in Daily Gmail Ingest may not have run)', hint: 'Run the "Daily Gmail Ingest" workflow' };
  }
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const newestReport = (summary.lifetime && summary.lifetime.lastReport) || summary.windowEnd;
  const reportAt = Date.parse(newestReport);
  const ageHours = Number.isFinite(reportAt) ? (now - reportAt) / 3600000 : Infinity;
  if (ageHours > staleHours) {
    const age = Number.isFinite(ageHours) ? `${Math.round(ageHours / 24)}d` : 'never';
    return { status: 'warn', message: `Newest DMARC report is ${age} old (reporters send daily)`, hint: 'The dmarc job in Daily Gmail Ingest may be failing, or the rua= address in the DMARC record may be wrong' };
  }

  const findings = Array.isArray(summary.findings) ? summary.findings : [];
  const actionable = findings.filter((f) => f.severity === 'action');
  if (actionable.length) {
    return { status: 'error', message: `${actionable.length} DMARC finding(s): ${actionable.map((f) => f.code).join(', ')}`, hint: actionable[0].message };
  }
  const warnings = findings.filter((f) => f.severity === 'warn');
  if (warnings.length) {
    return { status: 'warn', message: `${warnings.length} DMARC warning(s): ${warnings.map((f) => f.code).join(', ')}`, hint: warnings[0].message };
  }

  const lifetime = summary.lifetime || {};
  const upgrade = findings.find((f) => f.code === 'policy-upgrade-available');
  if (upgrade) {
    return { status: 'warn', message: upgrade.message, hint: 'Tighten the _dmarc TXT record to p=reject once you are ready' };
  }
  const p = summary.policy ? summary.policy.p : '?';
  return { status: 'pass', message: `${lifetime.messages || 0} messages, ${lifetime.failures || 0} auth failures (p=${p})` };
}

/** Human-readable digest — used by the CLI and by the owner alert body. */
function formatSummary(summary) {
  const m = summary.messages;
  const lines = [];
  lines.push(`DMARC ${summary.policy ? summary.policy.domain : '(unknown domain)'} — ${summary.windowStart || '?'} to ${summary.windowEnd || '?'}`);
  lines.push(`  reports: ${summary.reportCount} from ${Object.keys(summary.reporters).join(', ') || '(none)'}`);
  if (summary.policy) {
    lines.push(`  policy:  p=${summary.policy.p} sp=${summary.policy.sp || '(inherits p)'} pct=${summary.policy.pct} adkim=${summary.policy.adkim} aspf=${summary.policy.aspf}`);
  }
  lines.push(`  messages: ${m.total} total, ${m.pass} pass, ${m.fail} fail` + (m.passRate === null ? '' : ` (${(m.passRate * 100).toFixed(2)}% pass)`));
  lines.push(`  auth:    both=${summary.authSplit.both} dkim-only=${summary.authSplit.dkimOnly} spf-only=${summary.authSplit.spfOnly} neither=${summary.authSplit.neither}`);
  lines.push(`  sources: ${summary.sourceCountTotal} distinct IPs (${summary.sources.length} named, ${summary.forwarders.sourceCount} forwarding recipients counted but not named)`);
  if (!summary.findings.length) lines.push('  findings: none');
  for (const f of summary.findings) lines.push(`  [${f.severity}] ${f.code}: ${f.message}`);
  return lines.join('\n');
}

module.exports = {
  DEFAULTS,
  reportKey,
  summarizeReports,
  evaluateFindings,
  classifySource,
  buildPolicyTimeline,
  worstSeverity,
  dmarcHealthResult,
  formatSummary,
};
